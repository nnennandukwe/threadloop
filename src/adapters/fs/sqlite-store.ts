import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import { stateDataSchema, threadloopConfigSchema } from '../../schemas/state.js';
import { sha256 } from '../crypto/sha256.js';
import {
  createAuditEvent,
  type AuditEventType,
  type AuditVerificationErrorCode,
  type StoredAuditEvent,
  verifyAuditChain,
  verifyAuditEventIntegrity,
  ZERO_AUDIT_HASH,
} from '../../domain/audit.js';
import {
  deriveLifecyclePhase,
  evaluateLifecycleTransition,
  isRepairEntryTransition,
  type LifecycleTransitionDecision,
} from '../../domain/lifecycle.js';
import {
  canonicalizeTransitionRequest,
  type CanonicalTransitionRequest,
  type TransitionGuardDecision,
  type TransitionRequest,
  evaluateTransitionGuards,
  readPrePrReviewEvidence,
} from '../../domain/session-transition.js';
import type { BoundProofPlan, GateReceiptPayload, StoredGateReceipt } from '../../domain/proof.js';
import type { ParsedSignedReceiptPackage, StoredSignedGateReceipt } from '../../domain/attestation.js';
import type { VerifiedSigstoreSigner } from '../crypto/sigstore.js';
import type { ParsedSignedReviewReceiptPackage, StoredSignedReviewReceipt } from '../../domain/review.js';
import type {
  Artifact,
  Entry,
  HeartbeatSource,
  Session,
  StateData,
  StoredRepoSnapshot,
  Task,
  TaskStatus,
  ThreadloopConfig,
} from '../../domain/types.js';
import { TASK_STATUS, isTaskStatus } from '../../domain/types.js';
import type { ThreadloopErrorCode } from '../../contracts/errors.js';
import { threadloopPaths } from './repo.js';
import { DatabaseSync } from './sqlite-driver.js';

export const CURRENT_SCHEMA_VERSION = 8;
/**
 * The oldest storage schema this build opens and upgrades. Every earlier schema existed only in development builds
 * (v2 through v6 shipped within one week, before any consumer used ThreadLoop), so their upgrade code is not carried.
 */
export const MIN_SUPPORTED_SCHEMA_VERSION = 7;
const INVALID_CONFIG_ERROR = 'Invalid .threadloop/config.json';
const INVALID_STATE_DB_ERROR = 'Invalid .threadloop/state/state.db';
const SQLITE_BUSY_TIMEOUT_MS = 10_000;

/**
 * Append-only tables. Each gets triggers rejecting UPDATE, DELETE, and an INSERT that would collide with an
 * existing row: `INSERT OR REPLACE` deletes the old row without firing DELETE triggers, so the replace guard is
 * what actually makes these tables immutable.
 */
const IMMUTABLE_TABLES = [
  {
    table: 'session_transitions',
    noun: 'session transitions',
    collision: 'id = NEW.id OR (task_id = NEW.task_id AND to_state_version = NEW.to_state_version)',
  },
  {
    table: 'transition_idempotency',
    noun: 'transition idempotency records',
    collision: 'session_id = NEW.session_id AND idempotency_key = NEW.idempotency_key',
  },
  {
    table: 'transition_idempotency_conflicts',
    noun: 'transition idempotency conflict records',
    collision:
      'id = NEW.id OR (session_id = NEW.session_id AND idempotency_key = NEW.idempotency_key' +
      ' AND request_sha256 = NEW.request_sha256 AND request_json = NEW.request_json)',
  },
  { table: 'proof_plans', noun: 'proof plans', collision: 'session_id = NEW.session_id' },
  { table: 'gate_receipts', noun: 'gate receipts', collision: 'id = NEW.id OR sequence = NEW.sequence' },
  {
    table: 'signed_gate_receipts',
    noun: 'signed gate receipts',
    collision:
      'id = NEW.id OR sequence = NEW.sequence OR (session_id = NEW.session_id AND package_sha256 = NEW.package_sha256)',
  },
  {
    table: 'signed_review_receipts',
    noun: 'signed review receipts',
    collision:
      'id = NEW.id OR sequence = NEW.sequence OR (session_id = NEW.session_id AND package_sha256 = NEW.package_sha256)',
  },
  {
    table: 'audit_events',
    noun: 'audit events',
    collision:
      'id = NEW.id OR (session_id = NEW.session_id AND sequence = NEW.sequence)' +
      ' OR (session_id = NEW.session_id AND event_sha256 = NEW.event_sha256)',
  },
] as const;

/** Sessions whose work is still open. The single source for "active"; nothing reads a stored projection of it. */
const OPEN_SESSIONS = `
  FROM sessions
  INNER JOIN tasks ON tasks.id = sessions.task_id
  WHERE tasks.status <> '${TASK_STATUS.COMPLETED}' AND sessions.ended_at IS NULL
  ORDER BY sessions.rowid
`;

const PROOF_PLAN_SELECT = `
  SELECT
    session_id AS "sessionId", plan_json AS "json", plan_sha256 AS "sha256",
    baseline_branch AS "baselineBranch", baseline_head_sha AS "baselineHeadSha", created_at AS "createdAt"
  FROM proof_plans
  WHERE session_id = ?
`;

const SIGNED_RECEIPT_COLUMNS = [
  'package_path',
  'package_sha256',
  'artifact_json',
  'artifact_sha256',
  'statement_json',
  'statement_sha256',
  'issuer',
  'certificate_identity',
  'build_signer_uri',
  'build_signer_sha',
  'source_repository',
  'source_ref',
  'run_invocation_uri',
  'state_version',
  'verified_at',
] as const;

class InvalidJsonError extends Error {}

type ConnectionState = { writer: DatabaseSync | null; ready: boolean };

type TransitionSessionRow = {
  session_id: string;
  task_id: string;
  ended_at: string | null;
  status: TaskStatus;
  state_version: number;
  blocked_from_state: TaskStatus | null;
};

type SessionTransitionHistoryEntry = {
  id: string;
  from_state: TaskStatus;
  to_state: TaskStatus;
  from_state_version: number;
  to_state_version: number;
  actor: Entry['source'];
  input: Record<string, unknown>;
  created_at: string;
};

type SessionTransitionAuthorityRow = {
  id: string;
  session_id: string;
  task_id: string;
  from_state: string;
  to_state: string;
  from_state_version: number;
  to_state_version: number;
  actor: Entry['source'];
  input_json: string;
  request_sha256: string;
  created_at: string;
};

type AuditEventRow = {
  id: string;
  session_id: string;
  sequence: number;
  event_type: AuditEventType;
  state_version: number;
  previous_sha256: string;
  event_json: string;
  event_sha256: string;
  recorded_at: string;
};

type StoredTransitionError = {
  code: ThreadloopErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

export type SessionTransitionResult =
  | {
      ok: true;
      data: {
        contract_version: 1;
        session_id: string;
        task_id: string;
        idempotency_key: string;
        request_sha256: string;
        transition: {
          id: string;
          from_state: TaskStatus;
          to_state: TaskStatus;
          from_state_version: number;
          to_state_version: number;
          actor: TransitionRequest['actor'];
          input: Record<string, unknown>;
          created_at: string;
        };
        lifecycle: {
          state: TaskStatus;
          state_version: number;
          blocked_from_state: TaskStatus | null;
        };
        session: {
          ended_at: string | null;
        };
        proof_plan?: {
          sha256: string;
          baseline_branch: string;
          baseline_head_sha: string;
        };
      };
    }
  | { ok: false; error: StoredTransitionError };

interface PersistSessionTransitionInput extends TransitionRequest, CanonicalTransitionRequest {
  idempotencyKey: string;
  boundProofPlan?: BoundProofPlan;
  /** From `readSessionEvidenceWatermarkReadOnly`, read before the guard context the evaluator depends on. */
  evidenceWatermark?: string;
}

export interface AppendGateReceiptInput {
  receipt: GateReceiptPayload;
  receiptJson: string;
  receiptSha256: string;
  stateVersion: number;
}

interface AppendSignedPackageInput<TPackage> {
  receipt: TPackage;
  signer: VerifiedSigstoreSigner;
  packagePath: string;
  stateVersion: number;
  verifiedAt: string;
  promotePackage: () => void;
}

export type AppendSignedGateReceiptInput = AppendSignedPackageInput<ParsedSignedReceiptPackage>;
export type AppendSignedReviewReceiptInput = AppendSignedPackageInput<ParsedSignedReviewReceiptPackage>;

export class ReceiptAppendConflictError extends Error {}
export class SignedReceiptAppendConflictError extends Error {}
export class SignedReviewReceiptAppendConflictError extends Error {}

/** Guard evidence changed between evaluation and the write, so the evaluated decision is no longer current. */
export class EvidenceChangedError extends Error {}

/** A persisted evidence row can no longer be read, so nothing can be decided relative to it. */
export class StoredEvidenceCorruptedError extends Error {
  constructor(
    message: string,
    readonly receiptId: string,
  ) {
    super(message);
  }
}

export class AuditLedgerUnavailableError extends Error {
  readonly reason = 'table_missing';

  constructor(readonly schemaVersion: number) {
    super(`Audit storage is unavailable for schema v${schemaVersion}.`);
    this.name = 'AuditLedgerUnavailableError';
  }
}

export class AuditChainCorruptedError extends Error {
  readonly code: AuditVerificationErrorCode;
  readonly sequence?: number;
  readonly sessionId?: string;

  constructor(code: AuditVerificationErrorCode, message: string, sequence?: number, sessionId?: string) {
    super(message);
    this.name = 'AuditChainCorruptedError';
    this.code = code;
    if (sequence !== undefined) {
      this.sequence = sequence;
    }
    if (sessionId !== undefined) {
      this.sessionId = sessionId;
    }
  }
}

export class SessionTransitionHistoryCorruptedError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string, detail: string) {
    super(`Invalid session transition history for ${sessionId}: ${detail}.`);
    this.name = 'SessionTransitionHistoryCorruptedError';
    this.sessionId = sessionId;
  }
}

type TransitionGuardEvaluator = (
  sourceState: TaskStatus,
  targetState: TaskStatus,
  input: Record<string, unknown>,
  blockedFromState: TaskStatus | null,
) => TransitionGuardDecision;

const connections = new Map<string, ConnectionState>();

export function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

/** A supported schema older than current is read as-is but must be upgraded by `threadloop init` before writes. */
export function requiresExplicitInitMigration(schemaVersion: number, currentSchemaVersion = CURRENT_SCHEMA_VERSION) {
  return schemaVersion >= MIN_SUPPORTED_SCHEMA_VERSION && schemaVersion < currentSchemaVersion;
}

export async function ensureThreadloopLayout(repoRoot: string) {
  const paths = threadloopPaths(repoRoot);
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.stateDir, { recursive: true });
  await mkdir(paths.artifactsDir, { recursive: true });
}

export async function ensureStateDatabase(repoRoot: string) {
  await ensureThreadloopLayout(repoRoot);
  const state = connectionState(repoRoot);
  ensureDatabaseReady(writer(repoRoot, state), state);
}

export async function writeConfig(repoRoot: string, config: ThreadloopConfig) {
  const paths = threadloopPaths(repoRoot);
  await ensureThreadloopLayout(repoRoot);
  await mkdir(path.dirname(paths.configPath), { recursive: true });
  await writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export async function readConfig(repoRoot: string): Promise<ThreadloopConfig> {
  const raw = await readFile(threadloopPaths(repoRoot).configPath, 'utf8');
  const parsed = threadloopConfigSchema.safeParse(parseJsonText(raw, INVALID_CONFIG_ERROR));
  if (!parsed.success) {
    throw new Error(INVALID_CONFIG_ERROR);
  }
  return parsed.data;
}

export async function readState(repoRoot: string): Promise<StateData> {
  await ensureStateDatabase(repoRoot);

  return withReadSnapshot(repoRoot, (db) => {
    const parsed = stateDataSchema.safeParse(loadState(db));
    if (!parsed.success) {
      throw new Error(INVALID_STATE_DB_ERROR);
    }
    return parsed.data;
  });
}

export async function readSessionGateContext(repoRoot: string, sessionId: string) {
  await ensureStateDatabase(repoRoot);
  return withReadSnapshot(repoRoot, (db) => {
    const current = readTransitionSession(db, sessionId);
    if (!current) {
      return null;
    }
    const corruption = detectTransitionStateCorruption(current);
    if (corruption) {
      throw new Error(corruption);
    }
    return {
      taskId: current.task_id,
      sessionId: current.session_id,
      state: current.status,
      stateVersion: current.state_version,
      blockedFromState: current.blocked_from_state,
      plan: readProofPlan(db, sessionId),
    };
  });
}

export function readSessionProofEvidenceReadOnly(repoRoot: string, sessionId: string) {
  return withReadSnapshot(repoRoot, (db) => {
    const receipts = db
      .prepare(
        `SELECT ${camelColumns([
          'sequence',
          'id',
          'session_id',
          'gate_id',
          'plan_sha256',
          'head_before',
          'head_after',
          'result',
          'artifact_path',
          'artifact_sha256',
          'receipt_json',
          'receipt_sha256',
          'state_version',
          'created_at',
        ])} FROM gate_receipts WHERE session_id = ? ORDER BY sequence`,
      )
      .all(sessionId) as unknown as StoredGateReceipt[];
    const signedReceipts = db
      .prepare(
        `SELECT ${camelColumns([
          'sequence',
          'id',
          'session_id',
          'gate_id',
          'plan_sha256',
          'subject_head_sha',
          'result',
          ...SIGNED_RECEIPT_COLUMNS,
        ])} FROM signed_gate_receipts WHERE session_id = ? ORDER BY sequence`,
      )
      .all(sessionId) as unknown as StoredSignedGateReceipt[];
    const signedReviewReceipts = db
      .prepare(
        `SELECT ${camelColumns([
          'sequence',
          'id',
          'session_id',
          'plan_sha256',
          'pull_request_number',
          'subject_head_sha',
          ...SIGNED_RECEIPT_COLUMNS,
        ])} FROM signed_review_receipts WHERE session_id = ? ORDER BY sequence`,
      )
      .all(sessionId) as unknown as StoredSignedReviewReceipt[];
    // Repair usage is derived from applied transitions, using the same rule the lifecycle applies.
    const attemptsUsed = readSessionTransitionAuthorityRows(db, sessionId).filter((row) =>
      isRepairEntryTransition(row.from_state as TaskStatus, row.to_state as TaskStatus),
    ).length;
    return {
      plan: readProofPlan(db, sessionId),
      receipts,
      signedReceipts,
      signedReviewReceipts,
      attemptsUsed,
    };
  });
}

export function readSessionAuditReadOnly(repoRoot: string, sessionId: string): StoredAuditEvent[] {
  return withReadSnapshot(repoRoot, (db) => {
    const schemaVersion = assertSupportedSchemaVersion(db);
    if (!tableExists(db, 'audit_events')) {
      throw new AuditLedgerUnavailableError(schemaVersion);
    }
    return readAuditEvents(db, sessionId);
  });
}

export function inspectAuditLedgerReadOnly(repoRoot: string) {
  if (!existsSync(threadloopPaths(repoRoot).stateDbPath)) {
    return { available: false, schemaVersion: null };
  }
  return withReadSnapshot(repoRoot, (db) => {
    if (!tableExists(db, 'metadata')) {
      return { available: false, schemaVersion: null };
    }
    return { available: tableExists(db, 'audit_events'), schemaVersion: readDatabaseSchemaVersion(db) };
  });
}

export function readSessionTransitionHistoryReadOnly(repoRoot: string, sessionId: string) {
  return withReadSnapshot(repoRoot, (db) => {
    assertCanonicalSchemaShape(db);
    return assertSessionTransitionHistoryAuthority(db, sessionId).history;
  });
}

function readSessionTransitionAuthorityRows(db: DatabaseSync, sessionId: string) {
  return db
    .prepare(
      `
        SELECT
          id, session_id, task_id, from_state, to_state, from_state_version, to_state_version,
          actor, input_json, request_sha256, created_at
        FROM session_transitions
        WHERE session_id = ?
        ORDER BY to_state_version, rowid
      `,
    )
    .all(sessionId) as SessionTransitionAuthorityRow[];
}

function assertSessionTransitionHistoryAuthority(db: DatabaseSync, sessionId: string) {
  const rows = readSessionTransitionAuthorityRows(db, sessionId);
  const history: SessionTransitionHistoryEntry[] = [];

  let previous: (typeof rows)[number] | null = null;
  for (const row of rows) {
    if (
      !isTaskStatus(row.from_state) ||
      !isTaskStatus(row.to_state) ||
      !Number.isSafeInteger(row.from_state_version) ||
      row.from_state_version < 0 ||
      row.to_state_version !== row.from_state_version + 1
    ) {
      throw invalidTransitionHistory(sessionId, `transition ${row.id} has invalid lifecycle fields`);
    }
    if (previous && (row.from_state_version !== previous.to_state_version || row.from_state !== previous.to_state)) {
      throw invalidTransitionHistory(sessionId, `transition ${row.id} does not continue the prior transition`);
    }
    const input = parseJsonText<Record<string, unknown>>(row.input_json, INVALID_STATE_DB_ERROR);
    const request = canonicalizeTransitionRequest(
      {
        sessionId,
        targetState: row.to_state,
        expectedStateVersion: row.from_state_version,
        actor: row.actor,
        input,
      },
      sha256,
    );
    if (request.requestSha256 !== row.request_sha256 || JSON.stringify(request.canonicalInput) !== row.input_json) {
      throw invalidTransitionHistory(sessionId, `transition ${row.id} request binding is invalid`);
    }
    history.push({
      id: row.id,
      from_state: row.from_state,
      to_state: row.to_state,
      from_state_version: row.from_state_version,
      to_state_version: row.to_state_version,
      actor: row.actor,
      input: request.canonicalInput,
      created_at: row.created_at,
    });
    previous = row;
  }

  const { auditEvents, auditFloor, genesis, genesisState } = readSessionAuditGenesis(db, sessionId);

  const authoritativeRows = rows.filter((row) => row.from_state_version >= auditFloor);
  const firstAuthoritativeRow = authoritativeRows[0];
  if (
    firstAuthoritativeRow &&
    (firstAuthoritativeRow.from_state_version !== auditFloor || firstAuthoritativeRow.from_state !== genesisState)
  ) {
    throw invalidTransitionHistory(sessionId, 'transition history does not continue from the audit genesis state');
  }
  const rowsById = new Map(authoritativeRows.map((row) => [row.id, row]));
  const appliedEvents = auditEvents.filter(({ value }) => value.event_type === 'transition_applied');
  if (appliedEvents.length !== authoritativeRows.length) {
    throw invalidTransitionHistory(sessionId, 'transition rows do not match authoritative audit coverage');
  }
  for (const { value } of appliedEvents) {
    const transitionId = value.payload.transition_id;
    const row = typeof transitionId === 'string' ? rowsById.get(transitionId) : undefined;
    if (
      !row ||
      value.state_version !== row.to_state_version ||
      value.payload.request_sha256 !== row.request_sha256 ||
      value.payload.from_state !== row.from_state ||
      value.payload.to_state !== row.to_state ||
      value.payload.from_state_version !== row.from_state_version ||
      value.payload.to_state_version !== row.to_state_version
    ) {
      throw invalidTransitionHistory(sessionId, `audit event ${value.id} does not match its transition row`);
    }
  }

  const current = readTransitionSession(db, sessionId);
  if (!current) {
    throw invalidTransitionHistory(sessionId, 'session projection is missing');
  }
  if (
    genesis.event_type === 'session_started' &&
    (genesis.payload.task_id !== current.task_id || genesis.state_version !== 0)
  ) {
    throw invalidTransitionHistory(sessionId, 'session projection does not match the audit genesis task');
  }
  const latest = rows.at(-1);
  if (
    (latest &&
      (latest.task_id !== current.task_id ||
        latest.to_state !== current.status ||
        latest.to_state_version !== current.state_version)) ||
    (!latest && (current.state_version !== auditFloor || current.status !== genesisState))
  ) {
    throw invalidTransitionHistory(sessionId, 'current lifecycle projection does not match transition history');
  }
  if (
    !firstAuthoritativeRow &&
    latest &&
    (latest.to_state_version !== auditFloor || latest.to_state !== genesisState)
  ) {
    throw invalidTransitionHistory(sessionId, 'legacy transition history does not match the audit activation state');
  }
  return { history, genesisState, auditEvents };
}

/**
 * A session's ledger starts with `session_started`, or, for a session that predates the audit ledger, with the
 * `audit_activated` event its schema-v6 upgrade recorded. Those older ledgers still exist and must keep verifying.
 */
function readSessionAuditGenesis(db: DatabaseSync, sessionId: string) {
  const auditEvents = readVerifiedAuditEvents(db, sessionId);
  const genesis = auditEvents[0]?.value;
  const auditFloor =
    genesis?.event_type === 'session_started'
      ? 0
      : genesis?.event_type === 'audit_activated' && genesis.payload.coverage === 'schema_v6_forward'
        ? genesis.state_version
        : null;
  if (!genesis || auditFloor === null) {
    throw invalidTransitionHistory(sessionId, 'audit coverage does not establish a lifecycle history boundary');
  }
  const genesisState =
    genesis.event_type === 'session_started'
      ? genesis.payload.lifecycle_state
      : genesis.payload.lifecycle_state_at_activation;
  if (typeof genesisState !== 'string' || !isTaskStatus(genesisState)) {
    throw invalidTransitionHistory(sessionId, 'audit genesis does not bind a valid lifecycle state');
  }
  return { auditEvents, auditFloor, genesis, genesisState };
}

function invalidTransitionHistory(sessionId: string, detail: string) {
  return new SessionTransitionHistoryCorruptedError(sessionId, detail);
}

function summarizePrePrReview(input: Record<string, unknown>) {
  const review = readPrePrReviewEvidence(input);
  if (!review) {
    throw new Error('Validated pre-PR review evidence could not be summarized.');
  }
  return {
    outcome: review.outcome,
    head_sha: review.headSha,
    evidence_ref: review.evidenceRef,
    evidence_sha256: review.evidenceSha256,
    finding_count: review.findings.length,
    finding_ids: review.findings.map((finding) => finding.id),
  };
}

export function hasSessionTransitionIdempotencyReadOnly(repoRoot: string, sessionId: string, idempotencyKey: string) {
  return withReadSnapshot(repoRoot, (db) => Boolean(readTransitionIdempotency(db, sessionId, idempotencyKey)));
}

/**
 * Identifies the receipt evidence a transition guard was evaluated against. Receipts are append-only and do not
 * bump the lifecycle state version, so the state-version check alone cannot detect evidence that arrived after
 * the guard context was read.
 */
export function readSessionEvidenceWatermarkReadOnly(repoRoot: string, sessionId: string) {
  return withReadSnapshot(repoRoot, (db) => readEvidenceWatermark(db, sessionId));
}

function readEvidenceWatermark(db: DatabaseSync, sessionId: string) {
  const row = db
    .prepare(
      `
        SELECT
          (SELECT coalesce(max(sequence), 0) FROM gate_receipts WHERE session_id = ?) AS gate,
          (SELECT coalesce(max(sequence), 0) FROM signed_gate_receipts WHERE session_id = ?) AS signed_gate,
          (SELECT coalesce(max(sequence), 0) FROM signed_review_receipts WHERE session_id = ?) AS signed_review
      `,
    )
    .get(sessionId, sessionId, sessionId) as { gate: number; signed_gate: number; signed_review: number };
  return `${row.gate}:${row.signed_gate}:${row.signed_review}`;
}

/** Read-only: reports an older supported schema as-is so callers can explain the required migration. */
export function readSessionLifecycleReadOnly(repoRoot: string, sessionId: string) {
  if (!existsSync(threadloopPaths(repoRoot).stateDbPath)) {
    throw new Error('ThreadLoop state database is missing.');
  }

  return withReadSnapshot(repoRoot, (db) => {
    const schemaVersion = assertSupportedSchemaVersion(db);
    assertCanonicalSchemaShape(db);
    const current = readTransitionSession(db, sessionId);
    if (!current) {
      return null;
    }
    const corruption = detectTransitionStateCorruption(current);
    if (corruption) {
      throw new Error(corruption);
    }
    const authority = assertSessionTransitionHistoryAuthority(db, sessionId);

    return {
      taskId: current.task_id,
      sessionId: current.session_id,
      state: current.status,
      stateVersion: current.state_version,
      blockedFromState: current.blocked_from_state,
      endedAt: current.ended_at,
      schemaVersion,
      auditGenesisState: authority.genesisState,
      auditEvents: authority.auditEvents,
      transitionHistory: authority.history,
    };
  });
}

export async function insertTaskSession(
  repoRoot: string,
  payload: { task: Task; session: Session; intentEntry: Entry; initialSnapshot?: StoredRepoSnapshot },
) {
  await withWriteTransaction(repoRoot, (db) => {
    const { task, session, intentEntry } = payload;
    insertTask(db, task);
    insertSession(db, session);
    insertEntry(db, intentEntry);
    if (payload.initialSnapshot) {
      writeRepoSnapshot(db, payload.initialSnapshot);
    }
    appendAuditEvent(db, {
      sessionId: session.id,
      eventType: 'session_started',
      stateVersion: task.stateVersion,
      recordedAt: session.startedAt,
      payload: {
        task_id: task.id,
        lifecycle_state: task.status,
        branch: session.branch,
        head_sha: session.headSha,
      },
    });
    writeActiveProjection(db);
  });
}

export async function applySessionTransition(
  repoRoot: string,
  input: PersistSessionTransitionInput,
  evaluateGuards: TransitionGuardEvaluator = evaluateTransitionGuards,
): Promise<SessionTransitionResult> {
  return withWriteTransaction(repoRoot, (db) => {
    const existing = readTransitionIdempotency(db, input.sessionId, input.idempotencyKey);
    if (existing) {
      assertSessionTransitionHistoryAuthority(db, input.sessionId);
      if (existing.request_sha256 === input.requestSha256 && existing.request_json === input.requestJson) {
        return parseJsonText<SessionTransitionResult>(existing.result_json, INVALID_STATE_DB_ERROR);
      }
      const priorConflict = readTransitionIdempotencyConflict(db, input);
      if (priorConflict) {
        return parseJsonText<SessionTransitionResult>(priorConflict.result_json, INVALID_STATE_DB_ERROR);
      }
      const conflict = failedTransition(
        'IDEMPOTENCY_CONFLICT',
        `Idempotency key ${input.idempotencyKey} is already associated with a different request.`,
        {
          session_id: input.sessionId,
          idempotency_key: input.idempotencyKey,
          request_sha256: input.requestSha256,
          existing_request_sha256: existing.request_sha256,
        },
      );
      const createdAt = new Date().toISOString();
      insertRow(db, 'transition_idempotency_conflicts', {
        session_id: input.sessionId,
        idempotency_key: input.idempotencyKey,
        request_json: input.requestJson,
        request_sha256: input.requestSha256,
        result_json: JSON.stringify(conflict),
        created_at: createdAt,
      });
      appendRejectedGuardDecision(db, input, conflict, createdAt);
      return conflict;
    }

    const current = readTransitionSession(db, input.sessionId);
    if (!current) {
      return failedTransition('SESSION_NOT_FOUND', `Could not find session: ${input.sessionId}`, {
        session_id: input.sessionId,
      });
    }

    const corruption = detectTransitionStateCorruption(current);
    if (corruption) {
      return failedTransition('STATE_CORRUPTED', corruption, {
        session_id: input.sessionId,
        task_id: current.task_id,
      });
    }
    const authority = assertSessionTransitionHistoryAuthority(db, input.sessionId);
    const phase = deriveLifecyclePhase(authority.history, authority.genesisState);

    if (input.expectedStateVersion !== current.state_version) {
      return persistRejectedTransition(
        db,
        input,
        failedTransition(
          'STATE_VERSION_CONFLICT',
          `Expected state version ${input.expectedStateVersion}, but ${input.sessionId} is at version ${current.state_version}.`,
          {
            session_id: input.sessionId,
            expected_state_version: input.expectedStateVersion,
            actual_state: current.status,
            actual_state_version: current.state_version,
            lifecycle_phase: phase,
            unchanged: ['lifecycle', 'repair_budget', 'proof', 'review_evidence'],
            hint: `Run threadloop session next --session ${input.sessionId} --json before retrying.`,
          },
        ),
      );
    }

    const structural: LifecycleTransitionDecision = evaluateLifecycleTransition(current.status, input.targetState, {
      blockedFromState: current.blocked_from_state,
      phase,
    });
    if (!structural.allowed) {
      return persistRejectedTransition(
        db,
        input,
        failedTransition('TRANSITION_NOT_ALLOWED', structural.message, {
          session_id: input.sessionId,
          from_state: current.status,
          target_state: input.targetState,
          actual_state_version: current.state_version,
          lifecycle_phase: phase,
          decision_code: structural.code,
          unchanged: ['lifecycle', 'repair_budget', 'proof', 'review_evidence'],
          recovery: structural.recovery,
        }),
      );
    }

    // Checked before the guards run and before anything is persisted, so the caller can retry the same request
    // and have it evaluated against the evidence that exists now.
    if (
      input.evidenceWatermark !== undefined &&
      readEvidenceWatermark(db, input.sessionId) !== input.evidenceWatermark
    ) {
      throw new EvidenceChangedError(
        `Evidence for ${input.sessionId} changed while the transition was being evaluated.`,
      );
    }

    const guards = evaluateGuards(current.status, input.targetState, input.canonicalInput, current.blocked_from_state);
    if (!guards.allowed) {
      return persistRejectedTransition(
        db,
        input,
        failedTransition(
          'TRANSITION_GUARD_FAILED',
          `Lifecycle transition ${current.status} -> ${input.targetState} is not authorized.`,
          {
            session_id: input.sessionId,
            from_state: current.status,
            target_state: input.targetState,
            actual_state_version: current.state_version,
            lifecycle_phase: phase,
            guard_failures: guards.guardFailures,
            required_work: guards.requiredWork,
            unchanged: ['lifecycle', 'repair_budget', 'proof', 'review_evidence'],
          },
        ),
      );
    }

    if (input.boundProofPlan) {
      if (current.status !== TASK_STATUS.FRAMED || input.targetState !== TASK_STATUS.PROOF_READY) {
        throw new Error('A proof plan can only be persisted during framed -> proof_ready.');
      }
      const plan = input.boundProofPlan;
      insertRow(db, 'proof_plans', {
        session_id: input.sessionId,
        plan_json: plan.json,
        plan_sha256: plan.sha256,
        baseline_branch: plan.baselineBranch,
        baseline_head_sha: plan.baselineHeadSha,
        created_at: plan.createdAt,
      });
    }

    const createdAt = new Date().toISOString();
    const transitionId = createId('transition');
    const nextVersion = current.state_version + 1;
    const blockedFromState = input.targetState === TASK_STATUS.BLOCKED ? current.status : null;
    const update = db
      .prepare(
        `
          UPDATE tasks
          SET status = ?, state_version = ?, blocked_from_state = ?
          WHERE id = ? AND status = ? AND state_version = ?
        `,
      )
      .run(input.targetState, nextVersion, blockedFromState, current.task_id, current.status, current.state_version);
    if (Number(update.changes) !== 1) {
      throw new Error('ThreadLoop transition compare-and-swap did not update exactly one task.');
    }

    const endedAt = input.targetState === TASK_STATUS.COMPLETED ? createdAt : null;
    if (endedAt) {
      const completion = db
        .prepare(`UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL`)
        .run(endedAt, input.sessionId);
      if (Number(completion.changes) !== 1) {
        throw new Error('ThreadLoop transition completion did not update exactly one session.');
      }
      writeActiveProjection(db);
    }

    insertRow(db, 'session_transitions', {
      id: transitionId,
      session_id: input.sessionId,
      task_id: current.task_id,
      from_state: current.status,
      to_state: input.targetState,
      from_state_version: current.state_version,
      to_state_version: nextVersion,
      actor: input.actor,
      input_json: JSON.stringify(input.canonicalInput),
      request_sha256: input.requestSha256,
      created_at: createdAt,
    });

    const result: SessionTransitionResult = {
      ok: true,
      data: {
        contract_version: 1,
        session_id: input.sessionId,
        task_id: current.task_id,
        idempotency_key: input.idempotencyKey,
        request_sha256: input.requestSha256,
        transition: {
          id: transitionId,
          from_state: current.status,
          to_state: input.targetState,
          from_state_version: current.state_version,
          to_state_version: nextVersion,
          actor: input.actor,
          input: input.canonicalInput,
          created_at: createdAt,
        },
        lifecycle: {
          state: input.targetState,
          state_version: nextVersion,
          blocked_from_state: blockedFromState,
        },
        session: {
          ended_at: endedAt,
        },
        ...(input.boundProofPlan
          ? {
              proof_plan: {
                sha256: input.boundProofPlan.sha256,
                baseline_branch: input.boundProofPlan.baselineBranch,
                baseline_head_sha: input.boundProofPlan.baselineHeadSha,
              },
            }
          : {}),
      },
    };
    persistTransitionIdempotency(db, input, 'applied', transitionId, result, createdAt);
    appendAuditEvent(db, {
      sessionId: input.sessionId,
      eventType: 'guard_decision',
      stateVersion: current.state_version,
      recordedAt: createdAt,
      payload: {
        idempotency_key: input.idempotencyKey,
        request_sha256: input.requestSha256,
        from_state: current.status,
        target_state: input.targetState,
        allowed: true,
        guard_failures: [],
      },
    });
    appendAuditEvent(db, {
      sessionId: input.sessionId,
      eventType: 'transition_applied',
      stateVersion: nextVersion,
      recordedAt: createdAt,
      payload: {
        transition_id: transitionId,
        request_sha256: input.requestSha256,
        from_state: current.status,
        to_state: input.targetState,
        from_state_version: current.state_version,
        to_state_version: nextVersion,
        ...(readPrePrReviewEvidence(input.canonicalInput)
          ? {
              pre_pr_review: summarizePrePrReview(input.canonicalInput),
            }
          : {}),
      },
    });
    return result;
  });
}

export async function appendGateReceipt(repoRoot: string, input: AppendGateReceiptInput) {
  return withWriteTransaction(repoRoot, (db) => {
    const receipt = input.receipt;
    assertEvidenceAppendContext(db, {
      sessionId: receipt.session_id,
      planSha256: receipt.plan_sha256,
      stateVersion: input.stateVersion,
      states: [TASK_STATUS.VERIFYING],
      activity: `gate ${receipt.gate_id} was running`,
      conflict: ReceiptAppendConflictError,
    });
    const inserted = insertRow(db, 'gate_receipts', {
      id: receipt.id,
      session_id: receipt.session_id,
      gate_id: receipt.gate_id,
      plan_sha256: receipt.plan_sha256,
      head_before: receipt.head_before,
      head_after: receipt.head_after,
      result: receipt.result,
      artifact_path: receipt.artifact.path,
      artifact_sha256: receipt.artifact.sha256,
      receipt_json: input.receiptJson,
      receipt_sha256: input.receiptSha256,
      state_version: input.stateVersion,
      created_at: receipt.ended_at,
    });
    appendAuditEvent(db, {
      sessionId: receipt.session_id,
      eventType: 'proof_receipt_recorded',
      stateVersion: input.stateVersion,
      recordedAt: receipt.ended_at,
      payload: {
        receipt_id: receipt.id,
        gate_id: receipt.gate_id,
        receipt_sha256: input.receiptSha256,
        result: receipt.result,
        head_sha: receipt.head_after,
      },
    });
    return Number(inserted.lastInsertRowid);
  });
}

export async function appendSignedGateReceipt(repoRoot: string, input: AppendSignedGateReceiptInput) {
  const artifact = input.receipt.artifact;
  return appendSignedPackage(repoRoot, input, {
    table: 'signed_gate_receipts',
    label: 'Signed receipt',
    states: [TASK_STATUS.VERIFYING],
    activity: `signed gate ${artifact.gate.id} was being imported`,
    conflict: SignedReceiptAppendConflictError,
    columns: {
      gate_id: artifact.gate.id,
      subject_head_sha: artifact.source.head_sha,
      result: 'passed',
    },
    auditEvent: 'signed_proof_receipt_imported',
    auditPayload: {
      receipt_id: artifact.receipt_id,
      gate_id: artifact.gate.id,
      package_sha256: input.receipt.packageSha256,
      subject_head_sha: artifact.source.head_sha,
    },
  });
}

export async function appendSignedReviewReceipt(repoRoot: string, input: AppendSignedReviewReceiptInput) {
  const artifact = input.receipt.artifact;
  return appendSignedPackage(repoRoot, input, {
    table: 'signed_review_receipts',
    label: 'Signed review receipt',
    states: [TASK_STATUS.REVIEWING, TASK_STATUS.READY_FOR_HUMAN],
    activity: 'review evidence was being imported',
    conflict: SignedReviewReceiptAppendConflictError,
    columns: {
      pull_request_number: artifact.pull_request.number,
      subject_head_sha: artifact.pull_request.head_sha,
    },
    beforeInsert: (db) => assertReviewSnapshotAdvances(db, artifact),
    auditEvent: 'signed_review_receipt_imported',
    auditPayload: {
      receipt_id: artifact.receipt_id,
      package_sha256: input.receipt.packageSha256,
      pull_request_number: artifact.pull_request.number,
      subject_head_sha: artifact.pull_request.head_sha,
      merged: artifact.pull_request.merged,
    },
  });
}

/**
 * Appends one verified signed package. An identical package is idempotent; any other package reusing the receipt
 * id, or the same bytes under another id, is a conflict. The package file is promoted only inside the same
 * transaction, after every check has passed.
 */
function appendSignedPackage<TPackage extends ParsedSignedReceiptPackage | ParsedSignedReviewReceiptPackage>(
  repoRoot: string,
  input: AppendSignedPackageInput<TPackage>,
  spec: {
    table: 'signed_gate_receipts' | 'signed_review_receipts';
    label: string;
    states: readonly TaskStatus[];
    activity: string;
    conflict: new (message: string) => Error;
    columns: Record<string, SQLInputValue>;
    beforeInsert?: (db: DatabaseSync) => void;
    auditEvent: AuditEventType;
    auditPayload: Record<string, unknown>;
  },
) {
  return withWriteTransaction(repoRoot, (db) => {
    const artifact = input.receipt.artifact;
    const existing = db
      .prepare(
        `
          SELECT sequence, id, session_id, package_sha256, verified_at
          FROM ${spec.table}
          WHERE id = ? OR (session_id = ? AND package_sha256 = ?)
          ORDER BY sequence
          LIMIT 1
        `,
      )
      .get(artifact.receipt_id, artifact.session_id, input.receipt.packageSha256) as
      { sequence: number; id: string; session_id: string; package_sha256: string; verified_at: string } | undefined;
    if (existing) {
      if (
        existing.id === artifact.receipt_id &&
        existing.session_id === artifact.session_id &&
        existing.package_sha256 === input.receipt.packageSha256
      ) {
        return { sequence: existing.sequence, alreadyImported: true, verifiedAt: existing.verified_at };
      }
      throw new spec.conflict(`${spec.label} ${artifact.receipt_id} conflicts with previously imported content.`);
    }

    assertEvidenceAppendContext(db, {
      sessionId: artifact.session_id,
      planSha256: artifact.plan_sha256,
      stateVersion: input.stateVersion,
      states: spec.states,
      activity: spec.activity,
      conflict: spec.conflict,
    });
    spec.beforeInsert?.(db);

    const inserted = insertRow(db, spec.table, {
      id: artifact.receipt_id,
      session_id: artifact.session_id,
      plan_sha256: artifact.plan_sha256,
      ...spec.columns,
      package_path: input.packagePath,
      package_sha256: input.receipt.packageSha256,
      artifact_json: input.receipt.artifactJson,
      artifact_sha256: input.receipt.artifactSha256,
      statement_json: input.receipt.statementJson,
      statement_sha256: input.receipt.statementSha256,
      issuer: input.signer.issuer,
      certificate_identity: input.signer.certificateIdentity,
      build_signer_uri: input.signer.buildSignerUri,
      build_signer_sha: input.signer.buildSignerSha,
      source_repository: input.signer.sourceRepository,
      source_ref: input.signer.sourceRef,
      run_invocation_uri: input.signer.runInvocationUri,
      state_version: input.stateVersion,
      verified_at: input.verifiedAt,
    });
    appendAuditEvent(db, {
      sessionId: artifact.session_id,
      eventType: spec.auditEvent,
      stateVersion: input.stateVersion,
      recordedAt: input.verifiedAt,
      payload: spec.auditPayload,
    });
    input.promotePackage();
    return { sequence: Number(inserted.lastInsertRowid), alreadyImported: false, verifiedAt: input.verifiedAt };
  });
}

/** Evidence may only be appended for the lifecycle state and proof plan it was produced against. */
function assertEvidenceAppendContext(
  db: DatabaseSync,
  input: {
    sessionId: string;
    planSha256: string;
    stateVersion: number;
    states: readonly TaskStatus[];
    activity: string;
    conflict: new (message: string) => Error;
  },
) {
  const current = readTransitionSession(db, input.sessionId);
  if (!current) {
    throw new input.conflict(`Could not find session: ${input.sessionId}`);
  }
  if (!input.states.includes(current.status) || current.state_version !== input.stateVersion) {
    throw new input.conflict(`Session ${input.sessionId} changed while ${input.activity}.`);
  }
  if (readProofPlan(db, input.sessionId)?.sha256 !== input.planSha256) {
    throw new input.conflict(`Session ${input.sessionId} proof plan changed while ${input.activity}.`);
  }
  assertSessionTransitionHistoryAuthority(db, input.sessionId);
}

/**
 * The newest imported review snapshot is authoritative, so a snapshot may only be imported if it is at least as
 * new as every snapshot already imported for the session and describes the same pull request. Otherwise an
 * older signed approval could be re-imported after a newer blocking review and hide it.
 */
function assertReviewSnapshotAdvances(db: DatabaseSync, artifact: ParsedSignedReviewReceiptPackage['artifact']) {
  const observedAt = Date.parse(artifact.observed_at);
  const prior = db
    .prepare(`SELECT id, pull_request_number, artifact_json FROM signed_review_receipts WHERE session_id = ?`)
    .all(artifact.session_id) as Array<{ id: string; pull_request_number: number; artifact_json: string }>;
  for (const snapshot of prior) {
    if (snapshot.pull_request_number !== artifact.pull_request.number) {
      throw new SignedReviewReceiptAppendConflictError(
        `Session ${artifact.session_id} review evidence describes pull request #${snapshot.pull_request_number}; ` +
          `receipt ${artifact.receipt_id} describes #${artifact.pull_request.number}.`,
      );
    }
    const priorObservedAt = readStoredObservedAt(snapshot.artifact_json);
    if (priorObservedAt === null) {
      throw new StoredEvidenceCorruptedError(
        `Stored review receipt ${snapshot.id} has no readable observation time.`,
        snapshot.id,
      );
    }
    if (observedAt < priorObservedAt) {
      throw new SignedReviewReceiptAppendConflictError(
        `Review receipt ${artifact.receipt_id} was observed before already-imported review receipt ${snapshot.id}. ` +
          'Import a review snapshot observed after it.',
      );
    }
  }
}

function readStoredObservedAt(artifactJson: string) {
  let artifact: unknown;
  try {
    artifact = JSON.parse(artifactJson);
  } catch {
    return null;
  }
  const observedAt =
    typeof artifact === 'object' && artifact !== null ? (artifact as { observed_at?: unknown }).observed_at : undefined;
  const parsed = typeof observedAt === 'string' ? Date.parse(observedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export async function appendEntryToSession(repoRoot: string, sessionId: string, draft: Omit<Entry, 'sessionId'>) {
  return withWriteTransaction(repoRoot, (db) => {
    if (!readSessionExists(db, sessionId)) {
      throw new Error(`Unknown session id: ${sessionId}`);
    }
    const entry: Entry = { ...draft, sessionId };
    insertEntry(db, entry);
    return entry;
  });
}

export async function recordArtifact(repoRoot: string, artifact: Artifact) {
  await withWriteTransaction(repoRoot, (db) => {
    insertRow(db, 'artifacts', {
      id: artifact.id,
      session_id: artifact.sessionId,
      kind: artifact.kind,
      path: artifact.path,
      template_version: artifact.templateVersion,
      generated_at: artifact.generatedAt,
      snapshot_source: artifact.snapshotSource ?? null,
    });
  });
}

export async function recordSessionHeartbeat(
  repoRoot: string,
  payload: { sessionId: string; branch: string; headSha: string; lastHeartbeatAt: string; source: HeartbeatSource },
) {
  await withWriteTransaction(repoRoot, (db) => {
    const updated = db
      .prepare(
        `UPDATE sessions SET branch = ?, head_sha = ?, last_heartbeat_at = ?, last_heartbeat_source = ? WHERE id = ?`,
      )
      .run(payload.branch, payload.headSha, payload.lastHeartbeatAt, payload.source, payload.sessionId);
    if (Number(updated.changes) !== 1) {
      throw new Error(`Unknown session id: ${payload.sessionId}`);
    }
  });
}

export async function writeArtifactFile(repoRoot: string, filename: string, content: string) {
  const paths = threadloopPaths(repoRoot);
  await mkdir(paths.artifactsDir, { recursive: true });
  const fullPath = path.join(paths.artifactsDir, filename);
  await writeFile(fullPath, content, 'utf8');
  return fullPath;
}

export async function upsertRepoSnapshot(repoRoot: string, snapshot: StoredRepoSnapshot) {
  await withWriteTransaction(repoRoot, (db) => {
    writeRepoSnapshot(db, snapshot);
  });
}

export async function readRepoSnapshot(repoRoot: string, sessionId: string): Promise<StoredRepoSnapshot | null> {
  await ensureStateDatabase(repoRoot);

  return withReadSnapshot(repoRoot, (db) => {
    const row = db
      .prepare(
        `
          SELECT
            session_id AS "sessionId", branch, head_sha AS "headSha", base_ref AS "baseRef",
            changed_files_json, diff_stats_json, commit_range_json, reconciled_at AS "reconciledAt"
          FROM repo_snapshots
          WHERE session_id = ?
        `,
      )
      .get(sessionId) as
      | (Pick<StoredRepoSnapshot, 'sessionId' | 'branch' | 'headSha' | 'baseRef' | 'reconciledAt'> & {
          changed_files_json: string;
          diff_stats_json: string;
          commit_range_json: string;
        })
      | undefined;
    if (!row) {
      return null;
    }
    const { changed_files_json, diff_stats_json, commit_range_json, ...snapshot } = row;
    return {
      ...snapshot,
      changedFiles: parseJsonText<string[]>(changed_files_json, INVALID_STATE_DB_ERROR),
      diffStats: parseJsonText<StoredRepoSnapshot['diffStats']>(diff_stats_json, INVALID_STATE_DB_ERROR),
      commitRange: parseJsonText<string[]>(commit_range_json, INVALID_STATE_DB_ERROR),
    };
  });
}

export function closeSqliteConnections(repoRoot?: string) {
  for (const currentRepoRoot of repoRoot ? [repoRoot] : Array.from(connections.keys())) {
    connections.get(currentRepoRoot)?.writer?.close();
    connections.delete(currentRepoRoot);
  }
}

/**
 * Runs every read in `action` against a single database snapshot.
 *
 * Without an enclosing transaction each prepared statement gets its own implicit
 * read snapshot, so a concurrent writer committing between two statements is
 * visible to the later one but not the earlier one. Projections cross-checked
 * against history then disagree, and a fail-closed reader reports that torn read
 * as `STATE_CORRUPTED` even though nothing on disk is inconsistent. WAL keeps a
 * deferred read transaction from blocking writers.
 *
 * Exported so `tests/unit/read-snapshot.test.ts` can assert the isolation
 * directly; production callers should use it through the `*ReadOnly` functions.
 */
export function withReadSnapshot<T>(repoRoot: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(threadloopPaths(repoRoot).stateDbPath, { readOnly: true });
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);

  try {
    return runInTransaction(db, 'BEGIN DEFERRED', () => action(db));
  } finally {
    db.close();
  }
}

function connectionState(repoRoot: string) {
  let state = connections.get(repoRoot);
  if (!state) {
    state = { writer: null, ready: false };
    connections.set(repoRoot, state);
  }
  return state;
}

function writer(repoRoot: string, state: ConnectionState) {
  if (!state.writer) {
    state.writer = new DatabaseSync(threadloopPaths(repoRoot).stateDbPath, { enableForeignKeyConstraints: true });
    state.writer.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  }
  return state.writer;
}

/**
 * node:sqlite is synchronous and `action` is synchronous, so a write transaction runs to completion without
 * yielding; writes from one process cannot interleave, and IMMEDIATE serializes them against other processes.
 */
async function withWriteTransaction<T>(repoRoot: string, action: (db: DatabaseSync) => T): Promise<T> {
  await ensureThreadloopLayout(repoRoot);
  const state = connectionState(repoRoot);
  const db = writer(repoRoot, state);
  ensureDatabaseReady(db, state);
  return runInTransaction(db, 'BEGIN IMMEDIATE', () => action(db));
}

/**
 * Brings the database to the current schema once per process, then only re-checks the schema version. A newer
 * schema is rejected before anything is changed, including the journal mode.
 */
function ensureDatabaseReady(db: DatabaseSync, state: ConnectionState) {
  if (state.ready) {
    assertCurrentSchemaVersion(db);
    return;
  }

  if (tableExists(db, 'metadata')) {
    assertSupportedSchemaVersion(db);
  }
  if (!databaseNeedsSetup(db)) {
    state.ready = true;
    return;
  }

  db.exec('PRAGMA journal_mode = WAL');
  runInTransaction(db, 'BEGIN IMMEDIATE', () => {
    // Detaches a v7 gate_receipts so bootstrapDatabase can recreate it with the widened result domain from the
    // one authoritative DDL; rows are copied back immediately after.
    const legacyResultDomain = detachLegacyGateReceiptResultDomain(db);
    bootstrapDatabase(db);
    restoreLegacyGateReceipts(db, legacyResultDomain);
    assertSupportedSchemaVersion(db);
    assertCanonicalSchemaShape(db);
    for (const { id } of db.prepare(`SELECT id FROM sessions ORDER BY id`).all() as Array<{ id: string }>) {
      assertSessionTransitionHistoryAuthority(db, id);
    }
    writeActiveProjection(db);
    db.prepare(
      `INSERT INTO metadata (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(CURRENT_SCHEMA_VERSION));
  });
  assertCurrentSchemaVersion(db);
  state.ready = true;
}

function databaseNeedsSetup(db: DatabaseSync) {
  return (
    !tableExists(db, 'metadata') ||
    readDatabaseSchemaVersion(db) !== CURRENT_SCHEMA_VERSION ||
    schemaShapeProblem(db) !== null
  );
}

function tableExists(db: DatabaseSync, tableName: string) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName));
}

function bootstrapDatabase(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      constraints_json TEXT NOT NULL,
      issue_ref TEXT,
      repo_root TEXT NOT NULL,
      status TEXT NOT NULL,
      state_version INTEGER NOT NULL DEFAULT 0,
      blocked_from_state TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      base_ref TEXT,
      branch TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      last_heartbeat_at TEXT,
      last_heartbeat_source TEXT
    );

    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      source TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      template_version TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      snapshot_source TEXT
    );

    CREATE TABLE IF NOT EXISTS active_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS active_sessions (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS sessions_task_id_idx ON sessions(task_id);
    CREATE INDEX IF NOT EXISTS entries_session_id_idx ON entries(session_id);
    CREATE INDEX IF NOT EXISTS artifacts_session_id_idx ON artifacts(session_id);
    CREATE INDEX IF NOT EXISTS active_sessions_task_id_idx ON active_sessions(task_id);

    CREATE TABLE IF NOT EXISTS repo_snapshots (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      branch TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      base_ref TEXT,
      changed_files_json TEXT NOT NULL,
      diff_stats_json TEXT NOT NULL,
      commit_range_json TEXT NOT NULL,
      reconciled_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_transitions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      task_id TEXT NOT NULL REFERENCES tasks(id),
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      from_state_version INTEGER NOT NULL,
      to_state_version INTEGER NOT NULL,
      actor TEXT NOT NULL,
      input_json TEXT NOT NULL,
      request_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(task_id, to_state_version)
    );

    CREATE TABLE IF NOT EXISTS transition_idempotency (
      session_id TEXT NOT NULL REFERENCES sessions(id),
      idempotency_key TEXT NOT NULL,
      request_json TEXT NOT NULL,
      request_sha256 TEXT NOT NULL,
      outcome TEXT NOT NULL,
      transition_id TEXT REFERENCES session_transitions(id),
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(session_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS transition_idempotency_conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      idempotency_key TEXT NOT NULL,
      request_json TEXT NOT NULL,
      request_sha256 TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, idempotency_key, request_sha256, request_json)
    );

    CREATE INDEX IF NOT EXISTS transition_idempotency_conflicts_lookup_idx
      ON transition_idempotency_conflicts(session_id, idempotency_key, request_sha256);

    CREATE TABLE IF NOT EXISTS proof_plans (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id),
      plan_json TEXT NOT NULL,
      plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256) = 64),
      baseline_branch TEXT NOT NULL,
      baseline_head_sha TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gate_receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      gate_id TEXT NOT NULL,
      plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256) = 64),
      head_before TEXT NOT NULL,
      head_after TEXT NOT NULL,
      result TEXT NOT NULL CHECK(
        result IN (
          'passed', 'failed', 'timed_out', 'aborted', 'invalidated',
          'execution_error', 'cleanup_failed', 'setup_failed'
        )
      ),
      artifact_path TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL CHECK(length(artifact_sha256) = 64),
      receipt_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256) = 64),
      state_version INTEGER NOT NULL CHECK(state_version >= 0),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS gate_receipts_session_gate_sequence_idx
      ON gate_receipts(session_id, gate_id, sequence DESC);

    CREATE TABLE IF NOT EXISTS signed_gate_receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      gate_id TEXT NOT NULL,
      plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256) = 64),
      subject_head_sha TEXT NOT NULL CHECK(length(subject_head_sha) = 40),
      result TEXT NOT NULL CHECK(result = 'passed'),
      package_path TEXT NOT NULL,
      package_sha256 TEXT NOT NULL CHECK(length(package_sha256) = 64),
      artifact_json TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL CHECK(length(artifact_sha256) = 64),
      statement_json TEXT NOT NULL,
      statement_sha256 TEXT NOT NULL CHECK(length(statement_sha256) = 64),
      issuer TEXT NOT NULL,
      certificate_identity TEXT NOT NULL,
      build_signer_uri TEXT NOT NULL,
      build_signer_sha TEXT NOT NULL CHECK(length(build_signer_sha) = 40),
      source_repository TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      run_invocation_uri TEXT NOT NULL,
      state_version INTEGER NOT NULL CHECK(state_version >= 0),
      verified_at TEXT NOT NULL,
      UNIQUE(session_id, package_sha256)
    );

    CREATE INDEX IF NOT EXISTS signed_gate_receipts_session_gate_sequence_idx
      ON signed_gate_receipts(session_id, gate_id, sequence DESC);

    CREATE TABLE IF NOT EXISTS signed_review_receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256) = 64),
      pull_request_number INTEGER NOT NULL CHECK(pull_request_number > 0),
      subject_head_sha TEXT NOT NULL CHECK(length(subject_head_sha) = 40),
      package_path TEXT NOT NULL,
      package_sha256 TEXT NOT NULL CHECK(length(package_sha256) = 64),
      artifact_json TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL CHECK(length(artifact_sha256) = 64),
      statement_json TEXT NOT NULL,
      statement_sha256 TEXT NOT NULL CHECK(length(statement_sha256) = 64),
      issuer TEXT NOT NULL,
      certificate_identity TEXT NOT NULL,
      build_signer_uri TEXT NOT NULL,
      build_signer_sha TEXT NOT NULL CHECK(length(build_signer_sha) = 40),
      source_repository TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      run_invocation_uri TEXT NOT NULL,
      state_version INTEGER NOT NULL CHECK(state_version >= 0),
      verified_at TEXT NOT NULL,
      UNIQUE(session_id, package_sha256)
    );

    CREATE INDEX IF NOT EXISTS signed_review_receipts_session_sequence_idx
      ON signed_review_receipts(session_id, sequence DESC);

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      sequence INTEGER NOT NULL CHECK(sequence > 0),
      event_type TEXT NOT NULL,
      state_version INTEGER NOT NULL CHECK(state_version >= 0),
      previous_sha256 TEXT NOT NULL CHECK(length(previous_sha256) = 64),
      event_json TEXT NOT NULL,
      event_sha256 TEXT NOT NULL CHECK(length(event_sha256) = 64),
      recorded_at TEXT NOT NULL,
      UNIQUE(session_id, sequence),
      UNIQUE(session_id, event_sha256)
    );

    CREATE INDEX IF NOT EXISTS audit_events_session_sequence_idx
      ON audit_events(session_id, sequence);

    ${IMMUTABLE_TABLES.map(immutableTableTriggers).join('\n')}
  `);

  db.prepare(`INSERT INTO metadata (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO NOTHING`).run(
    String(CURRENT_SCHEMA_VERSION),
  );
}

function immutableTableTriggers({ table, noun, collision }: (typeof IMMUTABLE_TABLES)[number]) {
  const reject = `BEGIN SELECT RAISE(ABORT, '${noun} are immutable'); END;`;
  return `
    CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} ${reject}
    CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} ${reject}
    CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table}
    WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${collision}) ${reject}
  `;
}

let canonicalShape: { columns: Map<string, Set<string>>; triggers: Set<string> } | undefined;

function readSchemaShape(db: DatabaseSync) {
  const objects = db
    .prepare(`SELECT type, name FROM sqlite_master WHERE type IN ('table', 'trigger') AND name NOT LIKE 'sqlite_%'`)
    .all() as Array<{ type: 'table' | 'trigger'; name: string }>;
  const columns = new Map<string, Set<string>>();
  for (const { name } of objects.filter((object) => object.type === 'table')) {
    const info = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
    columns.set(name, new Set(info.map((column) => column.name)));
  }
  return { columns, triggers: new Set(objects.filter((object) => object.type === 'trigger').map(({ name }) => name)) };
}

/**
 * Compares the database against the shape this build creates: every table, column, and immutability trigger the
 * code depends on. The expectation is derived from the DDL itself, so it cannot drift from it.
 */
function schemaShapeProblem(db: DatabaseSync) {
  if (!canonicalShape) {
    const reference = new DatabaseSync(':memory:');
    try {
      bootstrapDatabase(reference);
      canonicalShape = readSchemaShape(reference);
    } finally {
      reference.close();
    }
  }
  const actual = readSchemaShape(db);
  for (const [table, columns] of canonicalShape.columns) {
    const actualColumns = actual.columns.get(table);
    if (!actualColumns || [...columns].some((column) => !actualColumns.has(column))) {
      return `Invalid schema for ${table}`;
    }
  }
  for (const trigger of canonicalShape.triggers) {
    if (!actual.triggers.has(trigger)) {
      return `Invalid schema for ${trigger.replace(/_no_(update|delete|replace)$/, '')}: missing trigger ${trigger}`;
    }
  }
  return null;
}

function assertCanonicalSchemaShape(db: DatabaseSync) {
  const problem = schemaShapeProblem(db);
  if (problem) {
    throw new Error(problem);
  }
}

function readDatabaseSchemaVersion(db: DatabaseSync) {
  if (!tableExists(db, 'metadata')) {
    throw new Error('Missing ThreadLoop schema version metadata.');
  }
  const row = db.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get() as
    { value: string } | undefined;
  if (!row) {
    throw new Error('Missing ThreadLoop schema version metadata.');
  }
  if (!/^[1-9][0-9]*$/.test(row.value) || !Number.isSafeInteger(Number(row.value))) {
    throw new Error(`Unsupported ThreadLoop schema version: ${row.value}`);
  }
  return Number(row.value);
}

function assertSupportedSchemaVersion(db: DatabaseSync) {
  const version = readDatabaseSchemaVersion(db);
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported ThreadLoop schema version: ${version}`);
  }
  if (version < MIN_SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported ThreadLoop schema version: ${version}. This build upgrades schema v${MIN_SUPPORTED_SCHEMA_VERSION} ` +
        'and newer; open the database with the development build that created it to upgrade it first.',
    );
  }
  return version;
}

function assertCurrentSchemaVersion(db: DatabaseSync) {
  const version = readDatabaseSchemaVersion(db);
  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported ThreadLoop schema version: ${version}`);
  }
}

const LEGACY_GATE_RECEIPTS_TABLE = 'gate_receipts_pre_setup_result_domain';

/**
 * Schema v8 widened the gate_receipts result domain to admit `setup_failed`. SQLite cannot alter a CHECK
 * constraint, so the table has to be rebuilt. Rather than duplicate the table DDL here and risk it drifting
 * from bootstrapDatabase, this renames the old table out of the way and lets bootstrapDatabase create the
 * current one; restoreLegacyGateReceipts then copies the rows back.
 *
 * Returns whether a legacy table was detached. Idempotent: a table that already admits `setup_failed`, or a
 * database with no gate_receipts at all, is left untouched.
 */
function detachLegacyGateReceiptResultDomain(db: DatabaseSync) {
  const definition = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'gate_receipts'`)
    .get() as { sql: string } | undefined;
  if (!definition?.sql || definition.sql.includes('setup_failed')) {
    return false;
  }
  if (tableExists(db, LEGACY_GATE_RECEIPTS_TABLE)) {
    throw new Error(`A previous gate-receipt migration left ${LEGACY_GATE_RECEIPTS_TABLE} behind.`);
  }

  // The append-only triggers and the covering index carry the table name, so they must go before the rename;
  // bootstrapDatabase recreates all of them against the rebuilt table.
  for (const suffix of ['no_update', 'no_delete', 'no_replace']) {
    db.exec(`DROP TRIGGER IF EXISTS gate_receipts_${suffix}`);
  }
  db.exec(`DROP INDEX IF EXISTS gate_receipts_session_gate_sequence_idx`);
  db.exec(`ALTER TABLE gate_receipts RENAME TO ${LEGACY_GATE_RECEIPTS_TABLE}`);
  return true;
}

function restoreLegacyGateReceipts(db: DatabaseSync, detached: boolean) {
  if (!detached) {
    return;
  }
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  const expected = count(LEGACY_GATE_RECEIPTS_TABLE);
  // Explicit sequence values preserve receipt ordering, which the proof projection depends on.
  const columns = `sequence, id, session_id, gate_id, plan_sha256, head_before, head_after, result,
    artifact_path, artifact_sha256, receipt_json, receipt_sha256, state_version, created_at`;
  db.exec(
    `INSERT INTO gate_receipts (${columns}) SELECT ${columns} FROM ${LEGACY_GATE_RECEIPTS_TABLE} ORDER BY sequence`,
  );
  const copied = count('gate_receipts');
  if (copied !== expected) {
    throw new Error(`Gate-receipt migration copied ${copied} of ${expected} receipts.`);
  }
  db.exec(`DROP TABLE ${LEGACY_GATE_RECEIPTS_TABLE}`);
}

function loadState(db: DatabaseSync): StateData {
  const tasks = (
    db
      .prepare(
        `
          SELECT
            id, title, goal, constraints_json, issue_ref AS "issueRef", repo_root AS "repoRoot", status,
            state_version AS "stateVersion", blocked_from_state AS "blockedFromState", created_at AS "createdAt"
          FROM tasks
          ORDER BY rowid
        `,
      )
      .all() as Array<Omit<Task, 'constraints'> & { constraints_json: string }>
  ).map(({ constraints_json, ...task }) => ({
    ...task,
    constraints: parseJsonText<string[]>(constraints_json, INVALID_STATE_DB_ERROR),
  }));
  const sessions = db
    .prepare(
      `
        SELECT
          id, task_id AS "taskId", started_at AS "startedAt", ended_at AS "endedAt", base_ref AS "baseRef", branch,
          head_sha AS "headSha", last_heartbeat_at AS "lastHeartbeatAt", last_heartbeat_source AS "lastHeartbeatSource"
        FROM sessions
        ORDER BY rowid
      `,
    )
    .all() as unknown as Session[];
  const entries = (
    db
      .prepare(
        `
          SELECT id, session_id AS "sessionId", kind, body, metadata_json, created_at AS "createdAt", source
          FROM entries
          ORDER BY rowid
        `,
      )
      .all() as Array<Omit<Entry, 'metadata'> & { metadata_json: string }>
  ).map(({ metadata_json, ...entry }) => ({
    ...entry,
    metadata: parseJsonText<Record<string, unknown>>(metadata_json, INVALID_STATE_DB_ERROR),
  }));
  const artifacts = db
    .prepare(
      `
        SELECT
          id, session_id AS "sessionId", kind, path, template_version AS "templateVersion",
          generated_at AS "generatedAt"
        FROM artifacts
        ORDER BY rowid
      `,
    )
    .all() as unknown as Artifact[];
  const activeSessions = db
    .prepare(`SELECT sessions.task_id AS "taskId", sessions.id AS "sessionId" ${OPEN_SESSIONS}`)
    .all() as unknown as StateData['activeSessions'];

  return { tasks, sessions, entries, artifacts, activeSessions };
}

/**
 * `active_sessions` and `active_state` are a stored projection of OPEN_SESSIONS. Nothing reads them; they
 * are rewritten whenever the set of open sessions can change so the stored data matches what earlier builds of
 * this schema expect.
 */
function writeActiveProjection(db: DatabaseSync) {
  db.exec(`
    DELETE FROM active_sessions;
    DELETE FROM active_state;
    INSERT INTO active_sessions (session_id, task_id) SELECT sessions.id, sessions.task_id ${OPEN_SESSIONS};
    INSERT INTO active_state (id, task_id, session_id)
    SELECT 1, task_id, session_id FROM active_sessions WHERE (SELECT COUNT(*) FROM active_sessions) = 1;
  `);
}

function readProofPlan(db: DatabaseSync, sessionId: string) {
  return (db.prepare(PROOF_PLAN_SELECT).get(sessionId) as unknown as BoundProofPlanRow | undefined) ?? null;
}

type BoundProofPlanRow = {
  sessionId: string;
  json: string;
  sha256: string;
  baselineBranch: string;
  baselineHeadSha: string;
  createdAt: string;
};

function readSessionExists(db: DatabaseSync, sessionId: string) {
  return Boolean(db.prepare(`SELECT 1 FROM sessions WHERE id = ?`).get(sessionId));
}

function readTransitionSession(db: DatabaseSync, sessionId: string) {
  return db
    .prepare(
      `
        SELECT
          sessions.id AS session_id,
          sessions.task_id,
          sessions.ended_at,
          tasks.status,
          tasks.state_version,
          tasks.blocked_from_state
        FROM sessions
        INNER JOIN tasks ON tasks.id = sessions.task_id
        WHERE sessions.id = ?
      `,
    )
    .get(sessionId) as TransitionSessionRow | undefined;
}

function readTransitionIdempotency(db: DatabaseSync, sessionId: string, idempotencyKey: string) {
  return db
    .prepare(
      `
        SELECT request_json, request_sha256, result_json
        FROM transition_idempotency
        WHERE session_id = ? AND idempotency_key = ?
      `,
    )
    .get(sessionId, idempotencyKey) as
    { request_json: string; request_sha256: string; result_json: string } | undefined;
}

function readTransitionIdempotencyConflict(db: DatabaseSync, input: PersistSessionTransitionInput) {
  return db
    .prepare(
      `
        SELECT result_json
        FROM transition_idempotency_conflicts
        WHERE session_id = ? AND idempotency_key = ? AND request_sha256 = ? AND request_json = ?
      `,
    )
    .get(input.sessionId, input.idempotencyKey, input.requestSha256, input.requestJson) as
    { result_json: string } | undefined;
}

function appendAuditEvent(
  db: DatabaseSync,
  input: {
    sessionId: string;
    eventType: AuditEventType;
    stateVersion: number;
    recordedAt: string;
    payload: Record<string, unknown>;
  },
) {
  const previous = readAuditTail(db, input.sessionId);
  const integrity = previous ? verifyAuditEventIntegrity(previous, sha256) : null;
  if (integrity && !integrity.valid) {
    throw new AuditChainCorruptedError(
      integrity.error?.code ?? 'AUDIT_HASH_MISMATCH',
      `Session ${input.sessionId} audit tail is corrupt at sequence ${previous?.value.sequence ?? 'root'}.`,
      previous?.value.sequence,
      input.sessionId,
    );
  }
  const event = createAuditEvent(
    {
      id: createId('audit'),
      sessionId: input.sessionId,
      sequence: (previous?.value.sequence ?? 0) + 1,
      eventType: input.eventType,
      recordedAt: input.recordedAt,
      stateVersion: input.stateVersion,
      previousSha256: previous?.sha256 ?? ZERO_AUDIT_HASH,
      payload: input.payload,
    },
    sha256,
  );
  insertRow(db, 'audit_events', {
    id: event.value.id,
    session_id: event.value.session_id,
    sequence: event.value.sequence,
    event_type: event.value.event_type,
    state_version: event.value.state_version,
    previous_sha256: event.value.previous_sha256,
    event_json: event.json,
    event_sha256: event.sha256,
    recorded_at: event.value.recorded_at,
  });
  return event;
}

function readVerifiedAuditEvents(db: DatabaseSync, sessionId: string) {
  const events = readAuditEvents(db, sessionId);
  if (events.length === 0) {
    throw new AuditChainCorruptedError(
      'AUDIT_SEQUENCE_MISMATCH',
      `Session ${sessionId} audit chain has no genesis event.`,
      1,
      sessionId,
    );
  }
  const verification = verifyAuditChain(events, sha256);
  if (!verification.valid) {
    throw new AuditChainCorruptedError(
      verification.error?.code ?? 'AUDIT_HASH_MISMATCH',
      `Session ${sessionId} audit chain is corrupt at sequence ${verification.error?.sequence ?? 'root'}.`,
      verification.error?.sequence,
      sessionId,
    );
  }
  return events;
}

const AUDIT_EVENT_SELECT = `
  SELECT id, session_id, sequence, event_type, state_version, previous_sha256, event_json, event_sha256, recorded_at
  FROM audit_events
  WHERE session_id = ?
`;

function readAuditTail(db: DatabaseSync, sessionId: string) {
  const row = db.prepare(`${AUDIT_EVENT_SELECT} ORDER BY sequence DESC LIMIT 1`).get(sessionId) as
    AuditEventRow | undefined;
  return row ? storedAuditEventFromRow(row, sessionId) : null;
}

function readAuditEvents(db: DatabaseSync, sessionId: string): StoredAuditEvent[] {
  const rows = db.prepare(`${AUDIT_EVENT_SELECT} ORDER BY sequence`).all(sessionId) as AuditEventRow[];
  return rows.map((row) => storedAuditEventFromRow(row, sessionId));
}

function storedAuditEventFromRow(row: AuditEventRow, sessionId: string): StoredAuditEvent {
  let value: StoredAuditEvent['value'];
  try {
    value = parseJsonText<StoredAuditEvent['value']>(row.event_json, INVALID_STATE_DB_ERROR);
  } catch {
    throw new AuditChainCorruptedError(
      'AUDIT_CANONICALIZATION_MISMATCH',
      `Session ${sessionId} audit row ${row.sequence} does not contain a valid canonical event.`,
      row.sequence,
      sessionId,
    );
  }
  if (
    value.id !== row.id ||
    value.session_id !== row.session_id ||
    value.sequence !== row.sequence ||
    value.event_type !== row.event_type ||
    value.state_version !== row.state_version ||
    value.previous_sha256 !== row.previous_sha256 ||
    value.recorded_at !== row.recorded_at
  ) {
    throw new AuditChainCorruptedError(
      'AUDIT_CANONICALIZATION_MISMATCH',
      `Session ${sessionId} audit row ${row.sequence} does not match its canonical event.`,
      row.sequence,
      sessionId,
    );
  }
  return { value, json: row.event_json, sha256: row.event_sha256 };
}

function detectTransitionStateCorruption(current: TransitionSessionRow) {
  if (!isTaskStatus(current.status)) {
    return `Session ${current.session_id} has an invalid lifecycle state.`;
  }
  if (current.blocked_from_state !== null && !isTaskStatus(current.blocked_from_state)) {
    return `Session ${current.session_id} has an invalid blocked prior state.`;
  }
  if (!Number.isSafeInteger(current.state_version) || current.state_version < 0) {
    return `Session ${current.session_id} has an invalid lifecycle state version.`;
  }
  if (
    (current.status === TASK_STATUS.BLOCKED &&
      (!current.blocked_from_state ||
        current.blocked_from_state === TASK_STATUS.BLOCKED ||
        current.blocked_from_state === TASK_STATUS.COMPLETED)) ||
    (current.status !== TASK_STATUS.BLOCKED && current.blocked_from_state !== null)
  ) {
    return `Session ${current.session_id} has an inconsistent blocked prior state.`;
  }
  if ((current.status === TASK_STATUS.COMPLETED) !== (current.ended_at !== null)) {
    return `Session ${current.session_id} has inconsistent task and completion state.`;
  }
  return null;
}

function persistRejectedTransition(
  db: DatabaseSync,
  input: PersistSessionTransitionInput,
  result: SessionTransitionResult & { ok: false },
) {
  const createdAt = new Date().toISOString();
  persistTransitionIdempotency(db, input, 'rejected', null, result, createdAt);
  appendRejectedGuardDecision(db, input, result, createdAt);
  return result;
}

function appendRejectedGuardDecision(
  db: DatabaseSync,
  input: PersistSessionTransitionInput,
  result: SessionTransitionResult & { ok: false },
  recordedAt: string,
) {
  const current = readTransitionSession(db, input.sessionId);
  if (!current) {
    return;
  }
  appendAuditEvent(db, {
    sessionId: input.sessionId,
    eventType: 'guard_decision',
    stateVersion: current.state_version,
    recordedAt,
    payload: {
      idempotency_key: input.idempotencyKey,
      request_sha256: input.requestSha256,
      from_state: current.status,
      target_state: input.targetState,
      allowed: false,
      error: result.error,
    },
  });
}

function persistTransitionIdempotency(
  db: DatabaseSync,
  input: PersistSessionTransitionInput,
  outcome: 'applied' | 'rejected',
  transitionId: string | null,
  result: SessionTransitionResult,
  createdAt: string,
) {
  insertRow(db, 'transition_idempotency', {
    session_id: input.sessionId,
    idempotency_key: input.idempotencyKey,
    request_json: input.requestJson,
    request_sha256: input.requestSha256,
    outcome,
    transition_id: transitionId,
    result_json: JSON.stringify(result),
    created_at: createdAt,
  });
}

function failedTransition(
  code: ThreadloopErrorCode,
  message: string,
  details?: Record<string, unknown>,
): SessionTransitionResult & { ok: false } {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) } };
}

function insertTask(db: DatabaseSync, task: Task) {
  insertRow(db, 'tasks', {
    id: task.id,
    title: task.title,
    goal: task.goal,
    constraints_json: JSON.stringify(task.constraints),
    issue_ref: task.issueRef,
    repo_root: task.repoRoot,
    status: task.status,
    state_version: task.stateVersion,
    blocked_from_state: task.blockedFromState,
    created_at: task.createdAt,
  });
}

function insertSession(db: DatabaseSync, session: Session) {
  insertRow(db, 'sessions', {
    id: session.id,
    task_id: session.taskId,
    started_at: session.startedAt,
    ended_at: session.endedAt,
    base_ref: session.baseRef,
    branch: session.branch,
    head_sha: session.headSha,
    last_heartbeat_at: session.lastHeartbeatAt,
    last_heartbeat_source: session.lastHeartbeatSource,
  });
}

function insertEntry(db: DatabaseSync, entry: Entry) {
  insertRow(db, 'entries', {
    id: entry.id,
    session_id: entry.sessionId,
    kind: entry.kind,
    body: entry.body,
    metadata_json: JSON.stringify(entry.metadata),
    created_at: entry.createdAt,
    source: entry.source,
  });
}

function writeRepoSnapshot(db: DatabaseSync, snapshot: StoredRepoSnapshot) {
  db.prepare(
    `
      INSERT OR REPLACE INTO repo_snapshots (
        session_id, branch, head_sha, base_ref, changed_files_json, diff_stats_json, commit_range_json, reconciled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    snapshot.sessionId,
    snapshot.branch,
    snapshot.headSha,
    snapshot.baseRef,
    JSON.stringify(snapshot.changedFiles),
    JSON.stringify(snapshot.diffStats),
    JSON.stringify(snapshot.commitRange),
    snapshot.reconciledAt,
  );
}

/** Table and column names always come from literals in this module, never from input. */
function insertRow(db: DatabaseSync, table: string, row: Record<string, SQLInputValue>) {
  const columns = Object.keys(row);
  return db
    .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...Object.values(row));
}

/** Selects snake_case columns under the camelCase names of the domain record they populate. */
function camelColumns(columns: readonly string[]) {
  return columns
    .map((column) => `${column} AS "${column.replace(/_([a-z0-9])/g, (_, next: string) => next.toUpperCase())}"`)
    .join(', ');
}

function parseJsonText<T>(value: string, invalidMessage: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new InvalidJsonError(invalidMessage);
  }
}

function runInTransaction<T>(db: DatabaseSync, begin: 'BEGIN IMMEDIATE' | 'BEGIN DEFERRED', action: () => T): T {
  db.exec(begin);
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK');
    }
    throw error;
  }
}
