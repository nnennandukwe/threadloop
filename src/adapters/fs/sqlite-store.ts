import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
  REPAIR_ENTRY_STATES,
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
import type { BoundProofPlan, GateReceiptPayload, GateReceiptResult, StoredGateReceipt } from '../../domain/proof.js';
import type { ParsedSignedReceiptPackage, StoredSignedGateReceipt } from '../../domain/attestation.js';
import type { VerifiedSigstoreSigner } from '../crypto/sigstore.js';
import type { ParsedSignedReviewReceiptPackage, StoredSignedReviewReceipt } from '../../domain/review.js';
import type {
  ActiveState,
  Artifact,
  Entry,
  HeartbeatSource,
  Session,
  StateData,
  Task,
  TaskStatus,
  ThreadloopConfig,
} from '../../domain/types.js';
import { TASK_STATUS, isTaskStatus } from '../../domain/types.js';
import type { ThreadloopErrorCode } from '../../contracts/errors.js';
import { threadloopPaths } from './repo.js';
import { DatabaseSync } from './sqlite-driver.js';

const CURRENT_SCHEMA_VERSION = 7;
const INVALID_CONFIG_ERROR = 'Invalid .threadloop/config.json';
const INVALID_STATE_JSON_ERROR = 'Invalid .threadloop/state/state.json';
const INVALID_STATE_DB_ERROR = 'Invalid .threadloop/state/state.db';
const SQLITE_BUSY_TIMEOUT_MS = 10_000;
const TRANSITION_SCHEMA_TRIGGERS = [
  'session_transitions_no_update',
  'session_transitions_no_delete',
  'session_transitions_no_replace',
] as const;
const PROOF_SCHEMA_TRIGGERS = [
  'proof_plans_no_update',
  'proof_plans_no_delete',
  'proof_plans_no_replace',
  'gate_receipts_no_update',
  'gate_receipts_no_delete',
  'gate_receipts_no_replace',
] as const;
const SIGNED_RECEIPT_SCHEMA_TRIGGERS = [
  'signed_gate_receipts_no_update',
  'signed_gate_receipts_no_delete',
  'signed_gate_receipts_no_replace',
] as const;
const REVIEW_AUDIT_SCHEMA_TRIGGERS = [
  'signed_review_receipts_no_update',
  'signed_review_receipts_no_delete',
  'signed_review_receipts_no_replace',
  'audit_events_no_update',
  'audit_events_no_delete',
  'audit_events_no_replace',
] as const;
type AuditVerificationCacheEntry = { dataVersion: number; count: number; root: string };
const auditVerificationCache = new WeakMap<DatabaseSync, Map<string, AuditVerificationCacheEntry>>();

class InvalidJsonError extends Error {}

type SetupState = { status: 'unknown' } | { status: 'ready' } | { status: 'failed'; error: unknown };

type RepoConnectionState = {
  writer: DatabaseSync | null;
  setup: SetupState;
  pendingWrite: Promise<void>;
};

type SqliteError = Error & {
  code?: string;
  errcode?: number;
  errstr?: string;
};

type TaskRow = {
  id: string;
  title: string;
  goal: string;
  constraints_json: string;
  issue_ref: string | null;
  repo_root: string;
  status: Task['status'];
  state_version: number;
  blocked_from_state: Task['blockedFromState'];
  created_at: string;
};

type SessionRow = {
  id: string;
  task_id: string;
  started_at: string;
  ended_at: string | null;
  base_ref: string | null;
  branch: string;
  head_sha: string;
  last_heartbeat_at: string | null;
  last_heartbeat_source: HeartbeatSource | null;
};

type EntryRow = {
  id: string;
  session_id: string;
  kind: Entry['kind'];
  body: string;
  metadata_json: string;
  created_at: string;
  source: Entry['source'];
};

type ArtifactRow = {
  id: string;
  session_id: string;
  kind: Artifact['kind'];
  path: string;
  template_version: string;
  generated_at: string;
  snapshot_source: string | null;
};

type ActiveStateRow = {
  task_id: string;
  session_id: string;
};

type ActiveSessionRow = {
  task_id: string;
  session_id: string;
};

type TransitionSessionRow = {
  session_id: string;
  task_id: string;
  ended_at: string | null;
  status: TaskStatus;
  state_version: number;
  blocked_from_state: TaskStatus | null;
};

type TransitionIdempotencyRow = {
  request_json: string;
  request_sha256: string;
  result_json: string;
};

type ProofPlanRow = {
  session_id: string;
  plan_json: string;
  plan_sha256: string;
  baseline_branch: string;
  baseline_head_sha: string;
  created_at: string;
};

type GateReceiptRow = {
  sequence: number;
  id: string;
  session_id: string;
  gate_id: string;
  plan_sha256: string;
  head_before: string;
  head_after: string;
  result: GateReceiptResult;
  artifact_path: string;
  artifact_sha256: string;
  receipt_json: string;
  receipt_sha256: string;
  state_version: number;
  created_at: string;
};

type SignedGateReceiptRow = {
  sequence: number;
  id: string;
  session_id: string;
  gate_id: string;
  plan_sha256: string;
  subject_head_sha: string;
  result: 'passed';
  package_path: string;
  package_sha256: string;
  artifact_json: string;
  artifact_sha256: string;
  statement_json: string;
  statement_sha256: string;
  issuer: string;
  certificate_identity: string;
  build_signer_uri: string;
  build_signer_sha: string;
  source_repository: string;
  source_ref: string;
  run_invocation_uri: string;
  state_version: number;
  verified_at: string;
};

type SignedReviewReceiptRow = {
  sequence: number;
  id: string;
  session_id: string;
  plan_sha256: string;
  pull_request_number: number;
  subject_head_sha: string;
  package_path: string;
  package_sha256: string;
  artifact_json: string;
  artifact_sha256: string;
  statement_json: string;
  statement_sha256: string;
  issuer: string;
  certificate_identity: string;
  build_signer_uri: string;
  build_signer_sha: string;
  source_repository: string;
  source_ref: string;
  run_invocation_uri: string;
  state_version: number;
  verified_at: string;
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

export interface PersistSessionTransitionInput extends TransitionRequest, CanonicalTransitionRequest {
  idempotencyKey: string;
  boundProofPlan?: BoundProofPlan;
}

export interface AppendGateReceiptInput {
  receipt: GateReceiptPayload;
  receiptJson: string;
  receiptSha256: string;
  stateVersion: number;
}

export interface AppendSignedGateReceiptInput {
  receipt: ParsedSignedReceiptPackage;
  signer: VerifiedSigstoreSigner;
  packagePath: string;
  stateVersion: number;
  verifiedAt: string;
  promotePackage: () => void;
}

export interface AppendSignedReviewReceiptInput {
  receipt: ParsedSignedReviewReceiptPackage;
  signer: VerifiedSigstoreSigner;
  packagePath: string;
  stateVersion: number;
  verifiedAt: string;
  promotePackage: () => void;
}

export class ReceiptAppendConflictError extends Error {}
export class SignedReceiptAppendConflictError extends Error {}
export class SignedReviewReceiptAppendConflictError extends Error {}
export class AuditLedgerUnavailableError extends Error {
  readonly reason: 'schema_version' | 'table_missing';
  readonly schemaVersion: number;

  constructor(reason: 'schema_version' | 'table_missing', schemaVersion: number) {
    const message =
      reason === 'schema_version'
        ? `Audit storage requires schema v6 or newer; found schema v${schemaVersion}.`
        : `Audit storage is unavailable for schema v${schemaVersion}.`;
    super(message);
    this.name = 'AuditLedgerUnavailableError';
    this.reason = reason;
    this.schemaVersion = schemaVersion;
  }
}
export class AuditChainCorruptedError extends Error {
  readonly code: AuditVerificationErrorCode;
  readonly sequence?: number;

  constructor(code: AuditVerificationErrorCode, message: string, sequence?: number) {
    super(message);
    this.name = 'AuditChainCorruptedError';
    this.code = code;
    if (sequence !== undefined) {
      this.sequence = sequence;
    }
  }
}

export type TransitionGuardEvaluator = (
  sourceState: TaskStatus,
  targetState: TaskStatus,
  input: Record<string, unknown>,
  blockedFromState: TaskStatus | null,
) => TransitionGuardDecision;

const repoConnections = new Map<string, RepoConnectionState>();

export function createId(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

export async function ensureThreadloopLayout(repoRoot: string) {
  const paths = threadloopPaths(repoRoot);
  await mkdir(paths.root, { recursive: true });
  await mkdir(paths.stateDir, { recursive: true });
  await mkdir(paths.artifactsDir, { recursive: true });
}

export async function ensureStateDatabase(repoRoot: string) {
  await ensureThreadloopLayout(repoRoot);
  const state = getRepoConnectionState(repoRoot);
  if (state.setup.status === 'ready') {
    assertReadySchemaVersion(repoRoot, state);
    return;
  }

  await withSerializedWriteAccess(repoRoot, (db, state) => {
    ensureDatabaseReady(db, state, repoRoot);
  });
}

export async function writeConfig(repoRoot: string, config: ThreadloopConfig) {
  const paths = threadloopPaths(repoRoot);
  await ensureThreadloopLayout(repoRoot);
  await writeJson(paths.configPath, config);
}

export async function readConfig(repoRoot: string): Promise<ThreadloopConfig> {
  const paths = threadloopPaths(repoRoot);
  const parsed = threadloopConfigSchema.safeParse(await readJson(paths.configPath, INVALID_CONFIG_ERROR));
  if (!parsed.success) {
    throw new Error(INVALID_CONFIG_ERROR);
  }
  return parsed.data;
}

export async function readState(repoRoot: string): Promise<StateData> {
  await ensureStateDatabase(repoRoot);

  const db = openReadDatabase(repoRoot);
  try {
    const state = loadState(db);
    const parsed = stateDataSchema.safeParse(state);
    if (!parsed.success) {
      throw new Error(INVALID_STATE_DB_ERROR);
    }
    return parsed.data;
  } finally {
    db.close();
  }
}

export async function readSessionGateContext(repoRoot: string, sessionId: string) {
  await ensureStateDatabase(repoRoot);
  const db = openReadDatabase(repoRoot);
  try {
    const current = readTransitionSession(db, sessionId);
    if (!current) {
      return null;
    }
    const corruption = detectTransitionStateCorruption(db, current);
    if (corruption) {
      throw new Error(corruption);
    }
    const plan = db
      .prepare(
        `
          SELECT session_id, plan_json, plan_sha256, baseline_branch, baseline_head_sha, created_at
          FROM proof_plans
          WHERE session_id = ?
        `,
      )
      .get(sessionId) as ProofPlanRow | undefined;
    return {
      taskId: current.task_id,
      sessionId: current.session_id,
      state: current.status,
      stateVersion: current.state_version,
      blockedFromState: current.blocked_from_state,
      plan: plan
        ? {
            sessionId: plan.session_id,
            json: plan.plan_json,
            sha256: plan.plan_sha256,
            baselineBranch: plan.baseline_branch,
            baselineHeadSha: plan.baseline_head_sha,
            createdAt: plan.created_at,
          }
        : null,
    };
  } finally {
    db.close();
  }
}

export function readSessionProofEvidenceReadOnly(repoRoot: string, sessionId: string) {
  const db = openReadDatabase(repoRoot);
  try {
    const plan = db
      .prepare(
        `
          SELECT session_id, plan_json, plan_sha256, baseline_branch, baseline_head_sha, created_at
          FROM proof_plans
          WHERE session_id = ?
        `,
      )
      .get(sessionId) as ProofPlanRow | undefined;
    const receiptRows = db
      .prepare(
        `
          SELECT
            sequence, id, session_id, gate_id, plan_sha256, head_before, head_after, result,
            artifact_path, artifact_sha256, receipt_json, receipt_sha256, state_version, created_at
          FROM gate_receipts
          WHERE session_id = ?
          ORDER BY sequence
        `,
      )
      .all(sessionId) as GateReceiptRow[];
    const receipts: StoredGateReceipt[] = receiptRows.map((row) => ({
      sequence: row.sequence,
      id: row.id,
      sessionId: row.session_id,
      gateId: row.gate_id,
      planSha256: row.plan_sha256,
      headBefore: row.head_before,
      headAfter: row.head_after,
      result: row.result,
      artifactPath: row.artifact_path,
      artifactSha256: row.artifact_sha256,
      receiptJson: row.receipt_json,
      receiptSha256: row.receipt_sha256,
      stateVersion: row.state_version,
      createdAt: row.created_at,
    }));
    const signedReceiptRows = tableExists(db, 'signed_gate_receipts')
      ? (db
          .prepare(
            `
              SELECT
                sequence, id, session_id, gate_id, plan_sha256, subject_head_sha, result,
                package_path, package_sha256, artifact_json, artifact_sha256, statement_json,
                statement_sha256, issuer, certificate_identity, build_signer_uri, build_signer_sha,
                source_repository, source_ref, run_invocation_uri, state_version, verified_at
              FROM signed_gate_receipts
              WHERE session_id = ?
              ORDER BY sequence
            `,
          )
          .all(sessionId) as SignedGateReceiptRow[])
      : [];
    const signedReceipts: StoredSignedGateReceipt[] = signedReceiptRows.map((row) => ({
      sequence: row.sequence,
      id: row.id,
      sessionId: row.session_id,
      gateId: row.gate_id,
      planSha256: row.plan_sha256,
      subjectHeadSha: row.subject_head_sha,
      result: row.result,
      packagePath: row.package_path,
      packageSha256: row.package_sha256,
      artifactJson: row.artifact_json,
      artifactSha256: row.artifact_sha256,
      statementJson: row.statement_json,
      statementSha256: row.statement_sha256,
      issuer: row.issuer,
      certificateIdentity: row.certificate_identity,
      buildSignerUri: row.build_signer_uri,
      buildSignerSha: row.build_signer_sha,
      sourceRepository: row.source_repository,
      sourceRef: row.source_ref,
      runInvocationUri: row.run_invocation_uri,
      stateVersion: row.state_version,
      verifiedAt: row.verified_at,
    }));
    const signedReviewRows = tableExists(db, 'signed_review_receipts')
      ? (db
          .prepare(
            `
              SELECT
                sequence, id, session_id, plan_sha256, pull_request_number, subject_head_sha,
                package_path, package_sha256, artifact_json, artifact_sha256, statement_json,
                statement_sha256, issuer, certificate_identity, build_signer_uri, build_signer_sha,
                source_repository, source_ref, run_invocation_uri, state_version, verified_at
              FROM signed_review_receipts
              WHERE session_id = ?
              ORDER BY sequence
            `,
          )
          .all(sessionId) as SignedReviewReceiptRow[])
      : [];
    const signedReviewReceipts: StoredSignedReviewReceipt[] = signedReviewRows.map((row) => ({
      sequence: row.sequence,
      id: row.id,
      sessionId: row.session_id,
      planSha256: row.plan_sha256,
      pullRequestNumber: row.pull_request_number,
      subjectHeadSha: row.subject_head_sha,
      packagePath: row.package_path,
      packageSha256: row.package_sha256,
      artifactJson: row.artifact_json,
      artifactSha256: row.artifact_sha256,
      statementJson: row.statement_json,
      statementSha256: row.statement_sha256,
      issuer: row.issuer,
      certificateIdentity: row.certificate_identity,
      buildSignerUri: row.build_signer_uri,
      buildSignerSha: row.build_signer_sha,
      sourceRepository: row.source_repository,
      sourceRef: row.source_ref,
      runInvocationUri: row.run_invocation_uri,
      stateVersion: row.state_version,
      verifiedAt: row.verified_at,
    }));
    const attemptsUsed = readNumericValue(
      db,
      `
        SELECT COUNT(*) AS count
        FROM session_transitions
        WHERE session_id = ?
          AND to_state = ?
          AND from_state IN (?, ?, ?)
      `,
      'count',
      sessionId,
      TASK_STATUS.REPAIRING,
      ...REPAIR_ENTRY_STATES,
    );
    return {
      plan: plan
        ? {
            sessionId: plan.session_id,
            json: plan.plan_json,
            sha256: plan.plan_sha256,
            baselineBranch: plan.baseline_branch,
            baselineHeadSha: plan.baseline_head_sha,
            createdAt: plan.created_at,
          }
        : null,
      receipts,
      signedReceipts,
      signedReviewReceipts,
      attemptsUsed,
    };
  } finally {
    db.close();
  }
}

export function readSessionAuditReadOnly(repoRoot: string, sessionId: string): StoredAuditEvent[] {
  const db = openReadDatabase(repoRoot);
  try {
    const schemaVersion = readDatabaseSchemaVersion(db);
    if (schemaVersion < 6) {
      throw new AuditLedgerUnavailableError('schema_version', schemaVersion);
    }
    if (!tableExists(db, 'audit_events')) {
      throw new AuditLedgerUnavailableError('table_missing', schemaVersion);
    }
    return readAuditEvents(db, sessionId);
  } finally {
    db.close();
  }
}

export function inspectAuditLedgerReadOnly(repoRoot: string) {
  const { stateDbPath } = threadloopPaths(repoRoot);
  if (!existsSync(stateDbPath)) {
    return {
      available: false,
      schemaVersion: null,
    };
  }
  const db = openReadDatabase(repoRoot);
  try {
    const schemaVersion = readDatabaseSchemaVersion(db);
    return {
      available: schemaVersion >= 6 && tableExists(db, 'audit_events'),
      schemaVersion,
    };
  } finally {
    db.close();
  }
}

export function readSessionTransitionHistoryReadOnly(repoRoot: string, sessionId: string) {
  const db = openReadDatabase(repoRoot);
  try {
    if (readDatabaseSchemaVersion(db) >= 7) {
      assertTransitionSchemaShape(db, true);
      assertSessionTransitionHistoryAuthority(db, sessionId);
    }
    return readSessionTransitionHistory(db, sessionId);
  } finally {
    db.close();
  }
}

function readSessionTransitionHistory(db: DatabaseSync, sessionId: string) {
  if (!tableExists(db, 'session_transitions')) {
    return [];
  }
  const rows = db
    .prepare(
      `
        SELECT
          id, from_state, to_state, from_state_version, to_state_version,
          actor, input_json, created_at
        FROM session_transitions
        WHERE session_id = ?
        ORDER BY to_state_version, rowid
      `,
    )
    .all(sessionId) as Array<{
    id: string;
    from_state: TaskStatus;
    to_state: TaskStatus;
    from_state_version: number;
    to_state_version: number;
    actor: Entry['source'];
    input_json: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    from_state: row.from_state,
    to_state: row.to_state,
    from_state_version: row.from_state_version,
    to_state_version: row.to_state_version,
    actor: row.actor,
    input: parseJsonText<Record<string, unknown>>(row.input_json, INVALID_STATE_DB_ERROR),
    created_at: row.created_at,
  }));
}

function assertAllSessionTransitionHistoryAuthority(db: DatabaseSync) {
  const sessions = db.prepare(`SELECT id FROM sessions ORDER BY id`).all() as Array<{ id: string }>;
  for (const session of sessions) {
    assertSessionTransitionHistoryAuthority(db, session.id, true);
  }
}

function assertSessionTransitionHistoryAuthority(
  db: DatabaseSync,
  sessionId: string,
  requireCurrentProjection = false,
) {
  if (!tableExists(db, 'audit_events')) {
    return;
  }
  const rows = db
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
    .all(sessionId) as Array<{
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
  }>;

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
    previous = row;
  }

  const auditEvents = readVerifiedAuditEvents(db, sessionId);
  const genesis = auditEvents[0]?.value;
  const auditFloor =
    genesis?.event_type === 'session_started'
      ? 0
      : genesis?.event_type === 'audit_activated' && genesis.payload.coverage === 'schema_v6_forward'
        ? genesis.state_version
        : null;
  if (auditFloor === null) {
    throw invalidTransitionHistory(sessionId, 'audit coverage does not establish a lifecycle history boundary');
  }

  const authoritativeRows = rows.filter((row) => row.from_state_version >= auditFloor);
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

  if (requireCurrentProjection) {
    const current = readTransitionSession(db, sessionId);
    if (!current) {
      throw invalidTransitionHistory(sessionId, 'session projection is missing');
    }
    const latest = rows.at(-1);
    if (
      (latest &&
        (latest.task_id !== current.task_id ||
          latest.to_state !== current.status ||
          latest.to_state_version !== current.state_version)) ||
      (!latest && current.state_version !== 0)
    ) {
      throw invalidTransitionHistory(sessionId, 'current lifecycle projection does not match transition history');
    }
  }
}

function invalidTransitionHistory(sessionId: string, detail: string) {
  return new Error(`Invalid session transition history for ${sessionId}: ${detail}.`);
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
  const db = openReadDatabase(repoRoot);
  try {
    return Boolean(
      db
        .prepare(
          `
            SELECT 1 AS present
            FROM transition_idempotency
            WHERE session_id = ? AND idempotency_key = ?
          `,
        )
        .get(sessionId, idempotencyKey),
    );
  } finally {
    db.close();
  }
}

export function readSessionLifecycleReadOnly(repoRoot: string, sessionId: string) {
  const { stateDbPath } = threadloopPaths(repoRoot);
  if (!existsSync(stateDbPath)) {
    throw new Error('ThreadLoop state database is missing.');
  }

  const db = openReadDatabase(repoRoot);
  try {
    if (!tableExists(db, 'metadata')) {
      throw new Error('Missing ThreadLoop schema version metadata.');
    }
    const rawVersion = readTextValue(db, `SELECT value FROM metadata WHERE key = 'schema_version'`, 'value');
    if (!rawVersion) {
      throw new Error('Missing ThreadLoop schema version metadata.');
    }
    const version = parseSchemaVersion(rawVersion);
    if (version === 1) {
      throw new Error('ThreadLoop schema version 1 requires migration before session next can read lifecycle state.');
    }
    if (version > CURRENT_SCHEMA_VERSION) {
      throw new Error(`Unsupported ThreadLoop schema version: ${rawVersion}`);
    }
    if (version >= 3) {
      const taskColumns = new Set(
        (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map((column) => column.name),
      );
      if (!taskColumns.has('blocked_from_state')) {
        throw new Error('Invalid schema for tasks');
      }
      assertTransitionSchemaShape(db, version >= 7);
    }
    if (version >= 4) {
      assertProofSchemaShape(db);
    }
    if (version >= 5) {
      assertSignedReceiptSchemaShape(db);
    }
    if (version >= 6) {
      assertReviewAuditSchemaShape(db);
    }

    const blockedFromSelect = version >= 3 ? 'tasks.blocked_from_state' : 'NULL AS blocked_from_state';
    const current = db
      .prepare(
        `
          SELECT
            sessions.id AS session_id,
            sessions.task_id,
            sessions.ended_at,
            tasks.status,
            tasks.state_version,
            ${blockedFromSelect}
          FROM sessions
          INNER JOIN tasks ON tasks.id = sessions.task_id
          WHERE sessions.id = ?
        `,
      )
      .get(sessionId) as TransitionSessionRow | undefined;
    if (!current) {
      return null;
    }

    const corruption = detectTransitionStateCorruption(db, current);
    if (corruption) {
      throw new Error(corruption);
    }

    return {
      taskId: current.task_id,
      sessionId: current.session_id,
      state: current.status,
      stateVersion: current.state_version,
      blockedFromState: current.blocked_from_state,
      endedAt: current.ended_at,
      schemaVersion: version,
    };
  } finally {
    db.close();
  }
}

export async function insertTaskSession(
  repoRoot: string,
  payload: {
    task: Task;
    session: Session;
    intentEntry: Entry;
    initialSnapshot?: {
      sessionId: string;
      branch: string;
      headSha: string;
      baseRef: string | null;
      changedFiles: string[];
      diffStats: { files: number; insertions: number; deletions: number };
      commitRange: string[];
      reconciledAt: string;
    };
  },
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
    insertActiveSession(db, { taskId: task.id, sessionId: session.id });
    syncActiveStateCompat(db);
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
      if (existing.request_sha256 !== input.requestSha256 || existing.request_json !== input.requestJson) {
        assertAuditChainVerifiedForWrite(db, input.sessionId);
        const priorConflict = readTransitionIdempotencyConflict(
          db,
          input.sessionId,
          input.idempotencyKey,
          input.requestSha256,
          input.requestJson,
        );
        if (priorConflict) {
          return parseJsonText<SessionTransitionResult>(priorConflict.result_json, INVALID_STATE_DB_ERROR);
        }
        return persistIdempotencyConflict(
          db,
          input,
          failedTransition(
            'IDEMPOTENCY_CONFLICT',
            `Idempotency key ${input.idempotencyKey} is already associated with a different request.`,
            {
              session_id: input.sessionId,
              idempotency_key: input.idempotencyKey,
              request_sha256: input.requestSha256,
              existing_request_sha256: existing.request_sha256,
            },
          ),
        );
      }
      return parseJsonText<SessionTransitionResult>(existing.result_json, INVALID_STATE_DB_ERROR);
    }

    const current = readTransitionSession(db, input.sessionId);
    if (!current) {
      return failedTransition('SESSION_NOT_FOUND', `Could not find session: ${input.sessionId}`, {
        session_id: input.sessionId,
      });
    }

    const corruption = detectTransitionStateCorruption(db, current);
    if (corruption) {
      return failedTransition('STATE_CORRUPTED', corruption, {
        session_id: input.sessionId,
        task_id: current.task_id,
      });
    }
    assertSessionTransitionHistoryAuthority(db, input.sessionId);
    const phase = deriveLifecyclePhase(readSessionTransitionHistory(db, input.sessionId));

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
      insertProofPlan(db, input.sessionId, input.boundProofPlan);
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
      db.prepare(`DELETE FROM active_sessions WHERE session_id = ?`).run(input.sessionId);
    } else {
      insertActiveSession(db, { taskId: current.task_id, sessionId: input.sessionId });
    }

    db.prepare(
      `
        INSERT INTO session_transitions (
          id, session_id, task_id, from_state, to_state, from_state_version, to_state_version,
          actor, input_json, request_sha256, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(
      transitionId,
      input.sessionId,
      current.task_id,
      current.status,
      input.targetState,
      current.state_version,
      nextVersion,
      input.actor,
      JSON.stringify(input.canonicalInput),
      input.requestSha256,
      createdAt,
    );
    syncActiveStateCompat(db);

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
    const current = readTransitionSession(db, input.receipt.session_id);
    if (!current) {
      throw new ReceiptAppendConflictError(`Could not find session: ${input.receipt.session_id}`);
    }
    if (current.status !== TASK_STATUS.VERIFYING || current.state_version !== input.stateVersion) {
      throw new ReceiptAppendConflictError(
        `Session ${input.receipt.session_id} changed while gate ${input.receipt.gate_id} was running.`,
      );
    }
    const plan = db
      .prepare(`SELECT plan_sha256 FROM proof_plans WHERE session_id = ?`)
      .get(input.receipt.session_id) as { plan_sha256: string } | undefined;
    if (!plan || plan.plan_sha256 !== input.receipt.plan_sha256) {
      throw new ReceiptAppendConflictError(
        `Session ${input.receipt.session_id} proof plan changed while gate ${input.receipt.gate_id} was running.`,
      );
    }
    assertAuditChainVerifiedForWrite(db, input.receipt.session_id);

    const inserted = db
      .prepare(
        `
          INSERT INTO gate_receipts (
            id, session_id, gate_id, plan_sha256, head_before, head_after, result,
            artifact_path, artifact_sha256, receipt_json, receipt_sha256, state_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        input.receipt.id,
        input.receipt.session_id,
        input.receipt.gate_id,
        input.receipt.plan_sha256,
        input.receipt.head_before,
        input.receipt.head_after,
        input.receipt.result,
        input.receipt.artifact.path,
        input.receipt.artifact.sha256,
        input.receiptJson,
        input.receiptSha256,
        input.stateVersion,
        input.receipt.ended_at,
      );
    const sequence = Number(inserted.lastInsertRowid);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error('ThreadLoop did not assign a valid gate receipt sequence.');
    }
    appendAuditEvent(db, {
      sessionId: input.receipt.session_id,
      eventType: 'proof_receipt_recorded',
      stateVersion: input.stateVersion,
      recordedAt: input.receipt.ended_at,
      payload: {
        receipt_id: input.receipt.id,
        gate_id: input.receipt.gate_id,
        receipt_sha256: input.receiptSha256,
        result: input.receipt.result,
        head_sha: input.receipt.head_after,
      },
    });
    return sequence;
  });
}

export async function appendSignedGateReceipt(repoRoot: string, input: AppendSignedGateReceiptInput) {
  return withWriteTransaction(repoRoot, (db) => {
    const artifact = input.receipt.artifact;
    const existing = db
      .prepare(
        `
          SELECT sequence, id, session_id, package_sha256, verified_at
          FROM signed_gate_receipts
          WHERE id = ? OR (session_id = ? AND package_sha256 = ?)
          ORDER BY sequence
          LIMIT 1
        `,
      )
      .get(artifact.receipt_id, artifact.session_id, input.receipt.packageSha256) as
      Pick<SignedGateReceiptRow, 'sequence' | 'id' | 'session_id' | 'package_sha256' | 'verified_at'> | undefined;
    if (existing) {
      if (
        existing.id === artifact.receipt_id &&
        existing.session_id === artifact.session_id &&
        existing.package_sha256 === input.receipt.packageSha256
      ) {
        return { sequence: existing.sequence, alreadyImported: true, verifiedAt: existing.verified_at };
      }
      throw new SignedReceiptAppendConflictError(
        `Signed receipt ${artifact.receipt_id} conflicts with previously imported content.`,
      );
    }

    const current = readTransitionSession(db, artifact.session_id);
    if (!current) {
      throw new SignedReceiptAppendConflictError(`Could not find session: ${artifact.session_id}`);
    }
    if (current.status !== 'verifying' || current.state_version !== input.stateVersion) {
      throw new SignedReceiptAppendConflictError(
        `Session ${artifact.session_id} changed while signed gate ${artifact.gate.id} was being imported.`,
      );
    }
    const plan = db.prepare(`SELECT plan_sha256 FROM proof_plans WHERE session_id = ?`).get(artifact.session_id) as
      { plan_sha256: string } | undefined;
    if (!plan || plan.plan_sha256 !== artifact.plan_sha256) {
      throw new SignedReceiptAppendConflictError(
        `Session ${artifact.session_id} proof plan changed while signed gate ${artifact.gate.id} was being imported.`,
      );
    }
    assertAuditChainVerifiedForWrite(db, artifact.session_id);

    const inserted = db
      .prepare(
        `
          INSERT INTO signed_gate_receipts (
            id, session_id, gate_id, plan_sha256, subject_head_sha, result,
            package_path, package_sha256, artifact_json, artifact_sha256, statement_json,
            statement_sha256, issuer, certificate_identity, build_signer_uri, build_signer_sha,
            source_repository, source_ref, run_invocation_uri, state_version, verified_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        artifact.receipt_id,
        artifact.session_id,
        artifact.gate.id,
        artifact.plan_sha256,
        artifact.source.head_sha,
        'passed',
        input.packagePath,
        input.receipt.packageSha256,
        input.receipt.artifactJson,
        input.receipt.artifactSha256,
        input.receipt.statementJson,
        input.receipt.statementSha256,
        input.signer.issuer,
        input.signer.certificateIdentity,
        input.signer.buildSignerUri,
        input.signer.buildSignerSha,
        input.signer.sourceRepository,
        input.signer.sourceRef,
        input.signer.runInvocationUri,
        input.stateVersion,
        input.verifiedAt,
      );
    const sequence = Number(inserted.lastInsertRowid);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error('ThreadLoop did not assign a valid signed gate receipt sequence.');
    }
    appendAuditEvent(db, {
      sessionId: artifact.session_id,
      eventType: 'signed_proof_receipt_imported',
      stateVersion: input.stateVersion,
      recordedAt: input.verifiedAt,
      payload: {
        receipt_id: artifact.receipt_id,
        gate_id: artifact.gate.id,
        package_sha256: input.receipt.packageSha256,
        subject_head_sha: artifact.source.head_sha,
      },
    });
    input.promotePackage();
    return { sequence, alreadyImported: false, verifiedAt: input.verifiedAt };
  });
}

export async function appendSignedReviewReceipt(repoRoot: string, input: AppendSignedReviewReceiptInput) {
  return withWriteTransaction(repoRoot, (db) => {
    const artifact = input.receipt.artifact;
    const existing = db
      .prepare(
        `
          SELECT sequence, id, session_id, package_sha256, verified_at
          FROM signed_review_receipts
          WHERE id = ? OR (session_id = ? AND package_sha256 = ?)
          ORDER BY sequence
          LIMIT 1
        `,
      )
      .get(artifact.receipt_id, artifact.session_id, input.receipt.packageSha256) as
      Pick<SignedReviewReceiptRow, 'sequence' | 'id' | 'session_id' | 'package_sha256' | 'verified_at'> | undefined;
    if (existing) {
      if (
        existing.id === artifact.receipt_id &&
        existing.session_id === artifact.session_id &&
        existing.package_sha256 === input.receipt.packageSha256
      ) {
        return { sequence: existing.sequence, alreadyImported: true, verifiedAt: existing.verified_at };
      }
      throw new SignedReviewReceiptAppendConflictError(
        `Signed review receipt ${artifact.receipt_id} conflicts with previously imported content.`,
      );
    }

    const current = readTransitionSession(db, artifact.session_id);
    if (!current) {
      throw new SignedReviewReceiptAppendConflictError(`Could not find session: ${artifact.session_id}`);
    }
    if (
      (current.status !== TASK_STATUS.REVIEWING && current.status !== TASK_STATUS.READY_FOR_HUMAN) ||
      current.state_version !== input.stateVersion
    ) {
      throw new SignedReviewReceiptAppendConflictError(
        `Session ${artifact.session_id} changed while review evidence was being imported.`,
      );
    }
    const plan = db.prepare(`SELECT plan_sha256 FROM proof_plans WHERE session_id = ?`).get(artifact.session_id) as
      { plan_sha256: string } | undefined;
    if (!plan || plan.plan_sha256 !== artifact.plan_sha256) {
      throw new SignedReviewReceiptAppendConflictError(
        `Session ${artifact.session_id} proof plan changed while review evidence was being imported.`,
      );
    }
    assertAuditChainVerifiedForWrite(db, artifact.session_id);

    const inserted = db
      .prepare(
        `
          INSERT INTO signed_review_receipts (
            id, session_id, plan_sha256, pull_request_number, subject_head_sha,
            package_path, package_sha256, artifact_json, artifact_sha256, statement_json,
            statement_sha256, issuer, certificate_identity, build_signer_uri, build_signer_sha,
            source_repository, source_ref, run_invocation_uri, state_version, verified_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        artifact.receipt_id,
        artifact.session_id,
        artifact.plan_sha256,
        artifact.pull_request.number,
        artifact.pull_request.head_sha,
        input.packagePath,
        input.receipt.packageSha256,
        input.receipt.artifactJson,
        input.receipt.artifactSha256,
        input.receipt.statementJson,
        input.receipt.statementSha256,
        input.signer.issuer,
        input.signer.certificateIdentity,
        input.signer.buildSignerUri,
        input.signer.buildSignerSha,
        input.signer.sourceRepository,
        input.signer.sourceRef,
        input.signer.runInvocationUri,
        input.stateVersion,
        input.verifiedAt,
      );
    const sequence = Number(inserted.lastInsertRowid);
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error('ThreadLoop did not assign a valid signed review receipt sequence.');
    }
    appendAuditEvent(db, {
      sessionId: artifact.session_id,
      eventType: 'signed_review_receipt_imported',
      stateVersion: input.stateVersion,
      recordedAt: input.verifiedAt,
      payload: {
        receipt_id: artifact.receipt_id,
        package_sha256: input.receipt.packageSha256,
        pull_request_number: artifact.pull_request.number,
        subject_head_sha: artifact.pull_request.head_sha,
        merged: artifact.pull_request.merged,
      },
    });
    input.promotePackage();
    return { sequence, alreadyImported: false, verifiedAt: input.verifiedAt };
  });
}

export async function appendEntryToSession(repoRoot: string, sessionId: string, draft: Omit<Entry, 'sessionId'>) {
  return withWriteTransaction(repoRoot, (db) => appendEntry(db, sessionId, draft));
}

export async function recordArtifact(repoRoot: string, artifact: Artifact) {
  await withWriteTransaction(repoRoot, (db) => {
    insertArtifact(db, artifact);
  });
}

export async function recordSessionHeartbeat(
  repoRoot: string,
  payload: { sessionId: string; branch: string; headSha: string; lastHeartbeatAt: string; source: HeartbeatSource },
) {
  await withWriteTransaction(repoRoot, (db) => {
    const session = readSessionRow(db, payload.sessionId);
    if (!session) {
      throw new Error(`Unknown session id: ${payload.sessionId}`);
    }

    db.prepare(
      `
          UPDATE sessions
          SET branch = ?, head_sha = ?, last_heartbeat_at = ?, last_heartbeat_source = ?
          WHERE id = ?
        `,
    ).run(payload.branch, payload.headSha, payload.lastHeartbeatAt, payload.source, payload.sessionId);
  });
}

export async function writeArtifactFile(repoRoot: string, filename: string, content: string) {
  const paths = threadloopPaths(repoRoot);
  await mkdir(paths.artifactsDir, { recursive: true });
  const fullPath = path.join(paths.artifactsDir, filename);
  await writeFile(fullPath, content, 'utf8');
  return fullPath;
}

export async function upsertRepoSnapshot(
  repoRoot: string,
  snapshot: {
    sessionId: string;
    branch: string;
    headSha: string;
    baseRef: string | null;
    changedFiles: string[];
    diffStats: { files: number; insertions: number; deletions: number };
    commitRange: string[];
    reconciledAt: string;
  },
) {
  await withWriteTransaction(repoRoot, (db) => {
    writeRepoSnapshot(db, snapshot);
  });
}

export async function readRepoSnapshot(repoRoot: string, sessionId: string) {
  await ensureStateDatabase(repoRoot);

  const db = openReadDatabase(repoRoot);
  try {
    const row = db
      .prepare(
        `
        SELECT session_id, branch, head_sha, base_ref, changed_files_json, diff_stats_json, commit_range_json, reconciled_at
        FROM repo_snapshots
        WHERE session_id = ?
      `,
      )
      .get(sessionId) as
      | {
          session_id: string;
          branch: string;
          head_sha: string;
          base_ref: string | null;
          changed_files_json: string;
          diff_stats_json: string;
          commit_range_json: string;
          reconciled_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      sessionId: row.session_id,
      branch: row.branch,
      headSha: row.head_sha,
      baseRef: row.base_ref,
      changedFiles: parseJsonText<string[]>(row.changed_files_json, INVALID_STATE_DB_ERROR),
      diffStats: parseJsonText<{ files: number; insertions: number; deletions: number }>(
        row.diff_stats_json,
        INVALID_STATE_DB_ERROR,
      ),
      commitRange: parseJsonText<string[]>(row.commit_range_json, INVALID_STATE_DB_ERROR),
      reconciledAt: row.reconciled_at,
    };
  } finally {
    db.close();
  }
}

export async function closeSqliteConnections(repoRoot?: string) {
  const repoRoots = repoRoot ? [repoRoot] : Array.from(repoConnections.keys());

  for (const currentRepoRoot of repoRoots) {
    const state = repoConnections.get(currentRepoRoot);
    if (!state) {
      continue;
    }

    await state.pendingWrite.catch(() => {});
    state.writer?.close();
    repoConnections.delete(currentRepoRoot);
  }
}

// Tests and long-lived hosts use this alias to assert that both lifecycle entry points remain safe.
export async function resetSqliteConnections(repoRoot?: string) {
  await closeSqliteConnections(repoRoot);
}

function openWriteDatabase(repoRoot: string) {
  const { stateDbPath } = threadloopPaths(repoRoot);
  const db = new DatabaseSync(stateDbPath, {
    enableForeignKeyConstraints: true,
  });
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  return db;
}

function openReadDatabase(repoRoot: string) {
  const { stateDbPath } = threadloopPaths(repoRoot);
  const db = new DatabaseSync(stateDbPath, { readOnly: true });
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  return db;
}

function getRepoConnectionState(repoRoot: string) {
  let state = repoConnections.get(repoRoot);
  if (!state) {
    state = {
      writer: null,
      setup: { status: 'unknown' },
      pendingWrite: Promise.resolve(),
    };
    repoConnections.set(repoRoot, state);
  }

  return state;
}

function getWriteDatabase(repoRoot: string, state: RepoConnectionState) {
  if (!state.writer) {
    state.writer = openWriteDatabase(repoRoot);
  }

  return state.writer;
}

async function withSerializedWriteAccess<T>(
  repoRoot: string,
  action: (db: DatabaseSync, state: RepoConnectionState) => T | Promise<T>,
): Promise<T> {
  const state = getRepoConnectionState(repoRoot);
  const previous = state.pendingWrite;
  let release: (() => void) | undefined;
  state.pendingWrite = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous.catch(() => {});

  try {
    const result = await action(getWriteDatabase(repoRoot, state), state);
    return result;
  } finally {
    release?.();
  }
}

async function withWriteTransaction<T>(repoRoot: string, action: (db: DatabaseSync) => T): Promise<T> {
  await ensureThreadloopLayout(repoRoot);

  return withSerializedWriteAccess(repoRoot, (db, state) => {
    ensureDatabaseReady(db, state, repoRoot);
    return runInImmediateTransaction(db, () => action(db));
  });
}

function ensureDatabaseReady(db: DatabaseSync, state: RepoConnectionState, repoRoot: string) {
  if (state.setup.status === 'ready') {
    try {
      assertSchemaVersion(db);
      return;
    } catch (error) {
      state.setup = { status: 'failed', error };
      throw error;
    }
  }

  if (state.setup.status === 'failed') {
    throw state.setup.error;
  }

  try {
    if (tableExists(db, 'metadata')) {
      assertSupportedSchemaVersion(db);
    }

    if (!databaseNeedsSetup(db, repoRoot)) {
      state.setup = { status: 'ready' };
      return;
    }

    db.exec('PRAGMA journal_mode = WAL');
    runInImmediateTransaction(db, () => {
      bootstrapDatabase(db);
      assertSupportedSchemaVersion(db);
      runPendingMigrations(db, repoRoot);
      assertTransitionSchemaShape(db, true);
      assertProofSchemaShape(db);
      assertSignedReceiptSchemaShape(db);
      assertReviewAuditSchemaShape(db);
      assertAllSessionTransitionHistoryAuthority(db);
      writeSchemaVersion(db);
    });
    assertSchemaVersion(db);
    state.setup = { status: 'ready' };
  } catch (error) {
    state.setup = isTransientSqliteSetupError(error) ? { status: 'unknown' } : { status: 'failed', error };
    throw error;
  }
}

function assertReadySchemaVersion(repoRoot: string, state: RepoConnectionState) {
  const db = openReadDatabase(repoRoot);
  try {
    assertSchemaVersion(db);
  } catch (error) {
    state.setup = { status: 'failed', error };
    throw error;
  } finally {
    db.close();
  }
}

function isTransientSqliteSetupError(error: unknown): error is SqliteError {
  return isSqliteError(error) && error.errcode === 5 && error.errstr === 'database is locked';
}

function isSqliteError(error: unknown): error is SqliteError {
  return error instanceof Error && (error as SqliteError).code === 'ERR_SQLITE_ERROR';
}

function databaseNeedsSetup(db: DatabaseSync, repoRoot: string) {
  if (!tableExists(db, 'metadata')) {
    return true;
  }

  const rawVersion = readTextValue(db, `SELECT value FROM metadata WHERE key = 'schema_version'`, 'value');
  if (!rawVersion || parseSchemaVersion(rawVersion) !== CURRENT_SCHEMA_VERSION) {
    return true;
  }

  const requiredTables = [
    'tasks',
    'sessions',
    'entries',
    'artifacts',
    'active_state',
    'active_sessions',
    'repo_snapshots',
    'session_transitions',
    'transition_idempotency',
    'transition_idempotency_conflicts',
    'proof_plans',
    'gate_receipts',
    'signed_gate_receipts',
    'signed_review_receipts',
    'audit_events',
  ];

  if (requiredTables.some((table) => !tableExists(db, table))) {
    return true;
  }
  if (TRANSITION_SCHEMA_TRIGGERS.some((trigger) => !triggerExists(db, trigger))) {
    return true;
  }
  if (PROOF_SCHEMA_TRIGGERS.some((trigger) => !triggerExists(db, trigger))) {
    return true;
  }
  if (SIGNED_RECEIPT_SCHEMA_TRIGGERS.some((trigger) => !triggerExists(db, trigger))) {
    return true;
  }
  if (REVIEW_AUDIT_SCHEMA_TRIGGERS.some((trigger) => !triggerExists(db, trigger))) {
    return true;
  }

  const sessionColumns = new Set(
    (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!sessionColumns.has('last_heartbeat_at') || !sessionColumns.has('last_heartbeat_source')) {
    return true;
  }

  const taskColumns = new Set(
    (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!taskColumns.has('issue_ref') || !taskColumns.has('state_version') || !taskColumns.has('blocked_from_state')) {
    return true;
  }

  const legacyStatusCount = readNumericValue(
    db,
    `SELECT COUNT(*) AS count FROM tasks WHERE status = 'active'`,
    'count',
  );
  if (legacyStatusCount > 0) {
    return true;
  }

  if (hasActiveStateCompatibilityMismatch(db)) {
    return true;
  }

  if (readActiveProjectionMismatchCount(db) > 0) {
    return true;
  }

  const { statePath } = threadloopPaths(repoRoot);
  return existsSync(statePath) && databaseIsEmpty(db);
}

function tableExists(db: DatabaseSync, tableName: string) {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName) as
    { name: string } | undefined;
  return row?.name === tableName;
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
          'execution_error', 'cleanup_failed'
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

    CREATE TRIGGER IF NOT EXISTS session_transitions_no_update
    BEFORE UPDATE ON session_transitions
    BEGIN
      SELECT RAISE(ABORT, 'session transitions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS session_transitions_no_delete
    BEFORE DELETE ON session_transitions
    BEGIN
      SELECT RAISE(ABORT, 'session transitions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS session_transitions_no_replace
    BEFORE INSERT ON session_transitions
    WHEN EXISTS (
      SELECT 1 FROM session_transitions
      WHERE id = NEW.id OR (task_id = NEW.task_id AND to_state_version = NEW.to_state_version)
    )
    BEGIN
      SELECT RAISE(ABORT, 'session transitions are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS proof_plans_no_update
    BEFORE UPDATE ON proof_plans
    BEGIN
      SELECT RAISE(ABORT, 'proof plans are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS proof_plans_no_delete
    BEFORE DELETE ON proof_plans
    BEGIN
      SELECT RAISE(ABORT, 'proof plans are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS proof_plans_no_replace
    BEFORE INSERT ON proof_plans
    WHEN EXISTS (SELECT 1 FROM proof_plans WHERE session_id = NEW.session_id)
    BEGIN
      SELECT RAISE(ABORT, 'proof plans are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS gate_receipts_no_update
    BEFORE UPDATE ON gate_receipts
    BEGIN
      SELECT RAISE(ABORT, 'gate receipts are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS gate_receipts_no_delete
    BEFORE DELETE ON gate_receipts
    BEGIN
      SELECT RAISE(ABORT, 'gate receipts are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS gate_receipts_no_replace
    BEFORE INSERT ON gate_receipts
    WHEN EXISTS (
      SELECT 1 FROM gate_receipts
      WHERE id = NEW.id OR sequence = NEW.sequence
    )
    BEGIN
      SELECT RAISE(ABORT, 'gate receipts are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS signed_gate_receipts_no_update
    BEFORE UPDATE ON signed_gate_receipts
    BEGIN
      SELECT RAISE(ABORT, 'signed gate receipts are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS signed_gate_receipts_no_delete
    BEFORE DELETE ON signed_gate_receipts
    BEGIN
      SELECT RAISE(ABORT, 'signed gate receipts are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS signed_gate_receipts_no_replace
    BEFORE INSERT ON signed_gate_receipts
    WHEN EXISTS (
      SELECT 1 FROM signed_gate_receipts
      WHERE
        id = NEW.id
        OR sequence = NEW.sequence
        OR (session_id = NEW.session_id AND package_sha256 = NEW.package_sha256)
    )
    BEGIN
      SELECT RAISE(ABORT, 'signed gate receipts are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS signed_review_receipts_no_update
    BEFORE UPDATE ON signed_review_receipts
    BEGIN
      SELECT RAISE(ABORT, 'signed review receipts are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS signed_review_receipts_no_delete
    BEFORE DELETE ON signed_review_receipts
    BEGIN
      SELECT RAISE(ABORT, 'signed review receipts are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS signed_review_receipts_no_replace
    BEFORE INSERT ON signed_review_receipts
    WHEN EXISTS (
      SELECT 1 FROM signed_review_receipts
      WHERE
        id = NEW.id
        OR sequence = NEW.sequence
        OR (session_id = NEW.session_id AND package_sha256 = NEW.package_sha256)
    )
    BEGIN
      SELECT RAISE(ABORT, 'signed review receipts are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS audit_events_no_update
    BEFORE UPDATE ON audit_events
    BEGIN
      SELECT RAISE(ABORT, 'audit events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
    BEFORE DELETE ON audit_events
    BEGIN
      SELECT RAISE(ABORT, 'audit events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS audit_events_no_replace
    BEFORE INSERT ON audit_events
    WHEN EXISTS (
      SELECT 1 FROM audit_events
      WHERE
        id = NEW.id
        OR (session_id = NEW.session_id AND sequence = NEW.sequence)
        OR (session_id = NEW.session_id AND event_sha256 = NEW.event_sha256)
    )
    BEGIN
      SELECT RAISE(ABORT, 'audit events are immutable');
    END;
  `);

  db.prepare(
    `
      INSERT INTO metadata (key, value)
      VALUES ('schema_version', ?)
      ON CONFLICT(key) DO NOTHING
    `,
  ).run(String(CURRENT_SCHEMA_VERSION));
}

function ensureSessionHeartbeatColumns(db: DatabaseSync) {
  const columns = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has('last_heartbeat_at')) {
    db.prepare(`ALTER TABLE sessions ADD COLUMN last_heartbeat_at TEXT`).run();
  }

  if (!columnNames.has('last_heartbeat_source')) {
    db.prepare(`ALTER TABLE sessions ADD COLUMN last_heartbeat_source TEXT`).run();
  }
}

function ensureTaskIssueRefColumn(db: DatabaseSync) {
  const columns = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has('issue_ref')) {
    db.prepare(`ALTER TABLE tasks ADD COLUMN issue_ref TEXT`).run();
  }
}

function ensureTaskLifecycleColumns(db: DatabaseSync) {
  const columns = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));

  if (!columnNames.has('state_version')) {
    db.prepare(`ALTER TABLE tasks ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0`).run();
  }

  if (!columnNames.has('blocked_from_state')) {
    db.prepare(`ALTER TABLE tasks ADD COLUMN blocked_from_state TEXT`).run();
  }

  db.prepare(`UPDATE tasks SET status = ? WHERE status = 'active'`).run(TASK_STATUS.QUEUED);
}

function runPendingMigrations(db: DatabaseSync, repoRoot: string) {
  ensureTaskIssueRefColumn(db);
  ensureTaskLifecycleColumns(db);
  ensureSessionHeartbeatColumns(db);
  migrateActiveStateRegistry(db);
  migrateLegacyJsonState(db, repoRoot);
  reconcileActiveSessionProjection(db);
  syncActiveStateCompat(db);
  assertActiveSessionProjection(db);
  activateAuditLedger(db);
}

function activateAuditLedger(db: DatabaseSync) {
  const sessions = db
    .prepare(
      `
        SELECT sessions.id AS session_id, tasks.status, tasks.state_version
        FROM sessions
        INNER JOIN tasks ON tasks.id = sessions.task_id
        WHERE NOT EXISTS (
          SELECT 1 FROM audit_events WHERE audit_events.session_id = sessions.id
        )
        ORDER BY sessions.rowid
      `,
    )
    .all() as Array<{ session_id: string; status: TaskStatus; state_version: number }>;
  const recordedAt = new Date().toISOString();
  for (const session of sessions) {
    appendAuditEvent(db, {
      sessionId: session.session_id,
      eventType: 'audit_activated',
      stateVersion: session.state_version,
      recordedAt,
      payload: {
        coverage: 'schema_v6_forward',
        lifecycle_state_at_activation: session.status,
        note: 'Historical decisions before schema v6 are not reconstructed.',
      },
    });
  }
}

function migrateActiveStateRegistry(db: DatabaseSync) {
  const activeSessionsCount = readNumericValue(db, `SELECT COUNT(*) AS count FROM active_sessions`, 'count');
  if (activeSessionsCount > 0) {
    syncActiveStateCompat(db);
    return;
  }

  const active = readActiveStateRow(db);
  if (!active) {
    return;
  }

  insertActiveSession(db, { taskId: active.task_id, sessionId: active.session_id });
  syncActiveStateCompat(db);
}

function reconcileActiveSessionProjection(db: DatabaseSync) {
  db.prepare(`DELETE FROM active_sessions`).run();

  db.prepare(
    `
      INSERT INTO active_sessions (session_id, task_id)
      SELECT sessions.id, sessions.task_id
      FROM sessions
      INNER JOIN tasks ON tasks.id = sessions.task_id
      WHERE tasks.status <> ? AND sessions.ended_at IS NULL
    `,
  ).run(TASK_STATUS.COMPLETED);
}

function assertActiveSessionProjection(db: DatabaseSync) {
  if (hasActiveStateCompatibilityMismatch(db) || readActiveProjectionMismatchCount(db) > 0) {
    throw new Error('Invalid active-session projection after migration.');
  }
}

function hasActiveStateCompatibilityMismatch(db: DatabaseSync) {
  const activeState = readActiveStateRow(db);
  const activeSessions = readActiveSessionRows(db);
  if (activeSessions.length === 0) {
    return Boolean(activeState);
  }
  if (activeSessions.length === 1) {
    const activeSession = activeSessions[0];
    return (
      !activeSession ||
      !activeState ||
      activeState.session_id !== activeSession.session_id ||
      activeState.task_id !== activeSession.task_id
    );
  }
  return Boolean(activeState);
}

function readActiveProjectionMismatchCount(db: DatabaseSync) {
  return readNumericValue(
    db,
    `
      SELECT COUNT(*) AS count
      FROM sessions
      INNER JOIN tasks ON tasks.id = sessions.task_id
      LEFT JOIN active_sessions ON active_sessions.session_id = sessions.id
      WHERE
        (
          tasks.status <> ?
          AND sessions.ended_at IS NULL
          AND (
            active_sessions.session_id IS NULL
            OR active_sessions.task_id <> sessions.task_id
          )
        )
        OR
        (
          (tasks.status = ? OR sessions.ended_at IS NOT NULL)
          AND active_sessions.session_id IS NOT NULL
        )
    `,
    'count',
    TASK_STATUS.COMPLETED,
    TASK_STATUS.COMPLETED,
  );
}

function assertSupportedSchemaVersion(db: DatabaseSync) {
  const version = readDatabaseSchemaVersion(db);
  if (version < 1 || version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported ThreadLoop schema version: ${version}`);
  }

  return version;
}

function readDatabaseSchemaVersion(db: DatabaseSync) {
  if (!tableExists(db, 'metadata')) {
    throw new Error('Missing ThreadLoop schema version metadata.');
  }
  const rawVersion = readTextValue(db, `SELECT value FROM metadata WHERE key = 'schema_version'`, 'value');
  if (!rawVersion) {
    throw new Error('Missing ThreadLoop schema version metadata.');
  }
  return parseSchemaVersion(rawVersion);
}

function assertSchemaVersion(db: DatabaseSync) {
  const rawVersion = readTextValue(db, `SELECT value FROM metadata WHERE key = 'schema_version'`, 'value');
  if (!rawVersion || parseSchemaVersion(rawVersion) !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported ThreadLoop schema version: ${rawVersion}`);
  }
}

function parseSchemaVersion(rawVersion: string) {
  if (!/^[1-9][0-9]*$/.test(rawVersion)) {
    throw new Error(`Unsupported ThreadLoop schema version: ${rawVersion}`);
  }

  const version = Number(rawVersion);
  if (!Number.isSafeInteger(version) || String(version) !== rawVersion) {
    throw new Error(`Unsupported ThreadLoop schema version: ${rawVersion}`);
  }

  return version;
}

function assertTransitionSchemaShape(db: DatabaseSync, requireImmutableHistory = false) {
  assertTableColumns(db, 'session_transitions', [
    'id',
    'session_id',
    'task_id',
    'from_state',
    'to_state',
    'from_state_version',
    'to_state_version',
    'actor',
    'input_json',
    'request_sha256',
    'created_at',
  ]);
  assertTableColumns(db, 'transition_idempotency', [
    'session_id',
    'idempotency_key',
    'request_json',
    'request_sha256',
    'outcome',
    'transition_id',
    'result_json',
    'created_at',
  ]);
  if (requireImmutableHistory) {
    for (const trigger of TRANSITION_SCHEMA_TRIGGERS) {
      if (!triggerExists(db, trigger)) {
        throw new Error(`Invalid schema trigger: ${trigger}`);
      }
    }
  }
}

function assertProofSchemaShape(db: DatabaseSync) {
  assertTableColumns(db, 'proof_plans', [
    'session_id',
    'plan_json',
    'plan_sha256',
    'baseline_branch',
    'baseline_head_sha',
    'created_at',
  ]);
  assertTableColumns(db, 'gate_receipts', [
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
  ]);
  for (const trigger of PROOF_SCHEMA_TRIGGERS) {
    if (!triggerExists(db, trigger)) {
      throw new Error(`Invalid schema trigger: ${trigger}`);
    }
  }
}

function assertSignedReceiptSchemaShape(db: DatabaseSync) {
  assertTableColumns(db, 'signed_gate_receipts', [
    'sequence',
    'id',
    'session_id',
    'gate_id',
    'plan_sha256',
    'subject_head_sha',
    'result',
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
  ]);
  for (const trigger of SIGNED_RECEIPT_SCHEMA_TRIGGERS) {
    if (!triggerExists(db, trigger)) {
      throw new Error(`Invalid schema trigger: ${trigger}`);
    }
  }
}

function assertReviewAuditSchemaShape(db: DatabaseSync) {
  assertTableColumns(db, 'transition_idempotency_conflicts', [
    'id',
    'session_id',
    'idempotency_key',
    'request_json',
    'request_sha256',
    'result_json',
    'created_at',
  ]);
  assertTableColumns(db, 'signed_review_receipts', [
    'sequence',
    'id',
    'session_id',
    'plan_sha256',
    'pull_request_number',
    'subject_head_sha',
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
  ]);
  assertTableColumns(db, 'audit_events', [
    'id',
    'session_id',
    'sequence',
    'event_type',
    'state_version',
    'previous_sha256',
    'event_json',
    'event_sha256',
    'recorded_at',
  ]);
  for (const trigger of REVIEW_AUDIT_SCHEMA_TRIGGERS) {
    if (!triggerExists(db, trigger)) {
      throw new Error(`Invalid schema trigger: ${trigger}`);
    }
  }
}

function assertTableColumns(db: DatabaseSync, tableName: string, requiredColumns: string[]) {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (requiredColumns.some((column) => !columns.has(column))) {
    throw new Error(`Invalid schema for ${tableName}`);
  }
}

function triggerExists(db: DatabaseSync, triggerName: string) {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(triggerName) as
    { name: string } | undefined;
  return row?.name === triggerName;
}

function writeSchemaVersion(db: DatabaseSync) {
  db.prepare(
    `
      INSERT INTO metadata (key, value)
      VALUES ('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
  ).run(String(CURRENT_SCHEMA_VERSION));
}

function migrateLegacyJsonState(db: DatabaseSync, repoRoot: string) {
  const { statePath } = threadloopPaths(repoRoot);
  if (!existsSync(statePath) || !databaseIsEmpty(db)) {
    return;
  }

  const parsed = stateDataSchema.safeParse(readJsonSync(statePath, INVALID_STATE_JSON_ERROR));
  if (!parsed.success) {
    throw new Error(INVALID_STATE_JSON_ERROR);
  }

  const legacyState = normalizeStateData(parsed.data);
  for (const task of legacyState.tasks) {
    insertTask(db, task);
  }

  for (const session of legacyState.sessions) {
    insertSession(db, session);
  }

  for (const entry of legacyState.entries) {
    insertEntry(db, entry);
  }

  for (const artifact of legacyState.artifacts) {
    insertArtifact(db, artifact);
  }

  for (const activeSession of legacyState.activeSessions) {
    insertActiveSession(db, activeSession);
  }

  syncActiveStateCompat(db);
}

function databaseIsEmpty(db: DatabaseSync) {
  const counts = db
    .prepare(
      `
        SELECT
          (SELECT COUNT(*) FROM tasks) AS tasks_count,
          (SELECT COUNT(*) FROM sessions) AS sessions_count,
          (SELECT COUNT(*) FROM entries) AS entries_count,
          (SELECT COUNT(*) FROM artifacts) AS artifacts_count,
          (SELECT COUNT(*) FROM active_state) AS active_count,
          (SELECT COUNT(*) FROM active_sessions) AS active_sessions_count,
          (SELECT COUNT(*) FROM repo_snapshots) AS snapshots_count
      `,
    )
    .get() as {
    tasks_count: number;
    sessions_count: number;
    entries_count: number;
    artifacts_count: number;
    active_count: number;
    active_sessions_count: number;
    snapshots_count: number;
  };

  return (
    counts.tasks_count === 0 &&
    counts.sessions_count === 0 &&
    counts.entries_count === 0 &&
    counts.artifacts_count === 0 &&
    counts.active_count === 0 &&
    counts.active_sessions_count === 0 &&
    counts.snapshots_count === 0
  );
}

function loadState(db: DatabaseSync): StateData {
  const tasks = (
    db
      .prepare(
        `
        SELECT id, title, goal, constraints_json, repo_root, status, state_version, blocked_from_state, created_at
        , issue_ref
        FROM tasks
        ORDER BY rowid
      `,
      )
      .all() as TaskRow[]
  ).map((row) => ({
    id: row.id,
    title: row.title,
    goal: row.goal,
    constraints: parseJsonText<string[]>(row.constraints_json, INVALID_STATE_DB_ERROR),
    issueRef: row.issue_ref ?? null,
    repoRoot: row.repo_root,
    status: row.status,
    stateVersion: row.state_version,
    blockedFromState: row.blocked_from_state,
    createdAt: row.created_at,
  }));

  const sessions = (
    db
      .prepare(
        `
        SELECT id, task_id, started_at, ended_at, base_ref, branch, head_sha, last_heartbeat_at, last_heartbeat_source
        FROM sessions
        ORDER BY rowid
      `,
      )
      .all() as SessionRow[]
  ).map((row) => ({
    id: row.id,
    taskId: row.task_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    baseRef: row.base_ref,
    branch: row.branch,
    headSha: row.head_sha,
    lastHeartbeatAt: row.last_heartbeat_at ?? null,
    lastHeartbeatSource: row.last_heartbeat_source ?? null,
  }));

  const entries = (
    db
      .prepare(
        `
        SELECT id, session_id, kind, body, metadata_json, created_at, source
        FROM entries
        ORDER BY rowid
      `,
      )
      .all() as EntryRow[]
  ).map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    body: row.body,
    metadata: parseJsonText<Record<string, unknown>>(row.metadata_json, INVALID_STATE_DB_ERROR),
    createdAt: row.created_at,
    source: row.source,
  }));

  const artifacts = (
    db
      .prepare(
        `
        SELECT id, session_id, kind, path, template_version, generated_at
        FROM artifacts
        ORDER BY rowid
      `,
      )
      .all() as ArtifactRow[]
  ).map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    path: row.path,
    templateVersion: row.template_version,
    generatedAt: row.generated_at,
  }));

  const activeSessions = readActiveSessionRows(db).map((row) => ({
    taskId: row.task_id,
    sessionId: row.session_id,
  }));
  const active = activeSessions.length === 1 ? (activeSessions[0] ?? null) : null;

  return normalizeStateData({ tasks, sessions, entries, artifacts, active, activeSessions });
}

function readActiveStateRow(db: DatabaseSync) {
  return db.prepare(`SELECT task_id, session_id FROM active_state WHERE id = 1`).get() as ActiveStateRow | undefined;
}

function readActiveSessionRows(db: DatabaseSync) {
  return db
    .prepare(
      `
        SELECT task_id, session_id
        FROM active_sessions
        ORDER BY rowid
      `,
    )
    .all() as ActiveSessionRow[];
}

function readSessionRow(db: DatabaseSync, sessionId: string) {
  return db
    .prepare(
      `
        SELECT id, task_id, started_at, ended_at, base_ref, branch, head_sha, last_heartbeat_at, last_heartbeat_source
        FROM sessions
        WHERE id = ?
      `,
    )
    .get(sessionId) as SessionRow | undefined;
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
    .get(sessionId, idempotencyKey) as TransitionIdempotencyRow | undefined;
}

function readTransitionIdempotencyConflict(
  db: DatabaseSync,
  sessionId: string,
  idempotencyKey: string,
  requestSha256: string,
  requestJson: string,
) {
  return db
    .prepare(
      `
        SELECT result_json
        FROM transition_idempotency_conflicts
        WHERE
          session_id = ?
          AND idempotency_key = ?
          AND request_sha256 = ?
          AND request_json = ?
      `,
    )
    .get(sessionId, idempotencyKey, requestSha256, requestJson) as { result_json: string } | undefined;
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
  db.prepare(
    `
      INSERT INTO audit_events (
        id, session_id, sequence, event_type, state_version, previous_sha256,
        event_json, event_sha256, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    event.value.id,
    event.value.session_id,
    event.value.sequence,
    event.value.event_type,
    event.value.state_version,
    event.value.previous_sha256,
    event.json,
    event.sha256,
    event.value.recorded_at,
  );
  cacheVerifiedAuditRoot(db, input.sessionId, event);
  return event;
}

function assertAuditChainVerifiedForWrite(db: DatabaseSync, sessionId: string) {
  const dataVersion = readDatabaseDataVersion(db);
  const cache = auditVerificationCache.get(db)?.get(sessionId);
  if (cache?.dataVersion === dataVersion) {
    const tail = readAuditTail(db, sessionId);
    const integrity = tail ? verifyAuditEventIntegrity(tail, sha256) : null;
    if (tail && integrity?.valid && tail.value.sequence === cache.count && tail.sha256 === cache.root) {
      return;
    }
  }

  readVerifiedAuditEvents(db, sessionId);
}

function readVerifiedAuditEvents(db: DatabaseSync, sessionId: string) {
  const dataVersion = readDatabaseDataVersion(db);
  const events = readAuditEvents(db, sessionId);
  if (events.length === 0) {
    throw new AuditChainCorruptedError(
      'AUDIT_SEQUENCE_MISMATCH',
      `Session ${sessionId} audit chain has no genesis event.`,
      1,
    );
  }
  const verification = verifyAuditChain(events, sha256);
  if (!verification.valid) {
    throw new AuditChainCorruptedError(
      verification.error?.code ?? 'AUDIT_HASH_MISMATCH',
      `Session ${sessionId} audit chain is corrupt at sequence ${verification.error?.sequence ?? 'root'}.`,
      verification.error?.sequence,
    );
  }
  setAuditVerificationCache(db, sessionId, {
    dataVersion,
    count: verification.count,
    root: verification.root,
  });
  return events;
}

function cacheVerifiedAuditRoot(db: DatabaseSync, sessionId: string, event: StoredAuditEvent) {
  setAuditVerificationCache(db, sessionId, {
    dataVersion: readDatabaseDataVersion(db),
    count: event.value.sequence,
    root: event.sha256,
  });
}

function setAuditVerificationCache(db: DatabaseSync, sessionId: string, entry: AuditVerificationCacheEntry) {
  const cacheBySession = auditVerificationCache.get(db) ?? new Map<string, AuditVerificationCacheEntry>();
  cacheBySession.set(sessionId, entry);
  auditVerificationCache.set(db, cacheBySession);
}

function readDatabaseDataVersion(db: DatabaseSync) {
  const row = db.prepare(`PRAGMA data_version`).get() as { data_version?: unknown };
  if (!Number.isSafeInteger(row.data_version)) {
    throw new Error('ThreadLoop could not read the SQLite data version.');
  }
  return row.data_version as number;
}

function readAuditTail(db: DatabaseSync, sessionId: string) {
  const row = db
    .prepare(
      `
        SELECT
          id, session_id, sequence, event_type, state_version, previous_sha256,
          event_json, event_sha256, recorded_at
        FROM audit_events
        WHERE session_id = ?
        ORDER BY sequence DESC
        LIMIT 1
      `,
    )
    .get(sessionId) as AuditEventRow | undefined;
  return row ? storedAuditEventFromRow(row, sessionId) : null;
}

function readAuditEvents(db: DatabaseSync, sessionId: string): StoredAuditEvent[] {
  const rows = db
    .prepare(
      `
        SELECT
          id, session_id, sequence, event_type, state_version, previous_sha256,
          event_json, event_sha256, recorded_at
        FROM audit_events
        WHERE session_id = ?
        ORDER BY sequence
      `,
    )
    .all(sessionId) as AuditEventRow[];
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
    );
  }
  return { value, json: row.event_json, sha256: row.event_sha256 };
}

function detectTransitionStateCorruption(db: DatabaseSync, current: TransitionSessionRow) {
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

  const active = db.prepare(`SELECT task_id FROM active_sessions WHERE session_id = ?`).get(current.session_id) as
    { task_id: string } | undefined;
  if (
    (current.status === TASK_STATUS.COMPLETED && active) ||
    (current.status !== TASK_STATUS.COMPLETED && (!active || active.task_id !== current.task_id))
  ) {
    return `Session ${current.session_id} has an inconsistent active-session projection.`;
  }

  if (hasActiveStateCompatibilityMismatch(db) || readActiveProjectionMismatchCount(db) > 0) {
    return 'ThreadLoop active-session compatibility projection is inconsistent.';
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
  const current = readTransitionSession(db, input.sessionId);
  if (current) {
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
        allowed: false,
        error: result.error,
      },
    });
  }
  return result;
}

function persistIdempotencyConflict(
  db: DatabaseSync,
  input: PersistSessionTransitionInput,
  result: SessionTransitionResult & { ok: false },
) {
  const createdAt = new Date().toISOString();
  db.prepare(
    `
      INSERT INTO transition_idempotency_conflicts (
        session_id, idempotency_key, request_json, request_sha256, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
  ).run(
    input.sessionId,
    input.idempotencyKey,
    input.requestJson,
    input.requestSha256,
    JSON.stringify(result),
    createdAt,
  );
  const current = readTransitionSession(db, input.sessionId);
  if (current) {
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
        allowed: false,
        error: result.error,
      },
    });
  }
  return result;
}

function persistTransitionIdempotency(
  db: DatabaseSync,
  input: PersistSessionTransitionInput,
  outcome: 'applied' | 'rejected',
  transitionId: string | null,
  result: SessionTransitionResult,
  createdAt: string,
) {
  db.prepare(
    `
      INSERT INTO transition_idempotency (
        session_id, idempotency_key, request_json, request_sha256, outcome,
        transition_id, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    input.sessionId,
    input.idempotencyKey,
    input.requestJson,
    input.requestSha256,
    outcome,
    transitionId,
    JSON.stringify(result),
    createdAt,
  );
}

function failedTransition(
  code: ThreadloopErrorCode,
  message: string,
  details?: Record<string, unknown>,
): SessionTransitionResult & { ok: false } {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}

function insertTask(db: DatabaseSync, task: Task) {
  db.prepare(
    `
      INSERT INTO tasks (
        id, title, goal, constraints_json, issue_ref, repo_root, status, state_version, blocked_from_state, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    task.id,
    task.title,
    task.goal,
    JSON.stringify(task.constraints),
    task.issueRef,
    task.repoRoot,
    task.status,
    task.stateVersion,
    task.blockedFromState,
    task.createdAt,
  );
}

function insertProofPlan(db: DatabaseSync, sessionId: string, plan: BoundProofPlan) {
  db.prepare(
    `
      INSERT INTO proof_plans (
        session_id, plan_json, plan_sha256, baseline_branch, baseline_head_sha, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
  ).run(sessionId, plan.json, plan.sha256, plan.baselineBranch, plan.baselineHeadSha, plan.createdAt);
}

function insertSession(db: DatabaseSync, session: Session) {
  db.prepare(
    `
      INSERT INTO sessions (id, task_id, started_at, ended_at, base_ref, branch, head_sha, last_heartbeat_at, last_heartbeat_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    session.id,
    session.taskId,
    session.startedAt,
    session.endedAt,
    session.baseRef,
    session.branch,
    session.headSha,
    session.lastHeartbeatAt,
    session.lastHeartbeatSource,
  );
}

function insertEntry(db: DatabaseSync, entry: Entry) {
  db.prepare(
    `
      INSERT INTO entries (id, session_id, kind, body, metadata_json, created_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    entry.id,
    entry.sessionId,
    entry.kind,
    entry.body,
    JSON.stringify(entry.metadata),
    entry.createdAt,
    entry.source,
  );
}

function insertArtifact(db: DatabaseSync, artifact: Artifact) {
  db.prepare(
    `
      INSERT INTO artifacts (id, session_id, kind, path, template_version, generated_at, snapshot_source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    artifact.id,
    artifact.sessionId,
    artifact.kind,
    artifact.path,
    artifact.templateVersion,
    artifact.generatedAt,
    artifact.snapshotSource ?? null,
  );
}

function insertActiveSession(db: DatabaseSync, active: ActiveState) {
  db.prepare(
    `
      INSERT OR REPLACE INTO active_sessions (session_id, task_id)
      VALUES (?, ?)
    `,
  ).run(active.sessionId, active.taskId);
}

function appendEntry(db: DatabaseSync, sessionId: string, draft: Omit<Entry, 'sessionId'>) {
  const session = readSessionRow(db, sessionId);
  if (!session) {
    throw new Error(`Unknown session id: ${sessionId}`);
  }

  const entry: Entry = { ...draft, sessionId };
  insertEntry(db, entry);
  return entry;
}

function normalizeStateData(state: StateData): StateData {
  return {
    ...state,
    tasks: state.tasks.map((task) => ({
      ...task,
      issueRef: task.issueRef ?? null,
      stateVersion: task.stateVersion ?? 0,
      blockedFromState: task.blockedFromState ?? null,
    })),
    sessions: state.sessions.map((session) => ({
      ...session,
      lastHeartbeatAt: session.lastHeartbeatAt ?? null,
      lastHeartbeatSource: session.lastHeartbeatSource ?? null,
    })),
    activeSessions: state.activeSessions ?? (state.active ? [state.active] : []),
  };
}

function syncActiveStateCompat(db: DatabaseSync) {
  const activeSessions = readActiveSessionRows(db);
  if (activeSessions.length === 1) {
    const active = activeSessions[0];
    if (!active) {
      throw new Error('ThreadLoop active session registry is inconsistent.');
    }
    db.prepare(
      `
        INSERT INTO active_state (id, task_id, session_id)
        VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          task_id = excluded.task_id,
          session_id = excluded.session_id
      `,
    ).run(active.task_id, active.session_id);
    return;
  }

  db.prepare(`DELETE FROM active_state WHERE id = 1`).run();
}

function writeRepoSnapshot(
  db: DatabaseSync,
  snapshot: {
    sessionId: string;
    branch: string;
    headSha: string;
    baseRef: string | null;
    changedFiles: string[];
    diffStats: { files: number; insertions: number; deletions: number };
    commitRange: string[];
    reconciledAt: string;
  },
) {
  db.prepare(
    `
      INSERT OR REPLACE INTO repo_snapshots (session_id, branch, head_sha, base_ref, changed_files_json, diff_stats_json, commit_range_json, reconciled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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

function parseJsonText<T>(value: string, invalidMessage: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new InvalidJsonError(invalidMessage);
  }
}

async function readJson(filePath: string, invalidMessage: string) {
  const raw = await readFile(filePath, 'utf8');
  return parseJsonText(raw, invalidMessage);
}

function readJsonSync(filePath: string, invalidMessage: string) {
  const raw = readFileSync(filePath, 'utf8');
  return parseJsonText(raw, invalidMessage);
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runInImmediateTransaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');

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

function readNumericValue(
  db: DatabaseSync,
  sql: string,
  column: string,
  ...params: Array<string | number | bigint | null | Uint8Array>
) {
  const row = db.prepare(sql).get(...params) as Record<string, number> | undefined;
  return row?.[column] ?? 0;
}

function readTextValue(db: DatabaseSync, sql: string, column: string) {
  const row = db.prepare(sql).get() as Record<string, string> | undefined;
  return row?.[column];
}
