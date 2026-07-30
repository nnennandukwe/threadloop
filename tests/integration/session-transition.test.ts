import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import {
  applySessionTransition,
  ensureStateDatabase,
  resetSqliteConnections,
} from '../../src/adapters/fs/sqlite-store.js';
import { DatabaseSync } from '../../src/adapters/fs/sqlite-driver.js';
import { canonicalizeTransitionRequest, type TransitionRequest } from '../../src/domain/session-transition.js';

const execFileAsync = promisify(execFile);
const temporaryRepos: string[] = [];
const projectRoot = process.cwd();
const tsxCli = path.join(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = path.join(projectRoot, 'src/cli.ts');

async function runCli(cwd: string, args: string[]) {
  return execFileAsync('node', [tsxCli, cliEntry, ...args], { cwd });
}

async function runCliFailure(cwd: string, args: string[]) {
  try {
    await runCli(cwd, args);
    throw new Error(`Expected CLI command to fail: ${args.join(' ')}`);
  } catch (error) {
    return error as Error & { stdout?: string; stderr?: string };
  }
}

function parseJson<T>(value: string | undefined) {
  return JSON.parse(value ?? '') as T;
}

async function makeRepo() {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), 'threadloop-transition-'));
  temporaryRepos.push(repoDir);
  await execFileAsync('git', ['init'], { cwd: repoDir });
  await mkdir(path.join(repoDir, '.threadloop/state'), { recursive: true });
  await writeFile(
    path.join(repoDir, '.threadloop/config.json'),
    `${JSON.stringify({ version: 1, createdAt: '2026-07-23T12:00:00.000Z' }, null, 2)}\n`,
    'utf8',
  );
  return repoDir;
}

async function startQueuedSession(repoDir: string) {
  const started = parseJson<{ data: { session_id: string; task_id: string } }>(
    (
      await runCli(repoDir, [
        'session',
        'start',
        'Transition task',
        '--goal',
        'Prove deterministic transition behavior',
        '--json',
      ])
    ).stdout,
  );
  return started.data;
}

async function applyFixtureTransition(
  repoDir: string,
  sessionId: string,
  targetState: TransitionRequest['targetState'],
  expectedStateVersion: number,
  idempotencyKey: string,
  input: Record<string, unknown> = {},
) {
  const request: TransitionRequest = {
    sessionId,
    targetState,
    expectedStateVersion,
    actor: 'agent',
    input,
  };
  const result = await applySessionTransition(
    repoDir,
    {
      ...request,
      idempotencyKey,
      ...canonicalizeTransitionRequest(request, sha256),
    },
    () => ({ allowed: true, guardFailures: [], requiredWork: [] }),
  );
  if (!result.ok) {
    throw new Error(`Could not prepare ${targetState} fixture: ${result.error.code}`);
  }
  return result;
}

async function prepareReadyForHumanFixture(repoDir: string, sessionId: string) {
  for (const [targetState, expectedStateVersion] of [
    ['framed', 0],
    ['proof_ready', 1],
    ['implementing', 2],
    ['verifying', 3],
    ['pre_pr_reviewing', 4],
    ['reviewing', 5],
    ['ready_for_human', 6],
  ] as const) {
    await applyFixtureTransition(repoDir, sessionId, targetState, expectedStateVersion, `fixture:${targetState}`);
  }
}

function createSchemaV2(repoDir: string) {
  const dbPath = path.join(repoDir, '.threadloop/state/state.db');
  const db = new DatabaseSync(dbPath);
  const now = '2026-07-23T12:00:00.000Z';

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
      state_version INTEGER NOT NULL DEFAULT 0,
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
  db.prepare(`INSERT INTO metadata (key, value) VALUES ('schema_version', '2')`).run();
  db.prepare(
    `
      INSERT INTO tasks (
        id, title, goal, constraints_json, issue_ref, repo_root, status, state_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run('task_queued', 'Queued task', 'Exercise schema v3', '[]', '#39', repoDir, 'queued', 0, now);
  db.prepare(
    `
      INSERT INTO sessions (
        id, task_id, started_at, ended_at, base_ref, branch, head_sha, last_heartbeat_at, last_heartbeat_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run('session_queued', 'task_queued', now, null, null, 'issue-39/test', 'abc123', null, null);
  db.prepare(`INSERT INTO active_sessions (session_id, task_id) VALUES (?, ?)`).run('session_queued', 'task_queued');
  db.prepare(`INSERT INTO active_state (id, task_id, session_id) VALUES (1, ?, ?)`).run(
    'task_queued',
    'session_queued',
  );
  db.close();
  return dbPath;
}

afterEach(async () => {
  await resetSqliteConnections();
  temporaryRepos.length = 0;
});

describe('schema v7 lifecycle and audit persistence', { timeout: 20_000 }, () => {
  it('migrates a canonical schema-v2 database without changing lifecycle state', async () => {
    const repoDir = await makeRepo();
    const dbPath = createSchemaV2(repoDir);

    await ensureStateDatabase(repoDir);
    await resetSqliteConnections(repoDir);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get()).toEqual({ value: '7' });
      expect(
        (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map((column) => column.name),
      ).toContain('blocked_from_state');
      expect(
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_transitions', 'transition_idempotency', 'transition_idempotency_conflicts', 'proof_plans', 'gate_receipts', 'signed_gate_receipts', 'signed_review_receipts', 'audit_events') ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: 'audit_events' },
        { name: 'gate_receipts' },
        { name: 'proof_plans' },
        { name: 'session_transitions' },
        { name: 'signed_gate_receipts' },
        { name: 'signed_review_receipts' },
        { name: 'transition_idempotency' },
        { name: 'transition_idempotency_conflicts' },
      ]);
      expect(
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'session_transitions_no_%' ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: 'session_transitions_no_delete' },
        { name: 'session_transitions_no_replace' },
        { name: 'session_transitions_no_update' },
      ]);
      expect(
        db
          .prepare(`SELECT sequence, event_type, state_version, previous_sha256 FROM audit_events WHERE session_id = ?`)
          .get('session_queued'),
      ).toMatchObject({
        sequence: 1,
        event_type: 'audit_activated',
        state_version: 0,
        previous_sha256: '0'.repeat(64),
      });
      expect(db.prepare(`SELECT status, state_version, blocked_from_state FROM tasks`).get()).toEqual({
        status: 'queued',
        state_version: 0,
        blocked_from_state: null,
      });
      expect(db.prepare(`SELECT task_id, session_id FROM active_state WHERE id = 1`).get()).toEqual({
        task_id: 'task_queued',
        session_id: 'session_queued',
      });
    } finally {
      db.close();
    }
  });

  it('projects schema-v6 migration requirements read-only and migrates only through init', async () => {
    const repoDir = await makeRepo();
    const started = parseJson<{ data: { session_id: string } }>(
      (await runCli(repoDir, ['session', 'start', 'Migration task', '--goal', 'Preserve semantic history', '--json']))
        .stdout,
    );
    const dbPath = path.join(repoDir, '.threadloop/state/state.db');
    await resetSqliteConnections(repoDir);
    const downgrade = new DatabaseSync(dbPath);
    downgrade.prepare(`UPDATE metadata SET value = '6' WHERE key = 'schema_version'`).run();
    const beforeCounts = {
      transitions: (downgrade.prepare(`SELECT COUNT(*) AS count FROM session_transitions`).get() as { count: number })
        .count,
      audit: (downgrade.prepare(`SELECT COUNT(*) AS count FROM audit_events`).get() as { count: number }).count,
    };
    downgrade.close();
    const beforeBytes = await readFile(dbPath);

    const next = parseJson<{
      data: {
        contract_version: number;
        lifecycle: { storage_schema_version: number; contract_status: string };
        candidate: unknown;
        guard_failures: Array<{ code: string }>;
        required_work: Array<{ code: string }>;
        pre_pr_review: { status: string };
      };
    }>((await runCli(repoDir, ['session', 'next', '--session', started.data.session_id, '--json'])).stdout);
    expect(next.data).toMatchObject({
      contract_version: 4,
      lifecycle: {
        storage_schema_version: 6,
        contract_status: 'migration_required',
      },
      candidate: null,
      guard_failures: [{ code: 'SESSION_SCHEMA_MIGRATION_REQUIRED' }],
      required_work: [{ code: 'MIGRATE_SESSION_SCHEMA' }],
      pre_pr_review: { status: 'migration_required' },
    });
    expect(await readFile(dbPath)).toEqual(beforeBytes);

    const migrationRequiredCommands = [
      ['session', 'gate', 'run', 'unit', '--session', started.data.session_id, '--json'],
      [
        'session',
        'transition',
        'framed',
        '--session',
        started.data.session_id,
        '--expected-state-version',
        '0',
        '--idempotency-key',
        'migration:transition',
        '--actor',
        'agent',
        '--input',
        '{}',
        '--json',
      ],
      ['session', 'gate', 'import', 'missing-package.json', '--session', started.data.session_id, '--json'],
      ['session', 'review', 'import', 'missing-package.json', '--session', started.data.session_id, '--json'],
      ['audit', 'show', '--session', started.data.session_id, '--json'],
      ['audit', 'verify', '--session', started.data.session_id, '--json'],
      ['session', 'start', 'Second task', '--goal', 'Must not migrate implicitly', '--json'],
    ];
    for (const args of migrationRequiredCommands) {
      const failure = await runCliFailure(repoDir, args);
      const error = parseJson<{
        error: {
          code: string;
          details: { storage_schema_version: number; hint: string };
        };
      }>(failure.stderr);
      expect(error).toMatchObject({
        error: {
          code: 'SESSION_SCHEMA_MIGRATION_REQUIRED',
          details: {
            storage_schema_version: 6,
          },
        },
      });
      expect(error.error.details.hint).toContain('Run `threadloop init`');
      expect(await readFile(dbPath)).toEqual(beforeBytes);
    }

    await runCli(repoDir, ['init']);
    await resetSqliteConnections(repoDir);
    const migrated = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(migrated.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get()).toEqual({
        value: '7',
      });
      expect(
        (migrated.prepare(`SELECT COUNT(*) AS count FROM session_transitions`).get() as { count: number }).count,
      ).toBe(beforeCounts.transitions);
      expect((migrated.prepare(`SELECT COUNT(*) AS count FROM audit_events`).get() as { count: number }).count).toBe(
        beforeCounts.audit,
      );
    } finally {
      migrated.close();
    }
  }, 60_000);

  it('revalidates canonical schema metadata on the ready read path', async () => {
    const repoDir = await makeRepo();
    const dbPath = createSchemaV2(repoDir);
    await ensureStateDatabase(repoDir);

    const corrupt = new DatabaseSync(dbPath);
    corrupt.prepare(`UPDATE metadata SET value = '3.0' WHERE key = 'schema_version'`).run();
    corrupt.close();

    await expect(ensureStateDatabase(repoDir)).rejects.toThrow('Unsupported ThreadLoop schema version: 3.0');

    const unchanged = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(unchanged.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get()).toEqual({
        value: '3.0',
      });
    } finally {
      unchanged.close();
    }
  });

  it.each(['2.0', '02', '2e0', ' 2 ', '\t2\n', '3.0', '03', '3e0', ' 3 ', '\t3\n'])(
    'rejects malformed schema metadata %j before mutation',
    async (rawVersion) => {
      const repoDir = await makeRepo();
      const dbPath = createSchemaV2(repoDir);
      const corrupt = new DatabaseSync(dbPath);
      const initialJournalMode = corrupt.prepare(`PRAGMA journal_mode`).get();
      corrupt.prepare(`UPDATE metadata SET value = ? WHERE key = 'schema_version'`).run(rawVersion);
      corrupt.close();

      await expect(ensureStateDatabase(repoDir)).rejects.toThrow(
        `Unsupported ThreadLoop schema version: ${rawVersion}`,
      );
      await resetSqliteConnections(repoDir);

      const unchanged = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(unchanged.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get()).toEqual({
          value: rawVersion,
        });
        expect(unchanged.prepare(`PRAGMA journal_mode`).get()).toEqual(initialJournalMode);
        expect(
          (
            unchanged.prepare(`PRAGMA table_info(tasks)`).all() as Array<{
              name: string;
            }>
          ).map((column) => column.name),
        ).not.toContain('blocked_from_state');
        expect(
          unchanged
            .prepare(
              `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'session_transitions'`,
            )
            .get(),
        ).toEqual({ count: 0 });
      } finally {
        unchanged.close();
      }
    },
  );

  it('returns STATE_CORRUPTED for malformed metadata through the public transition envelope', async () => {
    const repoDir = await makeRepo();
    const dbPath = createSchemaV2(repoDir);
    const corrupt = new DatabaseSync(dbPath);
    corrupt.prepare(`UPDATE metadata SET value = '2.0' WHERE key = 'schema_version'`).run();
    corrupt.close();

    const failure = await runCliFailure(repoDir, [
      'session',
      'transition',
      'framed',
      '--session',
      'session_queued',
      '--expected-state-version',
      '0',
      '--idempotency-key',
      'schema:malformed',
      '--actor',
      'agent',
      '--input',
      '{}',
      '--json',
    ]);
    expect(parseJson<{ error: { code: string; message: string } }>(failure.stderr)).toMatchObject({
      error: {
        code: 'STATE_CORRUPTED',
        message: 'Unsupported ThreadLoop schema version: 2.0',
      },
    });

    const unchanged = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(unchanged.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get()).toEqual({
        value: '2.0',
      });
      expect(
        unchanged
          .prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'session_transitions'`)
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      unchanged.close();
    }
  });

  it('rolls back every schema-v6 change when migration validation fails', async () => {
    const repoDir = await makeRepo();
    const dbPath = createSchemaV2(repoDir);
    const incompatible = new DatabaseSync(dbPath);
    incompatible.exec(`CREATE TABLE transition_idempotency (unexpected TEXT NOT NULL)`);
    incompatible.close();

    await expect(ensureStateDatabase(repoDir)).rejects.toThrow('Invalid schema for transition_idempotency');
    await resetSqliteConnections(repoDir);

    const unchanged = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(unchanged.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get()).toEqual({
        value: '2',
      });
      expect(
        (unchanged.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map((column) => column.name),
      ).not.toContain('blocked_from_state');
      expect(
        unchanged
          .prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'session_transitions'`)
          .get(),
      ).toEqual({ count: 0 });
      expect(unchanged.prepare(`PRAGMA table_info(transition_idempotency)`).all()).toEqual([
        {
          cid: 0,
          name: 'unexpected',
          type: 'TEXT',
          notnull: 1,
          dflt_value: null,
          pk: 0,
        },
      ]);
    } finally {
      unchanged.close();
    }
  });

  it('makes applied transition history immutable in schema v7', async () => {
    const repoDir = await makeRepo();
    const started = parseJson<{ data: { session_id: string } }>(
      (await runCli(repoDir, ['session', 'start', 'Immutable history', '--goal', 'Protect lifecycle phase', '--json']))
        .stdout,
    );
    await runCli(repoDir, [
      'session',
      'transition',
      'framed',
      '--session',
      started.data.session_id,
      '--expected-state-version',
      '0',
      '--idempotency-key',
      'immutability:framed',
      '--actor',
      'agent',
      '--input',
      '{}',
      '--json',
    ]);
    await resetSqliteConnections(repoDir);

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'));
    try {
      expect(() =>
        db
          .prepare(`UPDATE session_transitions SET to_state = 'queued' WHERE session_id = ?`)
          .run(started.data.session_id),
      ).toThrow('session transitions are immutable');
      expect(() =>
        db.prepare(`DELETE FROM session_transitions WHERE session_id = ?`).run(started.data.session_id),
      ).toThrow('session transitions are immutable');
      expect(() =>
        db
          .prepare(
            `
              INSERT OR REPLACE INTO session_transitions
              SELECT * FROM session_transitions WHERE session_id = ?
            `,
          )
          .run(started.data.session_id),
      ).toThrow('session transitions are immutable');
      expect(
        db.prepare(`SELECT from_state, to_state, from_state_version, to_state_version FROM session_transitions`).all(),
      ).toEqual([
        {
          from_state: 'queued',
          to_state: 'framed',
          from_state_version: 0,
          to_state_version: 1,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('fails session next closed when transition history no longer matches the audit ledger', async () => {
    const repoDir = await makeRepo();
    const started = parseJson<{ data: { session_id: string; task_id: string } }>(
      (
        await runCli(repoDir, [
          'session',
          'start',
          'Corrupt history',
          '--goal',
          'Fail phase derivation closed',
          '--json',
        ])
      ).stdout,
    );
    await runCli(repoDir, [
      'session',
      'transition',
      'framed',
      '--session',
      started.data.session_id,
      '--expected-state-version',
      '0',
      '--idempotency-key',
      'corrupt-history:framed',
      '--actor',
      'agent',
      '--input',
      '{}',
      '--json',
    ]);
    await resetSqliteConnections(repoDir);

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'));
    db.exec(`
      DROP TRIGGER session_transitions_no_update;
      DROP TRIGGER session_transitions_no_delete;
      DROP TRIGGER session_transitions_no_replace;
      UPDATE session_transitions SET input_json = '{"tampered":true}'
      WHERE session_id = '${started.data.session_id}';
      CREATE TRIGGER session_transitions_no_update
      BEFORE UPDATE ON session_transitions
      BEGIN
        SELECT RAISE(ABORT, 'session transitions are immutable');
      END;
      CREATE TRIGGER session_transitions_no_delete
      BEFORE DELETE ON session_transitions
      BEGIN
        SELECT RAISE(ABORT, 'session transitions are immutable');
      END;
      CREATE TRIGGER session_transitions_no_replace
      BEFORE INSERT ON session_transitions
      WHEN EXISTS (
        SELECT 1 FROM session_transitions
        WHERE id = NEW.id OR (task_id = NEW.task_id AND to_state_version = NEW.to_state_version)
      )
      BEGIN
        SELECT RAISE(ABORT, 'session transitions are immutable');
      END;
    `);
    db.close();

    const failure = await runCliFailure(repoDir, ['session', 'next', '--session', started.data.session_id, '--json']);
    const parsedFailure = parseJson<{ error: { code: string; message: string } }>(failure.stderr);
    expect(parsedFailure.error.code).toBe('STATE_CORRUPTED');
    expect(parsedFailure.error.message).toContain('Invalid session transition history');

    const unchanged = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(
        unchanged.prepare(`SELECT status, state_version FROM tasks WHERE id = ?`).get(started.data.task_id),
      ).toEqual({
        status: 'framed',
        state_version: 1,
      });
      expect(
        unchanged
          .prepare(`SELECT COUNT(*) AS count FROM session_transitions WHERE session_id = ?`)
          .get(started.data.session_id),
      ).toEqual({ count: 1 });
    } finally {
      unchanged.close();
    }
  });

  it('fails reads and writes closed when the task projection drifts from authoritative history', async () => {
    const repoDir = await makeRepo();
    const { session_id: sessionId, task_id: taskId } = await startQueuedSession(repoDir);
    await runCli(repoDir, [
      'session',
      'transition',
      'framed',
      '--session',
      sessionId,
      '--expected-state-version',
      '0',
      '--idempotency-key',
      'projection-drift:framed',
      '--actor',
      'agent',
      '--input',
      '{}',
      '--json',
    ]);
    await resetSqliteConnections(repoDir);
    const dbPath = path.join(repoDir, '.threadloop/state/state.db');
    const corrupt = new DatabaseSync(dbPath);
    const beforeAuditCount = (
      corrupt.prepare(`SELECT COUNT(*) AS count FROM audit_events WHERE session_id = ?`).get(sessionId) as {
        count: number;
      }
    ).count;
    corrupt.prepare(`UPDATE tasks SET status = 'implementing' WHERE id = ?`).run(taskId);
    corrupt.close();

    for (const args of [
      ['session', 'next', '--session', sessionId, '--json'],
      [
        'session',
        'transition',
        'verifying',
        '--session',
        sessionId,
        '--expected-state-version',
        '1',
        '--idempotency-key',
        'projection-drift:transition',
        '--actor',
        'agent',
        '--input',
        '{}',
        '--json',
      ],
      [
        'session',
        'transition',
        'verifying',
        '--session',
        sessionId,
        '--expected-state-version',
        '1',
        '--idempotency-key',
        'projection-drift:framed',
        '--actor',
        'agent',
        '--input',
        '{"changed_request":true}',
        '--json',
      ],
    ]) {
      const failure = parseJson<{ error: { code: string; message: string } }>(
        (await runCliFailure(repoDir, args)).stderr,
      );
      expect(failure.error.code).toBe('STATE_CORRUPTED');
      expect(failure.error.message).toContain('current lifecycle projection does not match transition history');
    }

    const unchanged = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(unchanged.prepare(`SELECT status, state_version FROM tasks WHERE id = ?`).get(taskId)).toEqual({
        status: 'implementing',
        state_version: 1,
      });
      expect(unchanged.prepare(`SELECT COUNT(*) AS count FROM session_transitions`).get()).toEqual({ count: 1 });
      expect(
        unchanged.prepare(`SELECT COUNT(*) AS count FROM audit_events WHERE session_id = ?`).get(sessionId),
      ).toEqual({ count: beforeAuditCount });
    } finally {
      unchanged.close();
    }
  }, 20_000);

  it('binds a no-transition task projection to the session-started genesis event', async () => {
    const repoDir = await makeRepo();
    const { session_id: sessionId, task_id: taskId } = await startQueuedSession(repoDir);
    await resetSqliteConnections(repoDir);
    const dbPath = path.join(repoDir, '.threadloop/state/state.db');
    const corrupt = new DatabaseSync(dbPath);
    corrupt.prepare(`UPDATE tasks SET status = 'implementing' WHERE id = ?`).run(taskId);
    corrupt.close();

    const failure = parseJson<{ error: { code: string; message: string } }>(
      (await runCliFailure(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stderr,
    );
    expect(failure.error.code).toBe('STATE_CORRUPTED');
    expect(failure.error.message).toContain('current lifecycle projection does not match transition history');
  }, 20_000);

  it('rolls back schema-v6 migration when legacy transition history is inconsistent', async () => {
    const repoDir = await makeRepo();
    const started = parseJson<{ data: { session_id: string } }>(
      (
        await runCli(repoDir, [
          'session',
          'start',
          'Legacy corrupt history',
          '--goal',
          'Reject an unsafe semantic migration',
          '--json',
        ])
      ).stdout,
    );
    await runCli(repoDir, [
      'session',
      'transition',
      'framed',
      '--session',
      started.data.session_id,
      '--expected-state-version',
      '0',
      '--idempotency-key',
      'legacy-corrupt:framed',
      '--actor',
      'agent',
      '--input',
      '{}',
      '--json',
    ]);
    await resetSqliteConnections(repoDir);
    const dbPath = path.join(repoDir, '.threadloop/state/state.db');
    const corrupt = new DatabaseSync(dbPath);
    corrupt.exec(`
      UPDATE metadata SET value = '6' WHERE key = 'schema_version';
      DROP TRIGGER session_transitions_no_update;
      DROP TRIGGER session_transitions_no_delete;
      DROP TRIGGER session_transitions_no_replace;
      UPDATE session_transitions SET input_json = '{"tampered":true}'
      WHERE session_id = '${started.data.session_id}';
    `);
    corrupt.close();

    const failure = await runCliFailure(repoDir, ['init']);
    expect(failure.stderr).toContain('threadloop [STATE_CORRUPTED]: Invalid session transition history');
    expect(failure.stderr).toContain(
      'Hint: Restore transition history from trusted storage, then rerun `threadloop init`.',
    );
    await resetSqliteConnections(repoDir);

    const unchanged = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(unchanged.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get()).toEqual({
        value: '6',
      });
      expect(
        unchanged
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'session_transitions_no_%'`)
          .all(),
      ).toEqual([]);
      expect(unchanged.prepare(`SELECT input_json FROM session_transitions`).get()).toEqual({
        input_json: '{"tampered":true}',
      });
    } finally {
      unchanged.close();
    }
  });
});

describe('session transition command', { timeout: 20_000 }, () => {
  function transitionArgs(sessionId: string, target: string, version: string, key: string, input = '{}') {
    return [
      'session',
      'transition',
      target,
      '--session',
      sessionId,
      '--expected-state-version',
      version,
      '--idempotency-key',
      key,
      '--actor',
      'agent',
      '--input',
      input,
      '--json',
    ];
  }

  it('atomically transitions queued to framed and replays an identical wake exactly', async () => {
    const repoDir = await makeRepo();
    const { session_id: sessionId, task_id: taskId } = await startQueuedSession(repoDir);
    const args = transitionArgs(sessionId, 'framed', '0', `wake:${sessionId}:0`, '{"z":2,"a":1}');

    const first = await runCli(repoDir, args);
    const replay = await runCli(repoDir, [...args.slice(0, -2), '{"a":1,"z":2}', '--json']);
    const body = parseJson<{
      ok: true;
      command: string;
      data: {
        task_id: string;
        transition: { from_state: string; to_state: string; from_state_version: number; to_state_version: number };
        lifecycle: { state: string; state_version: number; blocked_from_state: string | null };
      };
    }>(first.stdout);

    expect(body).toMatchObject({
      ok: true,
      command: 'session transition',
      data: {
        contract_version: 1,
        session_id: sessionId,
        task_id: taskId,
        transition: {
          from_state: 'queued',
          to_state: 'framed',
          from_state_version: 0,
          to_state_version: 1,
          actor: 'agent',
          input: { a: 1, z: 2 },
        },
        lifecycle: { state: 'framed', state_version: 1, blocked_from_state: null },
        session: { ended_at: null },
      },
    });
    expect(replay.stdout).toBe(first.stdout);

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT status, state_version FROM tasks WHERE id = ?`).get(taskId)).toEqual({
        status: 'framed',
        state_version: 1,
      });
      expect(db.prepare(`SELECT COUNT(*) AS count FROM session_transitions`).get()).toEqual({ count: 1 });
      expect(db.prepare(`SELECT COUNT(*) AS count FROM transition_idempotency`).get()).toEqual({ count: 1 });
      expect(db.prepare(`SELECT task_id, session_id FROM active_state`).get()).toEqual({
        task_id: taskId,
        session_id: sessionId,
      });
    } finally {
      db.close();
    }
  });

  it('rejects changed content for an existing key, caches stale failures, and validates proof plans first', async () => {
    const repoDir = await makeRepo();
    const { session_id: sessionId } = await startQueuedSession(repoDir);
    const key = `wake:${sessionId}:0`;
    await runCli(repoDir, transitionArgs(sessionId, 'framed', '0', key));

    const conflict = parseJson<{ error: { code: string } }>(
      (await runCliFailure(repoDir, transitionArgs(sessionId, 'blocked', '0', key, '{"block":{}}'))).stderr,
    );
    expect(conflict.error.code).toBe('IDEMPOTENCY_CONFLICT');

    const staleArgs = transitionArgs(sessionId, 'proof_ready', '0', `wake:${sessionId}:stale`);
    const stale = await runCliFailure(repoDir, staleArgs);
    const staleReplay = await runCliFailure(repoDir, staleArgs);
    expect(staleReplay.stderr).toBe(stale.stderr);
    expect(parseJson<{ error: { code: string } }>(stale.stderr).error.code).toBe('STATE_VERSION_CONFLICT');

    const guardedArgs = transitionArgs(sessionId, 'proof_ready', '1', `wake:${sessionId}:guard`);
    const guarded = await runCliFailure(repoDir, guardedArgs);
    const guardedReplay = await runCliFailure(repoDir, guardedArgs);
    expect(guardedReplay.stderr).toBe(guarded.stderr);
    expect(parseJson<{ error: { code: string; details: { field: string } } }>(guarded.stderr)).toMatchObject({
      error: { code: 'INVALID_ARGUMENT', details: { field: 'proof_plan' } },
    });

    const rejectedKey = `wake:${sessionId}:rejected`;
    await runCliFailure(repoDir, transitionArgs(sessionId, 'blocked', '1', rejectedKey, '{"block":{}}'));
    const reusedRejectedKey = await runCliFailure(repoDir, transitionArgs(sessionId, 'proof_ready', '1', rejectedKey));
    expect(parseJson<{ error: { code: string } }>(reusedRejectedKey.stderr).error.code).toBe('IDEMPOTENCY_CONFLICT');

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT status, state_version FROM tasks`).get()).toEqual({
        status: 'framed',
        state_version: 1,
      });
      expect(db.prepare(`SELECT COUNT(*) AS count FROM session_transitions`).get()).toEqual({ count: 1 });
      expect(
        db.prepare(`SELECT outcome, COUNT(*) AS count FROM transition_idempotency GROUP BY outcome`).all(),
      ).toEqual([
        { outcome: 'applied', count: 1 },
        { outcome: 'rejected', count: 2 },
      ]);
    } finally {
      db.close();
    }
  });

  it('audits each distinct conflicting request once while replaying an exact conflict idempotently', async () => {
    const repoDir = await makeRepo();
    const { session_id: sessionId } = await startQueuedSession(repoDir);
    const key = `wake:${sessionId}:conflict`;
    await runCli(repoDir, transitionArgs(sessionId, 'framed', '0', key));

    const firstConflictArgs = transitionArgs(sessionId, 'blocked', '0', key, '{"block":{"reason":"first"}}');
    const [firstConflict, firstReplay] = await Promise.all([
      runCliFailure(repoDir, firstConflictArgs),
      runCliFailure(repoDir, firstConflictArgs),
    ]);
    expect(firstReplay.stderr).toBe(firstConflict.stderr);

    const secondConflict = await runCliFailure(
      repoDir,
      transitionArgs(sessionId, 'proof_ready', '0', key, '{"proof_plan":{"marker":"second"}}'),
    );
    expect(parseJson<{ error: { code: string } }>(firstConflict.stderr).error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(parseJson<{ error: { code: string } }>(secondConflict.stderr).error.code).toBe('IDEMPOTENCY_CONFLICT');

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT status, state_version FROM tasks`).get()).toEqual({
        status: 'framed',
        state_version: 1,
      });
      expect(db.prepare(`SELECT COUNT(*) AS count FROM transition_idempotency_conflicts`).get()).toEqual({
        count: 2,
      });
      const conflicts = db
        .prepare(
          `
            SELECT event_json
            FROM audit_events
            WHERE session_id = ? AND event_type = 'guard_decision'
            ORDER BY sequence
          `,
        )
        .all(sessionId)
        .map((row) => parseJson<{ payload: { error?: { code?: string } } }>(String(row.event_json)))
        .filter((event) => event.payload.error?.code === 'IDEMPOTENCY_CONFLICT');
      expect(conflicts).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('preserves and restores the prior state only with complete blocking and recovery evidence', async () => {
    const repoDir = await makeRepo();
    const { session_id: sessionId } = await startQueuedSession(repoDir);
    const incomplete = await runCliFailure(
      repoDir,
      transitionArgs(sessionId, 'blocked', '0', 'block:incomplete', '{"block":{"reason":"No access"}}'),
    );
    expect(parseJson<{ error: { code: string } }>(incomplete.stderr).error.code).toBe('TRANSITION_GUARD_FAILED');

    await runCli(
      repoDir,
      transitionArgs(
        sessionId,
        'blocked',
        '0',
        'block:complete',
        '{"block":{"stop_code":"ACCESS_DENIED","recovery":"Restore access","reason":"No access","evidence_ref":"incident:123"}}',
      ),
    );
    const badRecovery = await runCliFailure(
      repoDir,
      transitionArgs(
        sessionId,
        'framed',
        '1',
        'recovery:wrong-target',
        '{"recovery":{"approved_by":"Nnenna","evidence_ref":"incident:123:resolved","reason":"Access restored"}}',
      ),
    );
    expect(parseJson<{ error: { code: string } }>(badRecovery.stderr).error.code).toBe('TRANSITION_NOT_ALLOWED');

    await runCli(
      repoDir,
      transitionArgs(
        sessionId,
        'queued',
        '1',
        'recovery:complete',
        '{"recovery":{"reason":"Access restored","evidence_ref":"incident:123:resolved","approved_by":"Nnenna"}}',
      ),
    );

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT status, state_version, blocked_from_state FROM tasks`).get()).toEqual({
        status: 'queued',
        state_version: 2,
        blocked_from_state: null,
      });
      expect(db.prepare(`SELECT COUNT(*) AS count FROM session_transitions`).get()).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });

  it('allows one winner across processes racing from the same state version', async () => {
    const repoDir = await makeRepo();
    const { session_id: sessionId } = await startQueuedSession(repoDir);
    const [left, right] = await Promise.allSettled([
      runCli(repoDir, transitionArgs(sessionId, 'framed', '0', 'race:left')),
      runCli(repoDir, transitionArgs(sessionId, 'framed', '0', 'race:right')),
    ]);
    const results = [left, right];

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(parseJson<{ error: { code: string } }>((rejected.reason as { stderr?: string }).stderr).error.code).toBe(
        'STATE_VERSION_CONFLICT',
      );
    }

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM session_transitions`).get()).toEqual({ count: 1 });
      expect(db.prepare(`SELECT COUNT(*) AS count FROM transition_idempotency`).get()).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });

  it('deduplicates identical cross-process wakes into one transition record', async () => {
    const repoDir = await makeRepo();
    const { session_id: sessionId } = await startQueuedSession(repoDir);
    const args = transitionArgs(sessionId, 'framed', '0', 'race:identical');
    const [left, right] = await Promise.all([runCli(repoDir, args), runCli(repoDir, args)]);

    expect(left.stdout).toBe(right.stdout);
    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM session_transitions`).get()).toEqual({ count: 1 });
      expect(db.prepare(`SELECT COUNT(*) AS count FROM transition_idempotency`).get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it.each([
    ['not-a-state', '0', 'valid:key', 'agent', '{}'],
    ['framed', '2.0', 'valid:key', 'agent', '{}'],
    ['framed', '02', 'valid:key', 'agent', '{}'],
    ['framed', '2e0', 'valid:key', 'agent', '{}'],
    ['framed', ' 2 ', 'valid:key', 'agent', '{}'],
    ['framed', '9007199254740992', 'valid:key', 'agent', '{}'],
    ['framed', '0', 'has spaces', 'agent', '{}'],
    ['framed', '0', 'valid:key', 'daemon', '{}'],
    ['framed', '0', 'valid:key', 'agent', '[]'],
    ['framed', '0', 'valid:key', 'agent', '{bad'],
  ])(
    'rejects malformed public input target=%s version=%s key=%s actor=%s input=%s before mutation',
    async (target, version, key, actor, input) => {
      const repoDir = await makeRepo();
      const { session_id: sessionId } = await startQueuedSession(repoDir);
      const failure = await runCliFailure(repoDir, [
        'session',
        'transition',
        target,
        '--session',
        sessionId,
        '--expected-state-version',
        version,
        '--idempotency-key',
        key,
        '--actor',
        actor,
        '--input',
        input,
        '--json',
      ]);
      expect(parseJson<{ error: { code: string } }>(failure.stderr).error.code).toBe('INVALID_ARGUMENT');

      const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
      try {
        expect(db.prepare(`SELECT status, state_version FROM tasks`).get()).toEqual({
          status: 'queued',
          state_version: 0,
        });
        expect(db.prepare(`SELECT COUNT(*) AS count FROM transition_idempotency`).get()).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    },
  );

  it('caches structural rejection but does not cache an unknown session', async () => {
    const repoDir = await makeRepo();
    const { session_id: sessionId } = await startQueuedSession(repoDir);
    const structuralArgs = transitionArgs(sessionId, 'implementing', '0', 'invalid:edge');
    const first = await runCliFailure(repoDir, structuralArgs);
    const replay = await runCliFailure(repoDir, structuralArgs);
    expect(replay.stderr).toBe(first.stderr);
    expect(parseJson<{ error: { code: string } }>(first.stderr).error.code).toBe('TRANSITION_NOT_ALLOWED');

    const missing = await runCliFailure(repoDir, transitionArgs('session_missing', 'framed', '0', 'missing:session'));
    expect(parseJson<{ error: { code: string } }>(missing.stderr).error.code).toBe('SESSION_NOT_FOUND');

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM transition_idempotency`).get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  it('rolls back state, history, and idempotency when the atomic write fails', async () => {
    const repoDir = await makeRepo();
    const { session_id: sessionId } = await startQueuedSession(repoDir);
    const dbPath = path.join(repoDir, '.threadloop/state/state.db');
    const triggerDb = new DatabaseSync(dbPath);
    triggerDb.exec(`
      CREATE TRIGGER reject_transition_idempotency
      BEFORE INSERT ON transition_idempotency
      BEGIN
        SELECT RAISE(ABORT, 'injected idempotency failure');
      END;
    `);
    triggerDb.close();

    const request = {
      sessionId,
      targetState: 'framed' as const,
      expectedStateVersion: 0,
      actor: 'agent' as const,
      input: {},
    };
    await expect(
      applySessionTransition(repoDir, {
        ...request,
        ...canonicalizeTransitionRequest(request, sha256),
        idempotencyKey: 'rollback:atomic',
      }),
    ).rejects.toThrow('injected idempotency failure');
    await resetSqliteConnections(repoDir);

    const unchanged = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(unchanged.prepare(`SELECT status, state_version FROM tasks`).get()).toEqual({
        status: 'queued',
        state_version: 0,
      });
      expect(unchanged.prepare(`SELECT COUNT(*) AS count FROM session_transitions`).get()).toEqual({ count: 0 });
      expect(unchanged.prepare(`SELECT COUNT(*) AS count FROM transition_idempotency`).get()).toEqual({ count: 0 });
    } finally {
      unchanged.close();
    }
  });

  it('keeps completion atomic behind an injected authoritative guard seam', async () => {
    const repoDir = await makeRepo();
    const { session_id: sessionId } = await startQueuedSession(repoDir);
    const dbPath = path.join(repoDir, '.threadloop/state/state.db');
    await prepareReadyForHumanFixture(repoDir, sessionId);

    const request = {
      sessionId,
      targetState: 'completed' as const,
      expectedStateVersion: 7,
      actor: 'agent' as const,
      input: { approval_receipt: 'future:#42' },
    };
    const result = await applySessionTransition(
      repoDir,
      {
        ...request,
        ...canonicalizeTransitionRequest(request, sha256),
        idempotencyKey: 'future:completion',
      },
      () => ({ allowed: true, guardFailures: [], requiredWork: [] }),
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        lifecycle: { state: 'completed', state_version: 8 },
      },
    });
    expect(result.ok && typeof result.data.session.ended_at).toBe('string');
    await resetSqliteConnections(repoDir);

    const completed = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(completed.prepare(`SELECT status, state_version FROM tasks`).get()).toEqual({
        status: 'completed',
        state_version: 8,
      });
      const ended = completed.prepare(`SELECT ended_at FROM sessions`).get() as { ended_at: string | null };
      expect(typeof ended.ended_at).toBe('string');
      expect(completed.prepare(`SELECT COUNT(*) AS count FROM active_sessions`).get()).toEqual({ count: 0 });
      expect(completed.prepare(`SELECT COUNT(*) AS count FROM active_state`).get()).toEqual({ count: 0 });
      expect(completed.prepare(`SELECT COUNT(*) AS count FROM session_transitions`).get()).toEqual({ count: 8 });
      expect(completed.prepare(`SELECT COUNT(*) AS count FROM transition_idempotency`).get()).toEqual({ count: 8 });
    } finally {
      completed.close();
    }
  });

  it('fails public completion closed without changing the ready-for-human session', async () => {
    const repoDir = await makeRepo();
    const { session_id: sessionId } = await startQueuedSession(repoDir);
    const dbPath = path.join(repoDir, '.threadloop/state/state.db');
    await prepareReadyForHumanFixture(repoDir, sessionId);

    const failure = await runCliFailure(repoDir, transitionArgs(sessionId, 'completed', '7', 'public:completion'));
    expect(
      parseJson<{ error: { code: string; details: { guard_failures: Array<{ owner_issue: number }> } } }>(
        failure.stderr,
      ),
    ).toMatchObject({
      error: { code: 'TRANSITION_GUARD_FAILED', details: { guard_failures: [{ owner_issue: 42 }] } },
    });

    const unchanged = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(unchanged.prepare(`SELECT status, state_version FROM tasks`).get()).toEqual({
        status: 'ready_for_human',
        state_version: 7,
      });
      expect(unchanged.prepare(`SELECT ended_at FROM sessions`).get()).toEqual({ ended_at: null });
      expect(unchanged.prepare(`SELECT COUNT(*) AS count FROM active_sessions`).get()).toEqual({ count: 1 });
    } finally {
      unchanged.close();
    }
  });
});

describe('session next command', { timeout: 15_000 }, () => {
  it('reports both repository paths for a pending rename', async () => {
    const repoDir = await makeRepo();
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
    await writeFile(path.join(repoDir, 'renamed-from.txt'), 'rename fixture\n', 'utf8');
    await execFileAsync('git', ['add', 'renamed-from.txt'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'add rename fixture'], { cwd: repoDir });
    const started = parseJson<{ data: { session_id: string } }>(
      (await runCli(repoDir, ['session', 'start', 'Rename task', '--goal', 'Observe both rename paths', '--json']))
        .stdout,
    );
    await execFileAsync('git', ['mv', 'renamed-from.txt', 'renamed-to.txt'], { cwd: repoDir });

    const next = parseJson<{
      data: { repository: { worktree: { changed_files: string[] } } };
    }>((await runCli(repoDir, ['session', 'next', '--session', started.data.session_id, '--json'])).stdout);

    expect(next.data.repository.worktree.changed_files).toEqual(
      expect.arrayContaining(['renamed-from.txt', 'renamed-to.txt']),
    );
  });

  it('returns live sanitized repository facts without mutating ThreadLoop state', async () => {
    const repoDir = await makeRepo();
    await writeFile(path.join(repoDir, 'README.md'), '# fixture\n', 'utf8');
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
    await execFileAsync('git', ['add', 'README.md'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repoDir });
    await execFileAsync(
      'git',
      [
        'remote',
        'add',
        'origin',
        'https://token:secret@github.com/nnennandukwe/threadloop.git?access_token=never#fragment',
      ],
      { cwd: repoDir },
    );
    const started = parseJson<{ data: { session_id: string } }>(
      (await runCli(repoDir, ['session', 'start', 'Next task', '--goal', 'Inspect without mutation', '--json'])).stdout,
    );
    await execFileAsync('git', ['add', '-f', '.threadloop/config.json'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'track ThreadLoop config'], { cwd: repoDir });
    const dbPath = path.join(repoDir, '.threadloop/state/state.db');
    const beforeBytes = await readFile(dbPath);
    await writeFile(path.join(repoDir, 'README.md'), '# changed\n', 'utf8');
    await writeFile(path.join(repoDir, 'untracked.txt'), 'new\n', 'utf8');
    await writeFile(path.join(repoDir, 'staged.txt'), 'staged\n', 'utf8');
    await execFileAsync('git', ['add', 'staged.txt'], { cwd: repoDir });
    const trackedConfig = await readFile(path.join(repoDir, '.threadloop/config.json'), 'utf8');
    await writeFile(path.join(repoDir, '.threadloop/config.json'), `${trackedConfig}\n`, 'utf8');

    const next = parseJson<{
      ok: true;
      command: string;
      data: {
        lifecycle: { state: string; state_version: number; history: unknown[] };
        candidate: { target_state: string; executable: boolean };
        repository: {
          identity: { source: string; host: string | null; owner: string | null; name: string };
          branch: string | null;
          head_sha: string | null;
          worktree: { clean: boolean; changed_files: string[] };
        };
        staleness: Record<string, unknown>;
        repair_budget: Record<string, unknown>;
        audit: { root: string };
        terminal_reason: string | null;
      };
    }>((await runCli(repoDir, ['session', 'next', '--session', started.data.session_id, '--json'])).stdout);

    expect(next).toMatchObject({
      ok: true,
      command: 'session next',
      data: {
        contract_version: 4,
        session_id: started.data.session_id,
        lifecycle: {
          state: 'queued',
          state_version: 0,
          blocked_from_state: null,
          phase: 'pre_pr',
          storage_schema_version: 7,
          contract_status: 'current',
          history: [],
        },
        pre_pr_review: {
          status: 'not_started',
          iteration_count: 0,
          findings: [],
        },
        implementation_basis: {
          head_sha: null,
          source: null,
        },
        candidate: { from_state: 'queued', target_state: 'framed', expected_state_version: 0, executable: true },
        guard_failures: [],
        required_work: [],
        repository: {
          identity: { source: 'origin', host: 'github.com', owner: 'nnennandukwe', name: 'threadloop' },
          worktree: {
            clean: false,
            changed_files: ['.threadloop/config.json', 'README.md', 'staged.txt', 'untracked.txt'],
          },
        },
        staleness: {
          status: 'missing',
          is_stale: false,
          stale_receipt_ids: [],
        },
        repair_budget: {
          status: 'available',
          attempts_used: 0,
          limit: 3,
          remaining: 3,
          exhausted: false,
        },
        review: {
          status: 'policy_missing',
          snapshot_id: null,
          blocking_findings: [],
          human_approval_current: false,
          merged: false,
        },
        audit: {
          status: 'valid',
          event_count: 1,
          coverage: 'full',
        },
        next_human_action: null,
        terminal_reason: null,
      },
    });
    expect(next.data.audit.root).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(next)).not.toContain('token');
    expect(JSON.stringify(next)).not.toContain(repoDir);
    expect(await readFile(dbPath)).toEqual(beforeBytes);
  });

  it('reads a canonical schema-v2 database without migrating or creating v4 objects', async () => {
    const repoDir = await makeRepo();
    const dbPath = createSchemaV2(repoDir);

    const next = parseJson<{
      data: {
        lifecycle: { state: string; state_version: number };
        repository: { branch: string | null; head_sha: string | null };
      };
    }>((await runCli(repoDir, ['session', 'next', '--session', 'session_queued', '--json'])).stdout);
    expect(next.data).toMatchObject({
      lifecycle: { state: 'queued', state_version: 0, blocked_from_state: null },
      repository: { branch: null, head_sha: null },
    });

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get()).toEqual({ value: '2' });
      expect(
        db
          .prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'session_transitions'`)
          .get(),
      ).toEqual({ count: 0 });
      expect(
        (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map((column) => column.name),
      ).not.toContain('blocked_from_state');
    } finally {
      db.close();
    }
  });

  it('fails schema-v1 next reads without migration or repair', async () => {
    const repoDir = await makeRepo();
    const dbPath = createSchemaV2(repoDir);
    const downgrade = new DatabaseSync(dbPath);
    downgrade.prepare(`UPDATE metadata SET value = '1' WHERE key = 'schema_version'`).run();
    downgrade.close();

    const failure = await runCliFailure(repoDir, ['session', 'next', '--session', 'session_queued', '--json']);
    expect(parseJson<{ error: { code: string; message: string } }>(failure.stderr)).toMatchObject({
      error: {
        code: 'STATE_CORRUPTED',
        message: 'ThreadLoop schema version 1 requires migration before session next can read lifecycle state.',
      },
    });

    const unchanged = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(unchanged.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get()).toEqual({
        value: '1',
      });
      expect(
        unchanged
          .prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'session_transitions'`)
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      unchanged.close();
    }
  });

  it('reports blocked recovery and completed terminal states honestly', async () => {
    const repoDir = await makeRepo();
    const started = parseJson<{ data: { session_id: string } }>(
      (await runCli(repoDir, ['session', 'start', 'Terminal task', '--goal', 'Report terminal state', '--json']))
        .stdout,
    );
    const sessionId = started.data.session_id;
    await runCli(repoDir, [
      'session',
      'transition',
      'blocked',
      '--session',
      sessionId,
      '--expected-state-version',
      '0',
      '--idempotency-key',
      'blocked:next',
      '--actor',
      'agent',
      '--input',
      '{"block":{"reason":"No access","evidence_ref":"incident:123","recovery":"Restore access","stop_code":"ACCESS_DENIED"}}',
      '--json',
    ]);

    const blocked = parseJson<{
      data: { candidate: { target_state: string; executable: boolean }; terminal_reason: string };
    }>((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout);
    expect(blocked.data).toMatchObject({
      candidate: { from_state: 'blocked', target_state: 'queued', expected_state_version: 1, executable: false },
      terminal_reason: 'BLOCKED_REQUIRES_HUMAN_RECOVERY',
    });

    await applyFixtureTransition(repoDir, sessionId, 'queued', 1, 'fixture:recover', {
      recovery: {
        approved_by: 'test-controller',
        evidence_ref: 'recovery:test',
        reason: 'Prepare a completed terminal fixture.',
      },
    });
    for (const [targetState, expectedStateVersion] of [
      ['framed', 2],
      ['proof_ready', 3],
      ['implementing', 4],
      ['verifying', 5],
      ['pre_pr_reviewing', 6],
      ['reviewing', 7],
      ['ready_for_human', 8],
      ['completed', 9],
    ] as const) {
      await applyFixtureTransition(repoDir, sessionId, targetState, expectedStateVersion, `terminal:${targetState}`);
    }

    const completed = parseJson<{ data: { candidate: null; terminal_reason: string } }>(
      (await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout,
    );
    expect(completed.data).toMatchObject({ candidate: null, terminal_reason: 'COMPLETED' });
  });
});
