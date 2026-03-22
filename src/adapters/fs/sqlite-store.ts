import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stateDataSchema, threadloopConfigSchema } from '../../schemas/state.js';
import type {
  ActiveState,
  Artifact,
  Entry,
  HeartbeatSource,
  Session,
  StateData,
  Task,
  ThreadloopConfig,
} from '../../domain/types.js';
import { threadloopPaths } from './repo.js';
import { DatabaseSync } from './sqlite-driver.js';

const CURRENT_SCHEMA_VERSION = 1;
const INVALID_CONFIG_ERROR = 'Invalid .threadloop/config.json';
const INVALID_STATE_JSON_ERROR = 'Invalid .threadloop/state/state.json';
const INVALID_STATE_DB_ERROR = 'Invalid .threadloop/state/state.db';
const SQLITE_BUSY_TIMEOUT_MS = 10_000;

class InvalidJsonError extends Error {}

type SetupState =
  | { status: 'unknown' }
  | { status: 'ready' }
  | { status: 'failed'; error: unknown };

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
  repo_root: string;
  status: Task['status'];
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
  if (getRepoConnectionState(repoRoot).setup.status === 'ready') {
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

export async function insertTaskSession(repoRoot: string, payload: { task: Task; session: Session; intentEntry: Entry }) {
  await withWriteTransaction(repoRoot, (db) => {
      const { task, session, intentEntry } = payload;
      insertTask(db, task);
      insertSession(db, session);
      insertEntry(db, intentEntry);
      insertActiveSession(db, { taskId: task.id, sessionId: session.id });
      syncActiveStateCompat(db);
  });
}

export async function appendEntryToActiveSession(
  repoRoot: string,
  draft: Omit<Entry, 'sessionId'>,
): Promise<Entry> {
  return withWriteTransaction(repoRoot, (db) => {
      const active = readActiveStateRow(db);
      if (!active) {
        throw new Error('No active session in this repo. Start one with `threadloop session start`.');
      }

      return appendEntry(db, active.session_id, draft);
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

export async function completeActiveSession(repoRoot: string, endedAt: string): Promise<ActiveState> {
  return withWriteTransaction(repoRoot, (db) => {
      const active = readActiveStateRow(db);
      if (!active) {
        throw new Error('No active session in this repo. Start one with `threadloop session start`.');
      }

      return completeSession(db, active.session_id, active.task_id, endedAt);
  });
}

export async function completeSessionById(repoRoot: string, sessionId: string, endedAt: string): Promise<ActiveState> {
  return withWriteTransaction(repoRoot, (db) => {
      const session = readSessionRow(db, sessionId);
      if (!session) {
        throw new Error(`Unknown session id: ${sessionId}`);
      }

      return completeSession(db, session.id, session.task_id, endedAt);
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
  });
}

export async function readRepoSnapshot(repoRoot: string, sessionId: string) {
  await ensureStateDatabase(repoRoot);

  const db = openReadDatabase(repoRoot);
  try {
    const row = db.prepare(
      `
        SELECT session_id, branch, head_sha, base_ref, changed_files_json, diff_stats_json, commit_range_json, reconciled_at
        FROM repo_snapshots
        WHERE session_id = ?
      `,
    ).get(sessionId) as { session_id: string; branch: string; head_sha: string; base_ref: string | null; changed_files_json: string; diff_stats_json: string; commit_range_json: string; reconciled_at: string } | undefined;

    if (!row) {
      return null;
    }

    return {
      sessionId: row.session_id,
      branch: row.branch,
      headSha: row.head_sha,
      baseRef: row.base_ref,
      changedFiles: parseJsonText<string[]>(row.changed_files_json, INVALID_STATE_DB_ERROR),
      diffStats: parseJsonText<{ files: number; insertions: number; deletions: number }>(row.diff_stats_json, INVALID_STATE_DB_ERROR),
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
    return;
  }

  if (state.setup.status === 'failed') {
    throw state.setup.error;
  }

  try {
    if (!databaseNeedsSetup(db, repoRoot)) {
      state.setup = { status: 'ready' };
      return;
    }

    db.exec('PRAGMA journal_mode = WAL');
    bootstrapDatabase(db);
    assertSchemaVersion(db);
    runInImmediateTransaction(db, () => {
      runPendingMigrations(db, repoRoot);
    });
    state.setup = { status: 'ready' };
  } catch (error) {
    state.setup = isTransientSqliteSetupError(error)
      ? { status: 'unknown' }
      : { status: 'failed', error };
    throw error;
  }
}

function isTransientSqliteSetupError(error: unknown): error is SqliteError {
  return isSqliteError(error)
    && error.errcode === 5
    && error.errstr === 'database is locked';
}

function isSqliteError(error: unknown): error is SqliteError {
  return error instanceof Error && (error as SqliteError).code === 'ERR_SQLITE_ERROR';
}

function databaseNeedsSetup(db: DatabaseSync, repoRoot: string) {
  if (!tableExists(db, 'metadata')) {
    return true;
  }

  const rawVersion = readTextValue(db, `SELECT value FROM metadata WHERE key = 'schema_version'`, 'value');
  if (!rawVersion || Number(rawVersion) !== CURRENT_SCHEMA_VERSION) {
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
  ];

  if (requiredTables.some((table) => !tableExists(db, table))) {
    return true;
  }

  const sessionColumns = new Set((db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((column) => column.name));
  if (!sessionColumns.has('last_heartbeat_at') || !sessionColumns.has('last_heartbeat_source')) {
    return true;
  }

  const activeState = readActiveStateRow(db);
  const activeSessions = readActiveSessionRows(db);
  if (activeSessions.length === 0) {
    if (activeState) {
      return true;
    }
  } else if (activeSessions.length === 1) {
    const [activeSession] = activeSessions;
    if (!activeState || activeState.session_id !== activeSession.session_id || activeState.task_id !== activeSession.task_id) {
      return true;
    }
  } else if (activeState) {
    return true;
  }

  const { statePath } = threadloopPaths(repoRoot);
  return existsSync(statePath) && databaseIsEmpty(db);
}

function tableExists(db: DatabaseSync, tableName: string) {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName) as
    | { name: string }
    | undefined;
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
      repo_root TEXT NOT NULL,
      status TEXT NOT NULL,
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

function runPendingMigrations(db: DatabaseSync, repoRoot: string) {
  ensureSessionHeartbeatColumns(db);
  migrateActiveStateRegistry(db);
  migrateLegacyJsonState(db, repoRoot);
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

function assertSchemaVersion(db: DatabaseSync) {
  const rawVersion = readTextValue(db, `SELECT value FROM metadata WHERE key = 'schema_version'`, 'value');

  if (!rawVersion) {
    throw new Error('Missing ThreadLoop schema version metadata.');
  }

  const version = Number(rawVersion);
  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported ThreadLoop schema version: ${rawVersion}`);
  }
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

  return counts.tasks_count === 0
    && counts.sessions_count === 0
    && counts.entries_count === 0
    && counts.artifacts_count === 0
    && counts.active_count === 0
    && counts.active_sessions_count === 0
    && counts.snapshots_count === 0;
}

function loadState(db: DatabaseSync): StateData {
  const tasks = (db
    .prepare(
      `
        SELECT id, title, goal, constraints_json, repo_root, status, created_at
        FROM tasks
        ORDER BY rowid
      `,
    )
    .all() as TaskRow[]).map((row) => ({
    id: row.id,
    title: row.title,
    goal: row.goal,
    constraints: parseJsonText<string[]>(row.constraints_json, INVALID_STATE_DB_ERROR),
    repoRoot: row.repo_root,
    status: row.status,
    createdAt: row.created_at,
  }));

  const sessions = (db
    .prepare(
      `
        SELECT id, task_id, started_at, ended_at, base_ref, branch, head_sha, last_heartbeat_at, last_heartbeat_source
        FROM sessions
        ORDER BY rowid
      `,
    )
    .all() as SessionRow[]).map((row) => ({
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

  const entries = (db
    .prepare(
      `
        SELECT id, session_id, kind, body, metadata_json, created_at, source
        FROM entries
        ORDER BY rowid
      `,
    )
    .all() as EntryRow[]).map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    body: row.body,
    metadata: parseJsonText<Record<string, unknown>>(row.metadata_json, INVALID_STATE_DB_ERROR),
    createdAt: row.created_at,
    source: row.source,
  }));

  const artifacts = (db
    .prepare(
      `
        SELECT id, session_id, kind, path, template_version, generated_at
        FROM artifacts
        ORDER BY rowid
      `,
    )
    .all() as ArtifactRow[]).map((row) => ({
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
  const active = activeSessions.length === 1 ? activeSessions[0] : null;

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

function insertTask(db: DatabaseSync, task: Task) {
  db.prepare(
    `
      INSERT INTO tasks (id, title, goal, constraints_json, repo_root, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(task.id, task.title, task.goal, JSON.stringify(task.constraints), task.repoRoot, task.status, task.createdAt);
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
  ).run(entry.id, entry.sessionId, entry.kind, entry.body, JSON.stringify(entry.metadata), entry.createdAt, entry.source);
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

function completeSession(db: DatabaseSync, sessionId: string, taskId: string, endedAt: string) {
  db.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run(taskId);
  db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(endedAt, sessionId);
  db.prepare(`DELETE FROM active_sessions WHERE session_id = ?`).run(sessionId);
  syncActiveStateCompat(db);

  return { taskId, sessionId };
}

function normalizeStateData(state: StateData): StateData {
  return {
    ...state,
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
    const [active] = activeSessions;
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
