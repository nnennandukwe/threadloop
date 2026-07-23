import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeEach, describe, expect, it } from 'vitest';
import * as sqliteStore from '../../src/adapters/fs/sqlite-store.js';
import { DatabaseSync } from '../../src/adapters/fs/sqlite-driver.js';
import { buildProtocolContract } from '../../src/contracts/protocol.js';

const execFileAsync = promisify(execFile);
const { appendEntryToSession, createId } = sqliteStore;

type SqliteStoreLifecycleHooks = typeof sqliteStore & {
  closeSqliteConnections?: () => void | Promise<void>;
  resetSqliteConnections?: () => void | Promise<void>;
};

const sqliteStoreLifecycle = sqliteStore as SqliteStoreLifecycleHooks;

const projectRoot = process.cwd();
const tsxCli = path.join(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = path.join(projectRoot, 'src/cli.ts');

async function runCli(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  return execFileAsync('node', [tsxCli, cliEntry, ...args], { cwd, env: env ? { ...process.env, ...env } : process.env });
}

async function runCliFailure(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  try {
    await runCli(cwd, args, env);
    throw new Error(`Expected CLI command to fail: ${args.join(' ')}`);
  } catch (error) {
    return error as Error & { stdout?: string; stderr?: string };
  }
}

async function readArtifact(repoDir: string, name: string) {
  return readFile(path.join(repoDir, `.threadloop/artifacts/${name}`), 'utf8');
}

async function readExcludeFile(repoDir: string) {
  return readFile(path.join(repoDir, '.git/info/exclude'), 'utf8');
}

function parseJsonOutput<T>(output: string) {
  return JSON.parse(output) as T;
}

function readStateSnapshot(repoDir: string) {
  const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });

  try {
    return {
      taskStatuses: db.prepare('SELECT status FROM tasks ORDER BY rowid').all().map((row) => String(row.status)),
      entryKinds: db.prepare('SELECT kind FROM entries ORDER BY rowid').all().map((row) => String(row.kind)),
      entryBodies: db.prepare('SELECT body FROM entries ORDER BY rowid').all().map((row) => String(row.body)),
    };
  } finally {
    db.close();
  }
}

function readStoredRepoSnapshot(repoDir: string, sessionId: string) {
  const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });

  try {
    const row = db
      .prepare(
        `
          SELECT branch, base_ref, changed_files_json
          FROM repo_snapshots
          WHERE session_id = ?
        `,
      )
      .get(sessionId) as { branch: string; base_ref: string | null; changed_files_json: string } | undefined;

    return row
      ? {
          branch: row.branch,
          baseRef: row.base_ref,
          changedFiles: JSON.parse(row.changed_files_json) as string[],
        }
      : null;
  } finally {
    db.close();
  }
}

async function resetSqliteConnectionLifecycle() {
  const { closeSqliteConnections, resetSqliteConnections } = sqliteStoreLifecycle;

  if (typeof closeSqliteConnections !== 'function') {
    throw new Error('Expected sqlite store to export closeSqliteConnections for lifecycle coverage.');
  }

  if (typeof resetSqliteConnections !== 'function') {
    throw new Error('Expected sqlite store to export resetSqliteConnections for lifecycle coverage.');
  }

  await Promise.resolve(closeSqliteConnections());
  await Promise.resolve(resetSqliteConnections());
}

async function runConcurrentMutationBurst(repoDir: string, sessionId: string, label: string) {
  const captureBodies = Array.from({ length: 8 }, (_, index) => `${label} capture ${index + 1}`);
  const agentBodies = Array.from({ length: 4 }, (_, index) => `${label} agent capture ${index + 1}`);
  const heartbeatSources = ['cli', 'daemon', 'reconcile', 'daemon'] as const;

  await Promise.all([
    ...captureBodies.map((body, index) =>
      runCli(repoDir, [
        'session',
        'capture',
        index % 2 === 0 ? 'note' : 'decision',
        body,
        '--session',
        sessionId,
        '--json',
      ]),
    ),
    ...agentBodies.map((body) =>
      appendEntryToSession(repoDir, sessionId, {
        id: createId('entry'),
        kind: 'note',
        body,
        metadata: { mode: 'agent' },
        createdAt: new Date().toISOString(),
        source: 'agent',
      }),
    ),
    ...heartbeatSources.map((source) =>
      runCli(repoDir, ['session', 'heartbeat', '--session', sessionId, '--source', source, '--json']),
    ),
    ...Array.from({ length: 4 }, () => runCli(repoDir, ['session', 'reconcile', '--session', sessionId, '--json'])),
  ]);

  const status = parseJsonOutput<{
    data: {
      session: { last_heartbeat_at: string | null; last_heartbeat_source: string | null };
      entries: { count: number; kinds: Record<string, number> };
    };
  }>((await runCli(repoDir, ['session', 'status', '--session', sessionId, '--json'])).stdout);

  expect(status.data.entries.count).toBe(1 + captureBodies.length + agentBodies.length);
  expect(status.data.entries.kinds.intent).toBe(1);
  expect(status.data.entries.kinds.note).toBe(4 + agentBodies.length);
  expect(status.data.entries.kinds.decision).toBe(4);
  expect(status.data.session.last_heartbeat_at).toBeTruthy();
  expect(['cli', 'daemon', 'reconcile']).toContain(status.data.session.last_heartbeat_source);

  const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
  try {
    const entries = db.prepare(`SELECT body, source FROM entries WHERE session_id = ? ORDER BY rowid`).all(sessionId) as Array<{
      body: string;
      source: string;
    }>;
    const snapshotCount = readParameterizedCount(
      db,
      `SELECT COUNT(*) AS count FROM repo_snapshots WHERE session_id = ?`,
      sessionId,
    );
    const bodies = entries.map((entry) => entry.body);

    expect(bodies).toContain(`Task started: ${label}`);
    expect(bodies.filter((body) => captureBodies.includes(body))).toHaveLength(captureBodies.length);
    expect(new Set(bodies.filter((body) => captureBodies.includes(body)))).toEqual(new Set(captureBodies));
    expect(bodies.filter((body) => agentBodies.includes(body))).toHaveLength(agentBodies.length);
    expect(new Set(bodies.filter((body) => agentBodies.includes(body)))).toEqual(new Set(agentBodies));
    expect(entries.filter((entry) => agentBodies.includes(entry.body)).every((entry) => entry.source === 'agent')).toBe(true);
    expect(snapshotCount).toBe(1);
  } finally {
    db.close();
  }
}

describe('threadloop CLI', { timeout: 15_000 }, () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(os.tmpdir(), 'threadloop-'));
    await execFileAsync('git', ['init'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  });

  it('initializes, starts, captures, generates an artifact, and finishes', async () => {
    await runCli(repoDir, ['init']);
    await runCli(repoDir, ['start', 'Add retry logic', '--goal', 'Reduce transient failures']);
    await runCli(repoDir, ['capture', 'decision', 'Retry only idempotent jobs', '--because', 'Non-idempotent replay is unsafe']);
    await runCli(repoDir, ['artifact', 'generate']);
    await runCli(repoDir, ['finish']);

    const artifact = await readArtifact(repoDir, 'add-retry-logic.change-brief.md');
    expect(artifact).toContain('# Add retry logic');
    expect(artifact).toContain('Retry only idempotent jobs');

    expect(existsSync(path.join(repoDir, '.threadloop/state/state.db'))).toBe(true);
    const snapshot = readStateSnapshot(repoDir);
    expect(snapshot.taskStatuses).toContain('completed');
    expect(snapshot.entryKinds).toContain('decision');
  });

  it('auto-initializes on session start and records initial actor and issue metadata', async () => {
    const started = parseJsonOutput<{
      data: {
        session_id: string;
        task: { id: string; issueRef: string | null };
        session: { id: string };
      };
    }>(
      (
        await runCli(repoDir, [
          'session',
          'start',
          'Bootstrap task',
          '--goal',
          'Allow zero-touch agent startup',
          '--issue',
          'ISSUE-42',
          '--actor',
          'agent',
          '--json',
        ])
      ).stdout,
    );

    expect(started.data.task.issueRef).toBe('ISSUE-42');
    expect(existsSync(path.join(repoDir, '.threadloop/config.json'))).toBe(true);
    expect(existsSync(path.join(repoDir, '.threadloop/state/state.db'))).toBe(true);
    expect(existsSync(path.join(repoDir, '.gitignore'))).toBe(false);

    const exclude = await readExcludeFile(repoDir);
    expect(exclude).toContain('.threadloop/state/');

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      const taskRow = db.prepare(`SELECT issue_ref FROM tasks WHERE id = ?`).get(started.data.task.id) as { issue_ref: string | null } | undefined;
      const entries = db.prepare(`SELECT kind, source FROM entries WHERE session_id = ? ORDER BY rowid`).all(started.data.session_id) as Array<{
        kind: string;
        source: string;
      }>;
      const snapshotCount = readParameterizedCount(
        db,
        `SELECT COUNT(*) AS count FROM repo_snapshots WHERE session_id = ?`,
        started.data.session_id,
      );

      expect(taskRow?.issue_ref).toBe('ISSUE-42');
      expect(entries[0]).toMatchObject({ kind: 'intent', source: 'agent' });
      expect(snapshotCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it('defaults an omitted session base to main when the ref exists', async () => {
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'main baseline'], { cwd: repoDir });
    await execFileAsync('git', ['branch', '-M', 'main'], { cwd: repoDir });
    await execFileAsync('git', ['switch', '-c', 'threadloop/default-base'], { cwd: repoDir });

    const started = parseJsonOutput<{
      data: {
        session_id: string;
        session: { baseRef: string | null };
      };
    }>(
      (
        await runCli(repoDir, [
          'session',
          'start',
          'Default base task',
          '--goal',
          'Match the published workflow contract',
          '--json',
        ])
      ).stdout,
    );

    expect(started.data.session.baseRef).toBe('main');
    expect(readStoredRepoSnapshot(repoDir, started.data.session_id)?.baseRef).toBe('main');
  });

  it('migrates legacy state.json into SQLite and keeps the JSON file as backup', async () => {
    const legacyState = {
      tasks: [
        {
          id: 'task_legacy',
          title: 'Legacy task',
          goal: 'Preserve v1 data',
          constraints: ['Keep history intact'],
          repoRoot: repoDir,
          status: 'active',
          createdAt: '2026-03-14T12:00:00.000Z',
        },
      ],
      sessions: [
        {
          id: 'session_legacy',
          taskId: 'task_legacy',
          startedAt: '2026-03-14T12:00:00.000Z',
          endedAt: null,
          baseRef: null,
          branch: 'master',
          headSha: 'HEAD',
        },
      ],
      entries: [
        {
          id: 'entry_legacy',
          sessionId: 'session_legacy',
          kind: 'decision',
          body: 'Legacy decision',
          metadata: { because: 'Existing repo state' },
          createdAt: '2026-03-14T12:01:00.000Z',
          source: 'cli',
        },
      ],
      artifacts: [],
      active: {
        taskId: 'task_legacy',
        sessionId: 'session_legacy',
      },
    };

    await mkdir(path.join(repoDir, '.threadloop/state'), { recursive: true });
    await writeFile(
      path.join(repoDir, '.threadloop/config.json'),
      `${JSON.stringify({ version: 1, createdAt: '2026-03-14T12:00:00.000Z' }, null, 2)}\n`,
      'utf8',
    );
    await writeFile(path.join(repoDir, '.threadloop/state/state.json'), `${JSON.stringify(legacyState, null, 2)}\n`, 'utf8');

    const status = await runCli(repoDir, ['status']);
    await runCli(repoDir, ['capture', 'note', 'Migrated capture still works']);
    await runCli(repoDir, ['finish']);

    expect(status.stdout).toContain('Task: Legacy task');
    expect(existsSync(path.join(repoDir, '.threadloop/state/state.db'))).toBe(true);

    const snapshot = readStateSnapshot(repoDir);
    expect(snapshot.taskStatuses).toEqual(['completed']);
    expect(snapshot.entryBodies).toContain('Legacy decision');
    expect(snapshot.entryBodies).toContain('Migrated capture still works');

    const legacyBackup = await readFile(path.join(repoDir, '.threadloop/state/state.json'), 'utf8');
    expect(legacyBackup).toContain('Legacy decision');
  });

  it('migrates schema v1 task lifecycle state without losing active-session compatibility', async () => {
    await mkdir(path.join(repoDir, '.threadloop/state'), { recursive: true });
    await writeFile(
      path.join(repoDir, '.threadloop/config.json'),
      `${JSON.stringify({ version: 1, createdAt: '2026-07-23T12:00:00.000Z' }, null, 2)}\n`,
      'utf8',
    );
    const dbPath = path.join(repoDir, '.threadloop/state/state.db');
    const db = new DatabaseSync(dbPath);
    const now = '2026-07-23T12:00:00.000Z';

    try {
      db.exec(`
        CREATE TABLE metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          goal TEXT NOT NULL,
          constraints_json TEXT NOT NULL,
          issue_ref TEXT,
          repo_root TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE sessions (
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

        CREATE TABLE entries (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          body TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          source TEXT NOT NULL
        );

        CREATE TABLE artifacts (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          path TEXT NOT NULL,
          template_version TEXT NOT NULL,
          generated_at TEXT NOT NULL,
          snapshot_source TEXT
        );

        CREATE TABLE active_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
        );

        CREATE TABLE active_sessions (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE
        );

        CREATE TABLE repo_snapshots (
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
      db.prepare(`INSERT INTO metadata (key, value) VALUES ('schema_version', '1')`).run();
      db.prepare(
        `
          INSERT INTO tasks (id, title, goal, constraints_json, issue_ref, repo_root, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run('task_active', 'Active v1 task', 'Migrate to queued', '[]', null, repoDir, 'active', now);
      db.prepare(
        `
          INSERT INTO sessions (id, task_id, started_at, ended_at, base_ref, branch, head_sha, last_heartbeat_at, last_heartbeat_source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run('session_active', 'task_active', now, null, null, 'feature/lifecycle', 'abc123', null, null);

      db.prepare(
        `
          INSERT INTO tasks (id, title, goal, constraints_json, issue_ref, repo_root, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run('task_completed', 'Completed v1 task', 'Remain completed', '[]', null, repoDir, 'completed', now);
      db.prepare(
        `
          INSERT INTO sessions (id, task_id, started_at, ended_at, base_ref, branch, head_sha, last_heartbeat_at, last_heartbeat_source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run('session_completed', 'task_completed', now, now, null, 'feature/done', 'def456', null, null);

      const taskColumns = db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>;
      expect(taskColumns.map((column) => column.name)).not.toContain('state_version');
    } finally {
      db.close();
    }

    const status = parseJsonOutput<{
      data: {
        task: { status: string; state_version: number };
      };
    }>((await runCli(repoDir, ['session', 'status', '--session', 'session_active', '--json'])).stdout);

    expect(status.data.task).toMatchObject({ status: 'queued', state_version: 0 });

    const migrated = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const schemaVersion = migrated.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get() as
        | { value: string }
        | undefined;
      expect(schemaVersion?.value).toBe('2');
      expect(
        migrated.prepare(`SELECT id, status, state_version FROM tasks ORDER BY id`).all(),
      ).toEqual([
        { id: 'task_active', status: 'queued', state_version: 0 },
        { id: 'task_completed', status: 'completed', state_version: 0 },
      ]);
      expect(readScalarCount(migrated, 'SELECT COUNT(*) AS count FROM active_sessions')).toBe(1);
    } finally {
      migrated.close();
    }
  });

  it('rejects unsupported schema metadata before migrating legacy state', async () => {
    const legacyState = {
      tasks: [
        {
          id: 'task_legacy',
          title: 'Legacy task',
          goal: 'Preserve v1 data',
          constraints: [],
          repoRoot: repoDir,
          status: 'active',
          createdAt: '2026-03-14T12:00:00.000Z',
        },
      ],
      sessions: [
        {
          id: 'session_legacy',
          taskId: 'task_legacy',
          startedAt: '2026-03-14T12:00:00.000Z',
          endedAt: null,
          baseRef: null,
          branch: 'master',
          headSha: 'HEAD',
        },
      ],
      entries: [],
      artifacts: [],
      active: {
        taskId: 'task_legacy',
        sessionId: 'session_legacy',
      },
    };

    await mkdir(path.join(repoDir, '.threadloop/state'), { recursive: true });
    await writeFile(
      path.join(repoDir, '.threadloop/config.json'),
      `${JSON.stringify({ version: 1, createdAt: '2026-03-14T12:00:00.000Z' }, null, 2)}\n`,
      'utf8',
    );
    await writeFile(path.join(repoDir, '.threadloop/state/state.json'), `${JSON.stringify(legacyState, null, 2)}\n`, 'utf8');

    const dbPath = path.join(repoDir, '.threadloop/state/state.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        goal TEXT NOT NULL,
        constraints_json TEXT NOT NULL,
        repo_root TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        base_ref TEXT,
        branch TEXT NOT NULL,
        head_sha TEXT NOT NULL
      );

      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        source TEXT NOT NULL
      );

      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        template_version TEXT NOT NULL,
        generated_at TEXT NOT NULL
      );

      CREATE TABLE active_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL
      );
    `);
    db.prepare(`INSERT INTO metadata (key, value) VALUES ('schema_version', '0')`).run();
    db.prepare(`INSERT INTO active_state (id, task_id, session_id) VALUES (1, 'task_legacy', 'session_legacy')`).run();
    db.close();

    await expect(runCli(repoDir, ['status'])).rejects.toThrow('Unsupported ThreadLoop schema version: 0');

    const migratedDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(readScalarCount(migratedDb, 'SELECT COUNT(*) AS count FROM tasks')).toBe(0);
      expect(readScalarCount(migratedDb, 'SELECT COUNT(*) AS count FROM active_sessions')).toBe(0);
      const sessionColumns = migratedDb.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
      expect(sessionColumns.map((column) => column.name)).not.toContain('last_heartbeat_at');
      expect(sessionColumns.map((column) => column.name)).not.toContain('last_heartbeat_source');
    } finally {
      migratedDb.close();
    }

    const legacyBackup = await readFile(path.join(repoDir, '.threadloop/state/state.json'), 'utf8');
    expect(legacyBackup).toContain('Legacy task');
  });

  it('reports malformed config JSON with the ThreadLoop error message', async () => {
    await mkdir(path.join(repoDir, '.threadloop/state'), { recursive: true });
    await writeFile(path.join(repoDir, '.threadloop/config.json'), '{not-json\n', 'utf8');

    await expect(runCli(repoDir, ['status'])).rejects.toThrow('Invalid .threadloop/config.json');
  });

  it('reports malformed legacy state JSON with the ThreadLoop error message', async () => {
    await mkdir(path.join(repoDir, '.threadloop/state'), { recursive: true });
    await writeFile(
      path.join(repoDir, '.threadloop/config.json'),
      `${JSON.stringify({ version: 1, createdAt: '2026-03-14T12:00:00.000Z' }, null, 2)}\n`,
      'utf8',
    );
    await writeFile(path.join(repoDir, '.threadloop/state/state.json'), '{not-json\n', 'utf8');

    await expect(runCli(repoDir, ['status'])).rejects.toThrow('Invalid .threadloop/state/state.json');
  });

  it('reports malformed SQLite JSON columns with the ThreadLoop error message', async () => {
    await runCli(repoDir, ['init']);
    await runCli(repoDir, ['start', 'Add retry logic', '--goal', 'Reduce transient failures']);

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'));
    db.prepare(`UPDATE tasks SET constraints_json = '{not-json'`).run();
    db.close();

    await expect(runCli(repoDir, ['status'])).rejects.toThrow('Invalid .threadloop/state/state.db');
  });

  it('supports capture via $EDITOR and alternate artifact renderers', async () => {
    const editorScript = path.join(repoDir, 'fake-editor.sh');
    await writeFile(editorScript, '#!/bin/sh\nprintf "Reviewer should inspect retry cancellation path" > "$1"\n', 'utf8');
    await execFileAsync('chmod', ['+x', editorScript], { cwd: repoDir });

    await runCli(repoDir, ['init']);
    await runCli(repoDir, ['start', 'Add retry logic', '--goal', 'Reduce transient failures']);
    await runCli(repoDir, ['capture', 'reviewer_guidance', '--edit'], { EDITOR: `sh ${editorScript}` });
    await runCli(repoDir, ['artifact', 'generate', 'pr-summary']);
    await runCli(repoDir, ['artifact', 'generate', 'handoff']);

    const prSummary = await readArtifact(repoDir, 'add-retry-logic.pr-summary.md');
    const handoff = await readArtifact(repoDir, 'add-retry-logic.handoff.md');

    expect(prSummary).toContain('# PR Summary: Add retry logic');
    expect(prSummary).toContain('Reviewer should inspect retry cancellation path');
    expect(handoff).toContain('# Handoff: Add retry logic');
  });

  it('renders branch, base ref, issue ref, and closing reference in pr-summary artifacts', async () => {
    await writeFile(path.join(repoDir, 'base.txt'), 'base\n', 'utf8');
    await execFileAsync('git', ['add', 'base.txt'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'base commit'], { cwd: repoDir });
    await execFileAsync('git', ['branch', '-M', 'main'], { cwd: repoDir });

    const started = parseJsonOutput<{ data: { session_id: string } }>(
      (
        await runCli(repoDir, [
          'session',
          'start',
          'Prepare PR summary',
          '--goal',
          'Render PR metadata',
          '--base',
          'main',
          '--issue',
          'ISSUE-18',
          '--json',
        ])
      ).stdout,
    );

    await writeFile(path.join(repoDir, 'feature.ts'), 'export const feature = 18;\n', 'utf8');
    await runCli(repoDir, ['session', 'capture', 'decision', 'Keep the summary PR-ready', '--session', started.data.session_id, '--json']);
    await runCli(repoDir, ['artifact', 'generate', 'pr-summary', '--session', started.data.session_id, '--json']);

    const prSummary = await readArtifact(repoDir, 'prepare-pr-summary.pr-summary.md');
    expect(prSummary).toContain('issue_ref: ISSUE-18');
    expect(prSummary).toContain('## PR metadata');
    expect(prSummary).toContain('- Branch: main');
    expect(prSummary).toContain('- Base ref: main');
    expect(prSummary).toContain('- Issue: ISSUE-18');
    expect(prSummary).toContain('- Closing reference: Closes ISSUE-18');
  });

  it('uses a live snapshot when generating an artifact for an active session', async () => {
    const started = parseJsonOutput<{
      data: { session_id: string };
    }>(
      (await runCli(repoDir, ['session', 'start', 'Live snapshot artifact', '--goal', 'Use current repo scope', '--json'])).stdout,
    );

    await writeFile(path.join(repoDir, 'active-change.ts'), 'export const activeChange = true;\n', 'utf8');

    const artifact = parseJsonOutput<{
      data: { artifact: { snapshotSource: string } };
    }>((await runCli(repoDir, ['artifact', 'generate', '--session', started.data.session_id, '--json'])).stdout);
    const storedSnapshot = readStoredRepoSnapshot(repoDir, started.data.session_id);
    const renderedArtifact = await readArtifact(repoDir, 'live-snapshot-artifact.change-brief.md');

    expect(artifact.data.artifact.snapshotSource).toBe('live');
    expect(storedSnapshot?.changedFiles).toContain('active-change.ts');
    expect(renderedArtifact).toContain('active-change.ts');
  });

  it('creates .git/info/exclude on init when missing', async () => {
    await rm(path.join(repoDir, '.git/info/exclude'));
    const result = await runCli(repoDir, ['init']);
    const exclude = await readExcludeFile(repoDir);

    expect(result.stdout).toContain('Initialized ThreadLoop');
    expect(result.stdout).toContain('Created .git/info/exclude and added .threadloop/state/');
    expect(exclude).toContain('.threadloop/state/');
  });

  it('updates existing .git/info/exclude without duplicating the state entry', async () => {
    await writeFile(path.join(repoDir, '.git/info/exclude'), '*.log\n', 'utf8');

    const first = await runCli(repoDir, ['init']);
    const second = await runCli(repoDir, ['init']);
    const exclude = await readExcludeFile(repoDir);

    expect(first.stdout).toContain('Updated .git/info/exclude to ignore .threadloop/state/');
    expect(second.stdout).toContain('.git/info/exclude already ignores .threadloop/state/');
    expect(exclude.match(/\.threadloop\/state\//g)?.length).toBe(1);
  });

  it('leaves tracked .gitignore unchanged and uses .git/info/exclude for ThreadLoop state', async () => {
    await writeFile(path.join(repoDir, '.gitignore'), 'node_modules/\n', 'utf8');

    const result = await runCli(repoDir, ['init']);
    const gitignore = await readFile(path.join(repoDir, '.gitignore'), 'utf8');
    const exclude = await readExcludeFile(repoDir);

    expect(result.stdout).toContain('.git/info/exclude');
    expect(gitignore).toBe('node_modules/\n');
    expect(exclude).toContain('.threadloop/state/');
  });

  it('filters ThreadLoop-owned paths from artifact scope without a base ref', async () => {
    await runCli(repoDir, ['init']);
    await writeFile(path.join(repoDir, 'feature.ts'), 'export const feature = true;\n', 'utf8');
    await runCli(repoDir, ['start', 'Track feature work', '--goal', 'Keep scope clean']);
    await runCli(repoDir, ['capture', 'note', 'Only repo files should appear in scope']);
    await runCli(repoDir, ['artifact', 'generate']);

    const artifact = await readArtifact(repoDir, 'track-feature-work.change-brief.md');
    expect(artifact).toContain('feature.ts');
    expect(artifact).not.toContain('.threadloop/config.json');
    expect(artifact).not.toContain('.threadloop/state/state.json');
    expect(artifact).not.toContain('.threadloop/state/state.db');
    expect(artifact).not.toContain('.threadloop/artifacts/');
  });

  it('filters ThreadLoop-owned paths from artifact scope with a base ref', async () => {
    await writeFile(path.join(repoDir, 'base.txt'), 'base\n', 'utf8');
    await execFileAsync('git', ['add', 'base.txt'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'base commit'], { cwd: repoDir });
    await execFileAsync('git', ['branch', '-M', 'main'], { cwd: repoDir });
    await execFileAsync('git', ['checkout', '-b', 'feature/threadloop'], { cwd: repoDir });

    await runCli(repoDir, ['init']);
    await writeFile(path.join(repoDir, 'feature.ts'), 'export const feature = 2;\n', 'utf8');
    await execFileAsync('git', ['add', 'feature.ts'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'feature commit'], { cwd: repoDir });

    await runCli(repoDir, ['start', 'Base-aware scope', '--goal', 'Filter internal paths', '--base', 'main']);
    await runCli(repoDir, ['artifact', 'generate']);

    const artifact = await readArtifact(repoDir, 'base-aware-scope.change-brief.md');
    expect(artifact).toContain('feature.ts');
    expect(artifact).not.toContain('.threadloop/');
  });

  it('persists a final snapshot on session finish without a separate reconcile', async () => {
    const started = parseJsonOutput<{ data: { session_id: string } }>(
      (await runCli(repoDir, ['session', 'start', 'Finish snapshot', '--goal', 'Persist closeout snapshot', '--json'])).stdout,
    );

    await writeFile(path.join(repoDir, 'closeout.ts'), 'export const closeout = true;\n', 'utf8');
    await runCli(repoDir, ['session', 'finish', '--session', started.data.session_id, '--json']);

    const snapshot = readStoredRepoSnapshot(repoDir, started.data.session_id);
    expect(snapshot?.changedFiles).toContain('closeout.ts');
  });

  it('fails cleanly for a missing base ref', async () => {
    await runCli(repoDir, ['init']);
    await expect(runCli(repoDir, ['start', 'Add retry logic', '--goal', 'Reduce transient failures', '--base', 'missing-branch'])).rejects.toThrow();
  });

  it('fails with SESSION_REQUIRED when legacy status has no active session', async () => {
    await runCli(repoDir, ['init']);

    const failure = await runCliFailure(repoDir, ['status']);
    expect(failure.stderr).toContain('threadloop [SESSION_REQUIRED]: No active session.');
    expect(failure.stderr).toContain('Hint: Start one with `threadloop session start`.');
  });

  it('supports legacy wrapper commands with explicit session targeting and json envelopes', async () => {
    await runCli(repoDir, ['init']);

    const first = parseJsonOutput<{ data: { session_id: string } }>(
      (await runCli(repoDir, ['session', 'start', 'First task', '--goal', 'Track first task', '--json'])).stdout,
    );
    const second = parseJsonOutput<{ data: { session_id: string } }>(
      (await runCli(repoDir, ['session', 'start', 'Second task', '--goal', 'Track second task', '--json'])).stdout,
    );

    const captured = parseJsonOutput<{
      ok: true;
      command: string;
      data: { session_id: string; entry: { kind: string; body: string; source: string } };
    }>(
      (
        await runCli(repoDir, [
          'capture',
          'decision',
          'Target the first session explicitly',
          '--session',
          first.data.session_id,
          '--json',
        ])
      ).stdout,
    );
    expect(captured).toMatchObject({
      ok: true,
      command: 'capture',
      data: {
        session_id: first.data.session_id,
        entry: { kind: 'decision', body: 'Target the first session explicitly' },
      },
    });

    const status = parseJsonOutput<{
      ok: true;
      command: string;
      data: { session_id: string; entries: { count: number; kinds: Record<string, number> } };
    }>((await runCli(repoDir, ['status', '--session', first.data.session_id, '--json'])).stdout);
    expect(status).toMatchObject({ ok: true, command: 'status' });
    expect(status.data.session_id).toBe(first.data.session_id);
    expect(status.data.entries.count).toBe(2);
    expect(status.data.entries.kinds.intent).toBe(1);
    expect(status.data.entries.kinds.decision).toBe(1);

    const artifact = parseJsonOutput<{
      ok: true;
      command: string;
      data: { session_id: string; artifact: { kind: string; path: string } };
    }>((await runCli(repoDir, ['artifact', 'generate', '--session', first.data.session_id, '--json'])).stdout);
    expect(artifact).toMatchObject({
      ok: true,
      command: 'artifact generate',
      data: {
        session_id: first.data.session_id,
        artifact: { kind: 'change-brief' },
      },
    });
    expect(artifact.data.artifact.path).toContain('first-task.change-brief.md');

    const finished = parseJsonOutput<{
      ok: true;
      command: string;
      data: { session_id: string };
    }>((await runCli(repoDir, ['finish', '--session', first.data.session_id, '--json'])).stdout);
    expect(finished).toMatchObject({
      ok: true,
      command: 'finish',
      data: { session_id: first.data.session_id },
    });

    const secondStatus = await runCli(repoDir, ['status', '--session', second.data.session_id]);
    expect(secondStatus.stdout).toContain(`Session: ${second.data.session_id}`);
  });

  it('fails legacy wrapper commands cleanly when multiple sessions are active and no session is selected', async () => {
    await runCli(repoDir, ['init']);
    await runCli(repoDir, ['session', 'start', 'First task', '--goal', 'Track first task']);
    await runCli(repoDir, ['session', 'start', 'Second task', '--goal', 'Track second task']);

    const captureFailure = parseJsonOutput<{ error: { code: string } }>(
      (await runCliFailure(repoDir, ['capture', 'decision', 'Ambiguous capture', '--json'])).stderr ?? '',
    );
    expect(captureFailure.error.code).toBe('SESSION_AMBIGUOUS');

    const statusFailure = parseJsonOutput<{ error: { code: string } }>(
      (await runCliFailure(repoDir, ['status', '--json'])).stderr ?? '',
    );
    expect(statusFailure.error.code).toBe('SESSION_AMBIGUOUS');

    const artifactFailure = parseJsonOutput<{ error: { code: string } }>(
      (await runCliFailure(repoDir, ['artifact', 'generate', '--json'])).stderr ?? '',
    );
    expect(artifactFailure.error.code).toBe('SESSION_AMBIGUOUS');

    const finishFailure = parseJsonOutput<{ error: { code: string } }>(
      (await runCliFailure(repoDir, ['finish', '--json'])).stderr ?? '',
    );
    expect(finishFailure.error.code).toBe('SESSION_AMBIGUOUS');
  });

  it('blocks legacy root start when a session is already active', async () => {
    await runCli(repoDir, ['init']);

    const started = parseJsonOutput<{ ok: true; command: string; data: { session_id: string } }>(
      (await runCli(repoDir, ['start', 'Legacy task', '--goal', 'Use the compatibility wrapper', '--json'])).stdout,
    );
    expect(started).toMatchObject({ ok: true, command: 'start' });

    const failed = parseJsonOutput<{ ok: false; command: string; error: { code: string } }>(
      (await runCliFailure(repoDir, ['start', 'Another legacy task', '--goal', 'Should fail', '--json'])).stderr ?? '',
    );
    expect(failed).toMatchObject({
      ok: false,
      command: 'start',
      error: { code: 'SESSION_AMBIGUOUS' },
    });
  });

  it('fails cleanly outside a git repository', async () => {
    const nonRepoDir = await mkdtemp(path.join(os.tmpdir(), 'threadloop-no-git-'));
    await expect(runCli(nonRepoDir, ['init'])).rejects.toThrow();
  });

  it('supports explicit session commands and stable json envelopes', async () => {
    await runCli(repoDir, ['init']);

    const started = parseJsonOutput<{
      ok: true;
      command: string;
      data: { session_id: string; task_id: string; task: { issueRef: string | null } };
    }>(
      (
        await runCli(repoDir, [
          'session',
          'start',
          'Explicit task',
          '--goal',
          'Track the explicit session',
          '--issue',
          'ISSUE-7',
          '--actor',
          'agent',
          '--json',
        ])
      ).stdout,
    );

    expect(started).toMatchObject({ ok: true, command: 'session start' });
    expect(started.data.session_id).toBeTruthy();
    expect(started.data.task.issueRef).toBe('ISSUE-7');

    const listed = parseJsonOutput<{
      ok: true;
      command: string;
      data: { sessions: Array<{ session_id: string; active: boolean }> };
    }>((await runCli(repoDir, ['session', 'list', '--json'])).stdout);
    expect(listed).toMatchObject({ ok: true, command: 'session list' });
    expect(listed.data.sessions).toHaveLength(1);
    expect(listed.data.sessions[0]).toMatchObject({ session_id: started.data.session_id, active: true });

    const captured = parseJsonOutput<{
      ok: true;
      command: string;
      data: { session_id: string; entry: { kind: string; body: string } };
    }>(
      (
        await runCli(repoDir, [
          'session',
          'capture',
          'decision',
          'Keep the explicit contract',
          '--session',
          started.data.session_id,
          '--because',
          'Machine consumers need a stable envelope',
          '--actor',
          'agent',
          '--json',
        ])
      ).stdout,
    );
    expect(captured).toMatchObject({ ok: true, command: 'session capture' });
    expect(captured.data.session_id).toBe(started.data.session_id);
    expect(captured.data.entry).toMatchObject({ kind: 'decision', body: 'Keep the explicit contract', source: 'agent' });

    const heartbeat = parseJsonOutput<{
      ok: true;
      command: string;
      data: { session_id: string; session: { last_heartbeat_at: string | null; last_heartbeat_source: string | null } };
    }>((await runCli(repoDir, ['session', 'heartbeat', '--session', started.data.session_id, '--source', 'cli', '--json'])).stdout);
    expect(heartbeat).toMatchObject({ ok: true, command: 'session heartbeat' });
    expect(heartbeat.data.session_id).toBe(started.data.session_id);
    expect(heartbeat.data.session.last_heartbeat_at).toBeTruthy();
    expect(heartbeat.data.session.last_heartbeat_source).toBe('cli');

    const status = parseJsonOutput<{
      ok: true;
      command: string;
      data: {
        session_id: string;
        entries: { count: number; kinds: Record<string, number> };
        session: { ended_at: string | null };
        task: { issue_ref: string | null };
      };
    }>((await runCli(repoDir, ['session', 'status', '--session', started.data.session_id, '--json'])).stdout);
    expect(status).toMatchObject({ ok: true, command: 'session status' });
    expect(status.data.session_id).toBe(started.data.session_id);
    expect(status.data.entries.count).toBe(2);
    expect(status.data.entries.kinds.intent).toBe(1);
    expect(status.data.entries.kinds.decision).toBe(1);
    expect(status.data.task.issue_ref).toBe('ISSUE-7');

    const finished = parseJsonOutput<{
      ok: true;
      command: string;
      data: { session_id: string; task_id: string };
    }>((await runCli(repoDir, ['session', 'finish', '--session', started.data.session_id, '--json'])).stdout);
    expect(finished).toMatchObject({ ok: true, command: 'session finish' });
    expect(finished.data.session_id).toBe(started.data.session_id);

    const relisted = parseJsonOutput<{
      ok: true;
      command: string;
      data: { sessions: Array<{ session_id: string; active: boolean; ended_at: string | null }> };
    }>((await runCli(repoDir, ['session', 'list', '--json'])).stdout);
    expect(relisted.data.sessions).toHaveLength(1);
    expect(relisted.data.sessions[0]).toMatchObject({
      session_id: started.data.session_id,
      active: false,
      ended_at: expect.any(String),
    });

    const finalStatus = parseJsonOutput<{
      ok: true;
      command: string;
      data: { session_id: string; session: { ended_at: string | null } };
    }>((await runCli(repoDir, ['session', 'status', '--session', started.data.session_id, '--json'])).stdout);
    expect(finalStatus.data.session_id).toBe(started.data.session_id);
    expect(finalStatus.data.session.ended_at).toBeTruthy();
  });

  it('returns a stable json error when a session id is required', async () => {
    await runCli(repoDir, ['init']);

    try {
      await runCli(repoDir, ['session', 'status', '--json']);
      throw new Error('Expected session status to fail without --session');
    } catch (error) {
      const failure = error as Error & { stderr?: string };
      const parsed = parseJsonOutput<{
        ok: false;
        command: string;
        error: { code: string; message: string };
      }>(failure.stderr ?? '');
      expect(parsed).toMatchObject({
        ok: false,
        command: 'session status',
        error: {
          code: 'SESSION_REQUIRED',
        },
      });
    }
  });

  it('renders actionable text hints for session-required failures', async () => {
    await runCli(repoDir, ['init']);

    const statusFailure = await runCliFailure(repoDir, ['session', 'status']);
    expect(statusFailure.stderr).toContain('threadloop [SESSION_REQUIRED]: A session id is required for this command.');
    expect(statusFailure.stderr).toContain('Hint: Pass --session <id>.');

    const captureFailure = await runCliFailure(repoDir, ['session', 'capture', 'note', 'Need a session first']);
    expect(captureFailure.stderr).toContain('threadloop [SESSION_REQUIRED]: A session id is required for this command.');
    expect(captureFailure.stderr).toContain('Hint: Pass --session <id>.');
  });

  it('renders current session commands in help output', async () => {
    const rootHelp = await runCli(repoDir, ['--help']);
    expect(rootHelp.stdout).toContain('session');
    expect(rootHelp.stdout).toContain('artifact');
    expect(rootHelp.stdout).toContain('start');
    expect(rootHelp.stderr).toBe('');

    const startHelp = await runCli(repoDir, ['start', '--help']);
    expect(startHelp.stdout).toContain('--json');
    expect(startHelp.stdout).toContain('defaults to');
    expect(startHelp.stdout).toContain('main when available');
    expect(startHelp.stdout).toContain('--issue <ref>');
    expect(startHelp.stdout).toContain('--actor <actor>');

    const captureHelp = await runCli(repoDir, ['capture', '--help']);
    expect(captureHelp.stdout).toContain('--session <id>');
    expect(captureHelp.stdout).toContain('--actor <actor>');
    expect(captureHelp.stdout).toContain('--json');

    const statusHelp = await runCli(repoDir, ['status', '--help']);
    expect(statusHelp.stdout).toContain('--session <id>');
    expect(statusHelp.stdout).toContain('--json');

    const artifactHelp = await runCli(repoDir, ['artifact', 'generate', '--help']);
    expect(artifactHelp.stdout).toContain('--session <id>');
    expect(artifactHelp.stdout).toContain('--json');
    expect(artifactHelp.stderr).toBe('');

    const finishHelp = await runCli(repoDir, ['finish', '--help']);
    expect(finishHelp.stdout).toContain('--session <id>');
    expect(finishHelp.stdout).toContain('--json');

    const sessionHelp = await runCli(repoDir, ['session', '--help']);
    expect(sessionHelp.stdout).toContain('start');
    expect(sessionHelp.stdout).toContain('list');
    expect(sessionHelp.stdout).toContain('status');
    expect(sessionHelp.stdout).toContain('capture');
    expect(sessionHelp.stdout).toContain('heartbeat');
    expect(sessionHelp.stdout).toContain('finish');

    const sessionStartHelp = await runCli(repoDir, ['session', 'start', '--help']);
    expect(sessionStartHelp.stdout).toContain('--json');
    expect(sessionStartHelp.stdout).toContain('--goal <goal>');
    expect(sessionStartHelp.stdout).toContain('--constraint <constraint...>');
    expect(sessionStartHelp.stdout).toContain('defaults to');
    expect(sessionStartHelp.stdout).toContain('main when available');
    expect(sessionStartHelp.stdout).toContain('--issue <ref>');
    expect(sessionStartHelp.stdout).toContain('--actor <actor>');
    expect(sessionStartHelp.stderr).toBe('');
  });

  it('renders a derived protocol contract in json mode', async () => {
    const protocol = parseJsonOutput<{
      ok: true;
      command: string;
      data: ReturnType<typeof buildProtocolContract>;
    }>((await runCli(repoDir, ['protocol', '--json'])).stdout);

    expect(protocol).toMatchObject({ ok: true, command: 'protocol' });
    expect(protocol.data).toEqual(buildProtocolContract());
    expect(protocol.data.envVars).toEqual({
      EDITOR: 'Editor command used by --edit and --goal-edit flows.',
    });
    expect(protocol.data.captureKinds).toEqual([
      'intent',
      'note',
      'decision',
      'risk',
      'constraint',
      'validation',
      'reviewer_guidance',
    ]);
    expect(protocol.data.artifactKinds).toEqual(['change-brief', 'pr-summary', 'handoff']);
    expect(protocol.data.commands['artifact generate']).toContain('threadloop artifact generate [kind] [--session <id>] [--json]');
    expect(protocol.data.commands['session capture']).toContain(
      'threadloop session capture <kind> [text] --session <id> [--because <reason>] [--actor <actor>] [--edit] [--json]',
    );
    expect(protocol.data.commands.init).toBe('threadloop init - Initialize ThreadLoop in the current Git repo');
    expect(protocol.data.workflow.defaultBaseRef).toBe('main');
    expect(protocol.data.workflow.branchNaming.default).toBe('threadloop/<slug>');
    expect(protocol.data.workflow.rebaseBeforePr.upstream).toBe('origin/main');
    expect(protocol.data.workflow.pr.bodyArtifact).toBe('pr-summary');
    expect(protocol.data.workflow.trackedFileMutations).toBe('none');
    expect(protocol.data.notes).not.toContain('Use --json flag for machine-readable output on any command');
  });

  it('reconciles a specific session and persists the snapshot', async () => {
    await runCli(repoDir, ['init']);
    const started = parseJsonOutput<{ data: { session_id: string } }>(
      (await runCli(repoDir, ['session', 'start', 'Reconcile test', '--goal', 'Test reconcile', '--json'])).stdout,
    );
    const sessionId = started.data.session_id;

    const reconcile = parseJsonOutput<{
      ok: true;
      command: string;
      data: { reconciled: number; sessions: Array<{ session_id: string; branch: string; head_sha: string }> };
    }>((await runCli(repoDir, ['session', 'reconcile', '--session', sessionId, '--json'])).stdout);

    expect(reconcile).toMatchObject({
      ok: true,
      command: 'session reconcile',
      data: {
        reconciled: 1,
        sessions: [{ session_id: sessionId }],
      },
    });

    const reReconcile = parseJsonOutput<{
      data: { sessions: Array<{ session_id: string; previous_head_sha: string | null }> };
    }>((await runCli(repoDir, ['session', 'reconcile', '--session', sessionId, '--json'])).stdout);
    expect(reReconcile.data.sessions[0].previous_head_sha).toBeTruthy();
  });

  it('reconciles all active sessions with --all', async () => {
    await runCli(repoDir, ['init']);
    const first = parseJsonOutput<{ data: { session_id: string } }>(
      (await runCli(repoDir, ['session', 'start', 'First task', '--goal', 'First goal', '--json'])).stdout,
    );
    const second = parseJsonOutput<{ data: { session_id: string } }>(
      (await runCli(repoDir, ['session', 'start', 'Second task', '--goal', 'Second goal', '--json'])).stdout,
    );

    const reconcile = parseJsonOutput<{
      data: { reconciled: number };
    }>((await runCli(repoDir, ['session', 'reconcile', '--all', '--json'])).stdout);

    expect(reconcile.data.reconciled).toBe(2);
  });

  it('reconcile fails without --session or --all', async () => {
    await runCli(repoDir, ['init']);
    await runCli(repoDir, ['session', 'start', 'Test task', '--goal', 'Test goal']);

    const failure = parseJsonOutput<{ error: { code: string } }>(
      (await runCliFailure(repoDir, ['session', 'reconcile', '--json'])).stderr ?? '',
    );
    expect(failure.error.code).toBe('RECONCILE_TARGET_REQUIRED');
  });

  it('reconcile does not create semantic entries', async () => {
    await runCli(repoDir, ['init']);
    const started = parseJsonOutput<{ data: { session_id: string } }>(
      (await runCli(repoDir, ['session', 'start', 'Entry test', '--goal', 'Test goal', '--json'])).stdout,
    );
    const sessionId = started.data.session_id;

    await runCli(repoDir, ['session', 'capture', 'decision', 'Pre-reconcile decision', '--session', sessionId]);
    await runCli(repoDir, ['session', 'reconcile', '--session', sessionId]);
    await runCli(repoDir, ['session', 'capture', 'decision', 'Post-reconcile decision', '--session', sessionId]);

    const status = parseJsonOutput<{
      data: { entries: { kinds: Record<string, number> } };
    }>((await runCli(repoDir, ['session', 'status', '--session', sessionId, '--json'])).stdout);

    expect(status.data.entries.kinds.decision).toBe(2);
    expect(status.data.entries.kinds.note).toBeUndefined();
    expect(status.data.entries.kinds.intent).toBe(1);
  });

  it('keeps SQLite-backed state intact under concurrent capture, heartbeat, and reconcile writes', async () => {
    await runCli(repoDir, ['init']);
    await writeFile(path.join(repoDir, 'feature.ts'), 'export const feature = true;\n', 'utf8');

    const started = parseJsonOutput<{ data: { session_id: string } }>(
      (await runCli(repoDir, ['session', 'start', 'Concurrent flow', '--goal', 'Stress SQLite writes', '--json'])).stdout,
    );
    await runConcurrentMutationBurst(repoDir, started.data.session_id, 'Concurrent flow');
  }, 15_000);

  it(
    'reopens cached sqlite handles after close/reset hooks and keeps writes working',
    async () => {
      await runCli(repoDir, ['init']);
      const started = parseJsonOutput<{ data: { session_id: string } }>(
        (await runCli(repoDir, ['session', 'start', 'Resettable flow', '--goal', 'Exercise lifecycle hooks', '--json']))
          .stdout,
      );
      const sessionId = started.data.session_id;

      await runCli(repoDir, ['session', 'capture', 'decision', 'First write before reset', '--session', sessionId, '--json']);
      await resetSqliteConnectionLifecycle();

      const statusAfterReset = parseJsonOutput<{
        data: { entries: { count: number; kinds: Record<string, number> } };
      }>((await runCli(repoDir, ['session', 'status', '--session', sessionId, '--json'])).stdout);

      expect(statusAfterReset.data.entries.count).toBe(2);
      expect(statusAfterReset.data.entries.kinds.intent).toBe(1);
      expect(statusAfterReset.data.entries.kinds.decision).toBe(1);

      await runCli(repoDir, ['session', 'capture', 'note', 'Second write after reset', '--session', sessionId, '--json']);
      const statusAfterReuse = parseJsonOutput<{
        data: { entries: { count: number; kinds: Record<string, number> } };
      }>((await runCli(repoDir, ['session', 'status', '--session', sessionId, '--json'])).stdout);

      expect(statusAfterReuse.data.entries.count).toBe(3);
      expect(statusAfterReuse.data.entries.kinds.note).toBe(1);
    },
    15_000,
  );

  it(
    'keeps SQLite-backed state intact across repeated concurrent mutation bursts in one process',
    async () => {
      await runCli(repoDir, ['init']);
      await writeFile(path.join(repoDir, 'feature.ts'), 'export const feature = true;\n', 'utf8');

      const roundCount = 2;
      for (let round = 0; round < roundCount; round += 1) {
        const started = parseJsonOutput<{ data: { session_id: string } }>(
          (
            await runCli(repoDir, [
              'session',
              'start',
              `Concurrent flow ${round + 1}`,
              '--goal',
              'Stress SQLite writes',
              '--json',
            ])
          ).stdout,
        );

        await runConcurrentMutationBurst(repoDir, started.data.session_id, `Concurrent flow ${round + 1}`);
        await resetSqliteConnectionLifecycle();
      }

      const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
      try {
        expect(readScalarCount(db, 'SELECT COUNT(*) AS count FROM sessions')).toBe(roundCount);
        expect(readScalarCount(db, 'SELECT COUNT(*) AS count FROM repo_snapshots')).toBe(roundCount);
        expect(readScalarCount(db, 'SELECT COUNT(*) AS count FROM active_sessions')).toBe(roundCount);
      } finally {
        db.close();
      }
    },
    30_000,
  );

  it('assembles the explicit v2 flow end to end on SQLite state', async () => {
    await runCli(repoDir, ['init']);
    await writeFile(path.join(repoDir, 'feature.ts'), 'export const value = 1;\n', 'utf8');

    const started = parseJsonOutput<{ data: { session_id: string } }>(
      (await runCli(repoDir, ['session', 'start', 'Full v2 flow', '--goal', 'Prove the assembled session contract', '--json']))
        .stdout,
    );
    const sessionId = started.data.session_id;

    await runCli(repoDir, ['session', 'capture', 'decision', 'Keep explicit session targeting', '--session', sessionId, '--json']);
    await runCli(repoDir, ['session', 'capture', 'validation', 'Verified stored snapshot refresh', '--session', sessionId, '--json']);
    await runCli(repoDir, ['session', 'heartbeat', '--session', sessionId, '--source', 'daemon', '--json']);
    await runCli(repoDir, ['session', 'reconcile', '--session', sessionId, '--json']);

    const artifact = parseJsonOutput<{ data: { artifact: { path: string } } }>(
      (await runCli(repoDir, ['artifact', 'generate', '--session', sessionId, '--json'])).stdout,
    );
    const status = parseJsonOutput<{
      data: {
        session: { ended_at: string | null; last_heartbeat_source: string | null };
        entries: { count: number; kinds: Record<string, number> };
        repo_snapshot: { branch: string; headSha: string; changedFiles: string[] } | null;
      };
    }>((await runCli(repoDir, ['session', 'status', '--session', sessionId, '--json'])).stdout);
    const finished = parseJsonOutput<{ data: { session_id: string } }>(
      (await runCli(repoDir, ['session', 'finish', '--session', sessionId, '--json'])).stdout,
    );
    const listed = parseJsonOutput<{
      data: { sessions: Array<{ session_id: string; active: boolean; ended_at: string | null }> };
    }>((await runCli(repoDir, ['session', 'list', '--json'])).stdout);

    expect(status.data.entries.count).toBe(3);
    expect(status.data.entries.kinds.intent).toBe(1);
    expect(status.data.entries.kinds.decision).toBe(1);
    expect(status.data.entries.kinds.validation).toBe(1);
    expect(status.data.session.ended_at).toBeNull();
    expect(status.data.session.last_heartbeat_source).toBe('daemon');
    expect(status.data.repo_snapshot?.changedFiles).toContain('feature.ts');
    expect(finished.data.session_id).toBe(sessionId);
    expect(listed.data.sessions).toContainEqual(expect.objectContaining({
      session_id: sessionId,
      active: false,
      ended_at: expect.any(String),
    }));

    const renderedArtifact = await readFile(path.join(repoDir, artifact.data.artifact.path), 'utf8');
    expect(renderedArtifact).toContain('feature.ts');
    expect(renderedArtifact).not.toContain('.threadloop/');
  }, 15_000);

  it('renders reconcile command in help output', async () => {
    const sessionHelp = await runCli(repoDir, ['session', '--help']);
    expect(sessionHelp.stdout).toContain('reconcile');
  });
});

function readScalarCount(db: DatabaseSync, sql: string) {
  const row = db.prepare(sql).get() as { count: number } | undefined;
  return row?.count ?? 0;
}

function readParameterizedCount(db: DatabaseSync, sql: string, value: string) {
  const row = db.prepare(sql).get(value) as { count: number } | undefined;
  return row?.count ?? 0;
}
