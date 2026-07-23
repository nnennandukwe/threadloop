import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stateDataSchema, threadloopConfigSchema } from '../../schemas/state.js';
import { evaluateLifecycleTransition, type LifecycleTransitionDecision } from '../../domain/lifecycle.js';
import {
  type CanonicalTransitionRequest,
  type TransitionGuardDecision,
  type TransitionRequest,
  evaluateTransitionGuards,
} from '../../domain/session-transition.js';
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
import { TASK_STATUS } from '../../domain/types.js';
import type { ThreadloopErrorCode } from '../../contracts/errors.js';
import { threadloopPaths } from './repo.js';
import { DatabaseSync } from './sqlite-driver.js';

const CURRENT_SCHEMA_VERSION = 3;
const INVALID_CONFIG_ERROR = 'Invalid .threadloop/config.json';
const INVALID_STATE_JSON_ERROR = 'Invalid .threadloop/state/state.json';
const INVALID_STATE_DB_ERROR = 'Invalid .threadloop/state/state.db';
const SQLITE_BUSY_TIMEOUT_MS = 10_000;

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
      };
    }
  | { ok: false; error: StoredTransitionError };

export interface PersistSessionTransitionInput extends TransitionRequest, CanonicalTransitionRequest {
  idempotencyKey: string;
}

export type TransitionGuardEvaluator = (
  from: TaskStatus,
  to: TaskStatus,
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
    if (version === 3) {
      const taskColumns = new Set(
        (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map((column) => column.name),
      );
      if (!taskColumns.has('blocked_from_state')) {
        throw new Error('Invalid schema for tasks');
      }
      assertTransitionSchemaShape(db);
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
        return failedTransition(
          'IDEMPOTENCY_CONFLICT',
          `Idempotency key ${input.idempotencyKey} is already associated with a different request.`,
          {
            session_id: input.sessionId,
            idempotency_key: input.idempotencyKey,
            request_sha256: input.requestSha256,
            existing_request_sha256: existing.request_sha256,
          },
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
            hint: `Run threadloop session next --session ${input.sessionId} --json before retrying.`,
          },
        ),
      );
    }

    const structural: LifecycleTransitionDecision = evaluateLifecycleTransition(current.status, input.targetState, {
      blockedFromState: current.blocked_from_state,
    });
    if (!structural.allowed) {
      return persistRejectedTransition(
        db,
        input,
        failedTransition('TRANSITION_NOT_ALLOWED', structural.message, {
          session_id: input.sessionId,
          from_state: current.status,
          target_state: input.targetState,
          decision_code: structural.code,
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
            guard_failures: guards.guardFailures,
            required_work: guards.requiredWork,
          },
        ),
      );
    }

    const createdAt = new Date().toISOString();
    const transitionId = createId('transition');
    const nextVersion = current.state_version + 1;
    const blockedFromState = input.targetState === 'blocked' ? current.status : null;
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

    const endedAt = input.targetState === 'completed' ? createdAt : null;
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
      },
    };
    persistTransitionIdempotency(db, input, 'applied', transitionId, result, createdAt);
    return result;
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
      assertTransitionSchemaShape(db);
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
  ];

  if (requiredTables.some((table) => !tableExists(db, table))) {
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

  db.prepare(`UPDATE tasks SET status = 'queued' WHERE status = 'active'`).run();
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
      WHERE tasks.status <> 'completed' AND sessions.ended_at IS NULL
    `,
  ).run();
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
          tasks.status <> 'completed'
          AND sessions.ended_at IS NULL
          AND (
            active_sessions.session_id IS NULL
            OR active_sessions.task_id <> sessions.task_id
          )
        )
        OR
        (
          (tasks.status = 'completed' OR sessions.ended_at IS NOT NULL)
          AND active_sessions.session_id IS NOT NULL
        )
    `,
    'count',
  );
}

function assertSupportedSchemaVersion(db: DatabaseSync) {
  const rawVersion = readTextValue(db, `SELECT value FROM metadata WHERE key = 'schema_version'`, 'value');

  if (!rawVersion) {
    throw new Error('Missing ThreadLoop schema version metadata.');
  }

  const version = parseSchemaVersion(rawVersion);
  if (version < 1 || version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported ThreadLoop schema version: ${rawVersion}`);
  }

  return version;
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

function assertTransitionSchemaShape(db: DatabaseSync) {
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
}

function assertTableColumns(db: DatabaseSync, tableName: string, requiredColumns: string[]) {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (requiredColumns.some((column) => !columns.has(column))) {
    throw new Error(`Invalid schema for ${tableName}`);
  }
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

function detectTransitionStateCorruption(db: DatabaseSync, current: TransitionSessionRow) {
  if (!TASK_STATUS.includes(current.status)) {
    return `Session ${current.session_id} has an invalid lifecycle state.`;
  }

  if (current.blocked_from_state !== null && !TASK_STATUS.includes(current.blocked_from_state)) {
    return `Session ${current.session_id} has an invalid blocked prior state.`;
  }

  if (!Number.isSafeInteger(current.state_version) || current.state_version < 0) {
    return `Session ${current.session_id} has an invalid lifecycle state version.`;
  }

  if (
    (current.status === 'blocked' &&
      (!current.blocked_from_state || ['blocked', 'completed'].includes(current.blocked_from_state))) ||
    (current.status !== 'blocked' && current.blocked_from_state !== null)
  ) {
    return `Session ${current.session_id} has an inconsistent blocked prior state.`;
  }

  if ((current.status === 'completed') !== (current.ended_at !== null)) {
    return `Session ${current.session_id} has inconsistent task and completion state.`;
  }

  const active = db.prepare(`SELECT task_id FROM active_sessions WHERE session_id = ?`).get(current.session_id) as
    { task_id: string } | undefined;
  if (
    (current.status === 'completed' && active) ||
    (current.status !== 'completed' && (!active || active.task_id !== current.task_id))
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
  persistTransitionIdempotency(db, input, 'rejected', null, result, new Date().toISOString());
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

function readNumericValue(db: DatabaseSync, sql: string, column: string) {
  const row = db.prepare(sql).get() as Record<string, number> | undefined;
  return row?.[column] ?? 0;
}

function readTextValue(db: DatabaseSync, sql: string, column: string) {
  const row = db.prepare(sql).get() as Record<string, string> | undefined;
  return row?.[column];
}
