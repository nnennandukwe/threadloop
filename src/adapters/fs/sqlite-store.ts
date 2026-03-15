import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { stateDataSchema, threadloopConfigSchema } from '../../schemas/state.js';
import type { ActiveState, Artifact, Entry, Session, StateData, Task, ThreadloopConfig } from '../../domain/types.js';
import { threadloopPaths } from './repo.js';

const CURRENT_SCHEMA_VERSION = 1;

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
};

type ActiveStateRow = {
  task_id: string;
  session_id: string;
};

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

  const db = openDatabase(repoRoot);
  try {
    bootstrapDatabase(db);
    migrateLegacyJsonState(db, repoRoot);
    assertSchemaVersion(db);
  } finally {
    db.close();
  }
}

export async function writeConfig(repoRoot: string, config: ThreadloopConfig) {
  const paths = threadloopPaths(repoRoot);
  await ensureThreadloopLayout(repoRoot);
  await writeJson(paths.configPath, config);
}

export async function readConfig(repoRoot: string): Promise<ThreadloopConfig> {
  const paths = threadloopPaths(repoRoot);
  const parsed = threadloopConfigSchema.safeParse(await readJson(paths.configPath));
  if (!parsed.success) {
    throw new Error('Invalid .threadloop/config.json');
  }
  return parsed.data;
}

export async function readState(repoRoot: string): Promise<StateData> {
  await ensureStateDatabase(repoRoot);

  const db = openDatabase(repoRoot);
  try {
    const state = loadState(db);
    const parsed = stateDataSchema.safeParse(state);
    if (!parsed.success) {
      throw new Error('Invalid .threadloop/state/state.db');
    }
    return parsed.data;
  } finally {
    db.close();
  }
}

export async function insertTaskSession(repoRoot: string, payload: { task: Task; session: Session; intentEntry: Entry }) {
  await ensureStateDatabase(repoRoot);

  const db = openDatabase(repoRoot);
  try {
    const insert = db.transaction(({ task, session, intentEntry }: { task: Task; session: Session; intentEntry: Entry }) => {
      const active = readActiveStateRow(db);
      if (active) {
        throw new Error('A session is already active in this repo. Finish it before starting another.');
      }

      insertTask(db, task);
      insertSession(db, session);
      insertEntry(db, intentEntry);
      db.prepare(
        `
          INSERT INTO active_state (id, task_id, session_id)
          VALUES (1, ?, ?)
        `,
      ).run(task.id, session.id);
    });

    insert.immediate(payload);
  } finally {
    db.close();
  }
}

export async function appendEntryToActiveSession(
  repoRoot: string,
  draft: Omit<Entry, 'sessionId'>,
): Promise<Entry> {
  await ensureStateDatabase(repoRoot);

  const db = openDatabase(repoRoot);
  try {
    const append = db.transaction((nextDraft: Omit<Entry, 'sessionId'>) => {
      const active = readActiveStateRow(db);
      if (!active) {
        throw new Error('No active session in this repo. Start one with `threadloop start`.');
      }

      const entry: Entry = { ...nextDraft, sessionId: active.session_id };
      insertEntry(db, entry);
      return entry;
    });

    return append.immediate(draft);
  } finally {
    db.close();
  }
}

export async function recordArtifact(repoRoot: string, artifact: Artifact) {
  await ensureStateDatabase(repoRoot);

  const db = openDatabase(repoRoot);
  try {
    const insert = db.transaction((nextArtifact: Artifact) => {
      insertArtifact(db, nextArtifact);
    });

    insert.immediate(artifact);
  } finally {
    db.close();
  }
}

export async function completeActiveSession(repoRoot: string, endedAt: string): Promise<ActiveState> {
  await ensureStateDatabase(repoRoot);

  const db = openDatabase(repoRoot);
  try {
    const finish = db.transaction((nextEndedAt: string) => {
      const active = readActiveStateRow(db);
      if (!active) {
        throw new Error('No active session in this repo. Start one with `threadloop start`.');
      }

      db.prepare(`UPDATE tasks SET status = 'completed' WHERE id = ?`).run(active.task_id);
      db.prepare(`UPDATE sessions SET ended_at = ? WHERE id = ?`).run(nextEndedAt, active.session_id);
      db.prepare(`DELETE FROM active_state WHERE id = 1`).run();

      return { taskId: active.task_id, sessionId: active.session_id };
    });

    return finish.immediate(endedAt);
  } finally {
    db.close();
  }
}

export async function writeArtifactFile(repoRoot: string, filename: string, content: string) {
  const paths = threadloopPaths(repoRoot);
  await mkdir(paths.artifactsDir, { recursive: true });
  const fullPath = path.join(paths.artifactsDir, filename);
  await writeFile(fullPath, content, 'utf8');
  return fullPath;
}

function openDatabase(repoRoot: string) {
  const { stateDbPath } = threadloopPaths(repoRoot);
  const db = new Database(stateDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

function bootstrapDatabase(db: Database.Database) {
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
      head_sha TEXT NOT NULL
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
      generated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS active_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS sessions_task_id_idx ON sessions(task_id);
    CREATE INDEX IF NOT EXISTS entries_session_id_idx ON entries(session_id);
    CREATE INDEX IF NOT EXISTS artifacts_session_id_idx ON artifacts(session_id);
  `);

  db.prepare(
    `
      INSERT INTO metadata (key, value)
      VALUES ('schema_version', ?)
      ON CONFLICT(key) DO NOTHING
    `,
  ).run(String(CURRENT_SCHEMA_VERSION));
}

function assertSchemaVersion(db: Database.Database) {
  const rawVersion = db.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).pluck().get() as
    | string
    | undefined;

  if (!rawVersion) {
    throw new Error('Missing ThreadLoop schema version metadata.');
  }

  const version = Number(rawVersion);
  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported ThreadLoop schema version: ${rawVersion}`);
  }
}

function migrateLegacyJsonState(db: Database.Database, repoRoot: string) {
  const { statePath } = threadloopPaths(repoRoot);
  if (!existsSync(statePath) || !databaseIsEmpty(db)) {
    return;
  }

  const parsed = stateDataSchema.safeParse(readJsonSync(statePath));
  if (!parsed.success) {
    throw new Error('Invalid .threadloop/state/state.json');
  }

  const legacyState = parsed.data;
  const migrate = db.transaction((state: StateData) => {
    for (const task of state.tasks) {
      insertTask(db, task);
    }

    for (const session of state.sessions) {
      insertSession(db, session);
    }

    for (const entry of state.entries) {
      insertEntry(db, entry);
    }

    for (const artifact of state.artifacts) {
      insertArtifact(db, artifact);
    }

    if (state.active) {
      db.prepare(
        `
          INSERT INTO active_state (id, task_id, session_id)
          VALUES (1, ?, ?)
        `,
      ).run(state.active.taskId, state.active.sessionId);
    }
  });

  migrate.immediate(legacyState);
}

function databaseIsEmpty(db: Database.Database) {
  const counts = db
    .prepare(
      `
        SELECT
          (SELECT COUNT(*) FROM tasks) AS tasks_count,
          (SELECT COUNT(*) FROM sessions) AS sessions_count,
          (SELECT COUNT(*) FROM entries) AS entries_count,
          (SELECT COUNT(*) FROM artifacts) AS artifacts_count,
          (SELECT COUNT(*) FROM active_state) AS active_count
      `,
    )
    .get() as {
      tasks_count: number;
      sessions_count: number;
      entries_count: number;
      artifacts_count: number;
      active_count: number;
    };

  return counts.tasks_count === 0
    && counts.sessions_count === 0
    && counts.entries_count === 0
    && counts.artifacts_count === 0
    && counts.active_count === 0;
}

function loadState(db: Database.Database): StateData {
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
    constraints: parseJsonText<string[]>(row.constraints_json),
    repoRoot: row.repo_root,
    status: row.status,
    createdAt: row.created_at,
  }));

  const sessions = (db
    .prepare(
      `
        SELECT id, task_id, started_at, ended_at, base_ref, branch, head_sha
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
    metadata: parseJsonText<Record<string, unknown>>(row.metadata_json),
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

  const activeRow = readActiveStateRow(db);
  const active = activeRow
    ? {
        taskId: activeRow.task_id,
        sessionId: activeRow.session_id,
      }
    : null;

  return { tasks, sessions, entries, artifacts, active };
}

function readActiveStateRow(db: Database.Database) {
  return db.prepare(`SELECT task_id, session_id FROM active_state WHERE id = 1`).get() as ActiveStateRow | undefined;
}

function insertTask(db: Database.Database, task: Task) {
  db.prepare(
    `
      INSERT INTO tasks (id, title, goal, constraints_json, repo_root, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(task.id, task.title, task.goal, JSON.stringify(task.constraints), task.repoRoot, task.status, task.createdAt);
}

function insertSession(db: Database.Database, session: Session) {
  db.prepare(
    `
      INSERT INTO sessions (id, task_id, started_at, ended_at, base_ref, branch, head_sha)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(session.id, session.taskId, session.startedAt, session.endedAt, session.baseRef, session.branch, session.headSha);
}

function insertEntry(db: Database.Database, entry: Entry) {
  db.prepare(
    `
      INSERT INTO entries (id, session_id, kind, body, metadata_json, created_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(entry.id, entry.sessionId, entry.kind, entry.body, JSON.stringify(entry.metadata), entry.createdAt, entry.source);
}

function insertArtifact(db: Database.Database, artifact: Artifact) {
  db.prepare(
    `
      INSERT INTO artifacts (id, session_id, kind, path, template_version, generated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
  ).run(
    artifact.id,
    artifact.sessionId,
    artifact.kind,
    artifact.path,
    artifact.templateVersion,
    artifact.generatedAt,
  );
}

function parseJsonText<T>(value: string): T {
  return JSON.parse(value) as T;
}

async function readJson(filePath: string) {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function readJsonSync(filePath: string) {
  const raw = readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
