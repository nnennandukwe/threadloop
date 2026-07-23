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
import { canonicalizeTransitionRequest } from '../../src/domain/session-transition.js';

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

describe('schema v4 proof persistence', () => {
  it('migrates a canonical schema-v2 database without changing lifecycle state', async () => {
    const repoDir = await makeRepo();
    const dbPath = createSchemaV2(repoDir);

    await ensureStateDatabase(repoDir);
    await resetSqliteConnections(repoDir);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get()).toEqual({ value: '4' });
      expect(
        (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map((column) => column.name),
      ).toContain('blocked_from_state');
      expect(
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_transitions', 'transition_idempotency', 'proof_plans', 'gate_receipts') ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: 'gate_receipts' },
        { name: 'proof_plans' },
        { name: 'session_transitions' },
        { name: 'transition_idempotency' },
      ]);
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

  it('rolls back every schema-v4 change when migration validation fails', async () => {
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
});

describe('session transition command', { timeout: 20_000 }, () => {
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
    const { session_id: sessionId, task_id: taskId } = await startQueuedSession(repoDir);
    const dbPath = path.join(repoDir, '.threadloop/state/state.db');
    const setup = new DatabaseSync(dbPath);
    setup.prepare(`UPDATE tasks SET status = 'ready_for_human', state_version = 7 WHERE id = ?`).run(taskId);
    setup.close();

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
      expect(completed.prepare(`SELECT COUNT(*) AS count FROM session_transitions`).get()).toEqual({ count: 1 });
      expect(completed.prepare(`SELECT COUNT(*) AS count FROM transition_idempotency`).get()).toEqual({ count: 1 });
    } finally {
      completed.close();
    }
  });

  it('fails public completion closed without changing the ready-for-human session', async () => {
    const repoDir = await makeRepo();
    const { session_id: sessionId } = await startQueuedSession(repoDir);
    const dbPath = path.join(repoDir, '.threadloop/state/state.db');
    const setup = new DatabaseSync(dbPath);
    setup.prepare(`UPDATE tasks SET status = 'ready_for_human', state_version = 7`).run();
    setup.close();

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
        lifecycle: { state: string; state_version: number };
        candidate: { target_state: string; executable: boolean };
        repository: {
          identity: { source: string; host: string | null; owner: string | null; name: string };
          branch: string | null;
          head_sha: string | null;
          worktree: { clean: boolean; changed_files: string[] };
        };
        staleness: Record<string, unknown>;
        repair_budget: Record<string, unknown>;
        terminal_reason: string | null;
      };
    }>((await runCli(repoDir, ['session', 'next', '--session', started.data.session_id, '--json'])).stdout);

    expect(next).toMatchObject({
      ok: true,
      command: 'session next',
      data: {
        contract_version: 1,
        session_id: started.data.session_id,
        lifecycle: { state: 'queued', state_version: 0, blocked_from_state: null },
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
        terminal_reason: null,
      },
    });
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

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'));
    db.prepare(`UPDATE tasks SET status = 'completed', state_version = 2, blocked_from_state = NULL`).run();
    db.prepare(`UPDATE sessions SET ended_at = '2026-07-23T13:00:00.000Z'`).run();
    db.prepare(`DELETE FROM active_sessions`).run();
    db.prepare(`DELETE FROM active_state`).run();
    db.close();

    const completed = parseJson<{ data: { candidate: null; terminal_reason: string } }>(
      (await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout,
    );
    expect(completed.data).toMatchObject({ candidate: null, terminal_reason: 'COMPLETED' });
  });
});
