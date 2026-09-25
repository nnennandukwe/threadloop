import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseJson,
  runCli,
  runCliError,
  runCliFailure,
  sessionNext,
  transition,
  transitionArgs,
  transitionFailure,
} from '../helpers/cli.js';
import {
  cleanupTemporaryState,
  commitFiles,
  forceStates,
  forceTransition,
  git,
  makeRepo,
  startSession,
} from '../helpers/session.js';
import {
  countRows,
  deleteAuditLedger,
  readLifecycle,
  stateDbPath,
  withStateDb,
  withTriggersDisabled,
} from '../helpers/state-db.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import {
  applySessionTransition,
  closeSqliteConnections,
  ensureStateDatabase,
} from '../../src/adapters/fs/sqlite-store.js';
import { DatabaseSync } from '../../src/adapters/fs/sqlite-driver.js';
import { createAuditEvent, ZERO_AUDIT_HASH } from '../../src/domain/audit.js';
import { canonicalizeTransitionRequest, type TransitionRequest } from '../../src/domain/session-transition.js';

/** A Git repository with a ThreadLoop config and state directory but no state database yet. */
async function makeThreadloopRepo() {
  const repoDir = await makeRepo();
  await mkdir(path.join(repoDir, '.threadloop/state'), { recursive: true });
  await writeFile(
    path.join(repoDir, '.threadloop/config.json'),
    `${JSON.stringify({ version: 1, createdAt: '2026-07-23T12:00:00.000Z' }, null, 2)}\n`,
    'utf8',
  );
  return repoDir;
}

/** Every forward state from `queued` to `ready_for_human`, forced from state version 0. */
const readyForHuman: Array<TransitionRequest['targetState']> = [
  'framed',
  'proof_ready',
  'implementing',
  'verifying',
  'pre_pr_reviewing',
  'reviewing',
  'ready_for_human',
];

/** A current-schema state database for tests that corrupt or downgrade it. */
async function createCurrentDatabase(repoDir: string) {
  await ensureStateDatabase(repoDir);
  closeSqliteConnections(repoDir);
}

const setSchemaVersion = (repoDir: string, version: string) =>
  withStateDb(repoDir, (db) => db.prepare(`UPDATE metadata SET value = ? WHERE key = 'schema_version'`).run(version), {
    readOnly: false,
  });

const readSchemaVersion = (repoDir: string) =>
  withStateDb(repoDir, (db) => db.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get());

/**
 * Replaces a session's ledger with the `audit_activated` genesis its schema-v6 upgrade recorded, which still
 * exists in databases created before the audit ledger and must keep verifying.
 */
function activateLegacyAuditLedger(repoDir: string, sessionId: string, state: string, stateVersion: number) {
  const activation = createAuditEvent(
    {
      id: 'audit_legacy_activation',
      sessionId,
      sequence: 1,
      eventType: 'audit_activated',
      recordedAt: '2026-07-29T00:00:00.000Z',
      stateVersion,
      previousSha256: ZERO_AUDIT_HASH,
      payload: {
        coverage: 'schema_v6_forward',
        lifecycle_state_at_activation: state,
        note: 'Historical decisions before schema v6 are not reconstructed.',
      },
    },
    sha256,
  );
  deleteAuditLedger(repoDir, sessionId);
  withStateDb(
    repoDir,
    (db) => {
      db.prepare(`UPDATE tasks SET status = ?, state_version = ?`).run(state, stateVersion);
      db.prepare(
        `INSERT INTO audit_events (id, session_id, sequence, event_type, state_version, previous_sha256, event_json,
          event_sha256, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        activation.value.id,
        sessionId,
        1,
        'audit_activated',
        stateVersion,
        ZERO_AUDIT_HASH,
        activation.json,
        activation.sha256,
        activation.value.recorded_at,
      );
    },
    { readOnly: false },
  );
}

afterEach(cleanupTemporaryState);

describe('schema v7 lifecycle and audit persistence', () => {
  it('bootstraps a metadata-less state database before enforcing migration policy', async () => {
    const repoDir = await makeThreadloopRepo();
    new DatabaseSync(stateDbPath(repoDir)).close();

    expect((await startSession(repoDir, 'Recovered bootstrap')).session_id).toMatch(/^session_/);
    expect(readSchemaVersion(repoDir)).toEqual({ value: '8' });
    expect(countRows(repoDir, 'sessions')).toBe(1);
  });

  it('retains post-PR phase when audit coverage begins in reviewing', async () => {
    const repoDir = await makeThreadloopRepo();
    const { session_id: sessionId } = await startSession(repoDir);
    closeSqliteConnections(repoDir);
    activateLegacyAuditLedger(repoDir, sessionId, 'reviewing', 4);

    expect(await sessionNext(repoDir, sessionId)).toMatchObject({ lifecycle: { phase: 'post_pr' } });

    // Enforcement, not only the projection, must derive the phase from the legacy activation genesis.
    await forceTransition(repoDir, sessionId, 'repairing', 4, 'legacy:repair');
    await forceTransition(repoDir, sessionId, 'verifying', 5, 'legacy:verify');
    const request: TransitionRequest = {
      sessionId,
      targetState: 'implementing',
      expectedStateVersion: 6,
      actor: 'agent',
      input: {},
    };
    const forbidden = await applySessionTransition(
      repoDir,
      { ...request, idempotencyKey: 'legacy:implementing-reentry', ...canonicalizeTransitionRequest(request, sha256) },
      () => ({ allowed: true, guardFailures: [], requiredWork: [] }),
    );
    expect(forbidden).toMatchObject({
      ok: false,
      error: {
        code: 'TRANSITION_NOT_ALLOWED',
        details: { decision_code: 'POST_PR_IMPLEMENTATION_REENTRY_FORBIDDEN' },
      },
    });
  });

  it('retains pre-PR authority for a legacy repair history that never entered reviewing', async () => {
    const repoDir = await makeThreadloopRepo();
    const { session_id: sessionId } = await startSession(repoDir);
    await forceStates(
      repoDir,
      sessionId,
      0,
      ['framed', 'proof_ready', 'implementing', 'verifying', 'repairing'],
      'legacy-pre-pr',
    );
    closeSqliteConnections(repoDir);
    setSchemaVersion(repoDir, '7');

    await runCli(repoDir, ['init']);
    expect(await sessionNext(repoDir, sessionId)).toMatchObject({
      lifecycle: { phase: 'pre_pr' },
      repair_budget: { attempts_used: 1 },
    });

    await forceTransition(repoDir, sessionId, 'verifying', 5, 'legacy-pre-pr:verify');
    await expect(
      forceTransition(repoDir, sessionId, 'implementing', 6, 'legacy-pre-pr:implement'),
    ).resolves.toMatchObject({ data: { lifecycle: { state: 'implementing', state_version: 7 } } });
  });

  it('projects schema-v7 migration requirements read-only and migrates only through init', async () => {
    const repoDir = await makeThreadloopRepo();
    const { session_id: sessionId } = await startSession(repoDir, 'Migration task');
    closeSqliteConnections(repoDir);
    setSchemaVersion(repoDir, '7');
    const history = () => ({
      transitions: countRows(repoDir, 'session_transitions'),
      audit: countRows(repoDir, 'audit_events'),
    });
    const before = history();
    const beforeBytes = await readFile(stateDbPath(repoDir));

    expect(await sessionNext(repoDir, sessionId)).toMatchObject({
      contract_version: 4,
      lifecycle: { storage_schema_version: 7, contract_status: 'migration_required' },
      candidate: null,
      guard_failures: [{ code: 'SESSION_SCHEMA_MIGRATION_REQUIRED' }],
      required_work: [{ code: 'MIGRATE_SESSION_SCHEMA' }],
      pre_pr_review: { status: 'migration_required' },
    });
    expect(await readFile(stateDbPath(repoDir))).toEqual(beforeBytes);

    for (const args of [
      ['session', 'gate', 'run', 'unit', '--session', sessionId, '--json'],
      transitionArgs(sessionId, 'framed', 0, 'migration:transition'),
      ['session', 'gate', 'import', 'missing-package.json', '--session', sessionId, '--json'],
      ['session', 'review', 'import', 'missing-package.json', '--session', sessionId, '--json'],
      ['audit', 'show', '--session', sessionId, '--json'],
      ['audit', 'verify', '--session', sessionId, '--json'],
      ['session', 'start', 'Second task', '--goal', 'Must not migrate implicitly', '--json'],
    ]) {
      const { error } = await runCliError(repoDir, args);
      expect(error).toMatchObject({
        code: 'SESSION_SCHEMA_MIGRATION_REQUIRED',
        details: { storage_schema_version: 7 },
      });
      expect(error.details.hint).toContain('Run `threadloop init`');
      expect(await readFile(stateDbPath(repoDir))).toEqual(beforeBytes);
    }

    await runCli(repoDir, ['init']);
    closeSqliteConnections(repoDir);
    expect(readSchemaVersion(repoDir)).toEqual({ value: '8' });
    expect(history()).toEqual(before);
  });

  it('revalidates canonical schema metadata on the ready read path', async () => {
    const repoDir = await makeThreadloopRepo();
    await ensureStateDatabase(repoDir);
    setSchemaVersion(repoDir, '3.0');

    await expect(ensureStateDatabase(repoDir)).rejects.toThrow('Unsupported ThreadLoop schema version: 3.0');
    expect(readSchemaVersion(repoDir)).toEqual({ value: '3.0' });
  });

  it.each(['8.0', '08', '8e0', ' 8 ', '\t8\n'])(
    'rejects malformed schema metadata %j before mutation',
    async (rawVersion) => {
      const repoDir = await makeThreadloopRepo();
      await createCurrentDatabase(repoDir);
      const journalMode = () => withStateDb(repoDir, (db) => db.prepare(`PRAGMA journal_mode`).get());
      const initialJournalMode = journalMode();
      setSchemaVersion(repoDir, rawVersion);

      await expect(ensureStateDatabase(repoDir)).rejects.toThrow(
        `Unsupported ThreadLoop schema version: ${rawVersion}`,
      );
      closeSqliteConnections(repoDir);
      expect(readSchemaVersion(repoDir)).toEqual({ value: rawVersion });
      expect(journalMode()).toEqual(initialJournalMode);
    },
  );

  it('returns STATE_CORRUPTED for malformed metadata through the public transition envelope', async () => {
    const repoDir = await makeThreadloopRepo();
    await createCurrentDatabase(repoDir);
    setSchemaVersion(repoDir, '2.0');

    expect(await transitionFailure(repoDir, 'session_queued', 'framed', 0, 'schema:malformed')).toMatchObject({
      error: { code: 'STATE_CORRUPTED', message: 'Unsupported ThreadLoop schema version: 2.0' },
    });
    expect(readSchemaVersion(repoDir)).toEqual({ value: '2.0' });
  });

  it('rolls back every upgrade change when schema validation fails', async () => {
    const repoDir = await makeThreadloopRepo();
    await createCurrentDatabase(repoDir);
    withStateDb(
      repoDir,
      (db) =>
        db.exec(`
          UPDATE metadata SET value = '7' WHERE key = 'schema_version';
          DROP TRIGGER transition_idempotency_no_update;
          DROP TRIGGER transition_idempotency_no_delete;
          DROP TRIGGER transition_idempotency_no_replace;
          DROP TABLE transition_idempotency;
          CREATE TABLE transition_idempotency (unexpected TEXT NOT NULL);
        `),
      { readOnly: false },
    );

    await expect(ensureStateDatabase(repoDir)).rejects.toThrow('Invalid schema for transition_idempotency');
    closeSqliteConnections(repoDir);

    expect(readSchemaVersion(repoDir)).toEqual({ value: '7' });
    withStateDb(repoDir, (db) => {
      expect(db.prepare(`PRAGMA table_info(transition_idempotency)`).all()).toMatchObject([{ name: 'unexpected' }]);
      expect(
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'transition_idempotency_no_%'`)
          .all(),
      ).toEqual([]);
    });
  });

  it('makes applied transition and idempotency history immutable in schema v7', async () => {
    const repoDir = await makeThreadloopRepo();
    const { session_id: sessionId } = await startSession(repoDir, 'Immutable history');
    await transition(repoDir, sessionId, 'framed', 0, 'immutability:framed');
    expect((await transitionFailure(repoDir, sessionId, 'proof_ready', 1, 'immutability:framed')).error.code).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
    closeSqliteConnections(repoDir);

    withStateDb(
      repoDir,
      (db) => {
        for (const [table, noun] of [
          ['session_transitions', 'session transitions'],
          ['transition_idempotency', 'transition idempotency records'],
          ['transition_idempotency_conflicts', 'transition idempotency conflict records'],
        ]) {
          const immutable = `${noun} are immutable`;
          // A BEFORE UPDATE trigger fires for every matched row, so a no-op assignment is enough to prove it.
          expect(() =>
            db.prepare(`UPDATE ${table} SET session_id = session_id WHERE session_id = ?`).run(sessionId),
          ).toThrow(immutable);
          expect(() => db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId)).toThrow(immutable);
          expect(() =>
            db.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} WHERE session_id = ?`).run(sessionId),
          ).toThrow(immutable);
        }
        expect(
          db
            .prepare(`SELECT from_state, to_state, from_state_version, to_state_version FROM session_transitions`)
            .all(),
        ).toEqual([{ from_state: 'queued', to_state: 'framed', from_state_version: 0, to_state_version: 1 }]);
      },
      { readOnly: false },
    );
    expect(countRows(repoDir, 'transition_idempotency')).toBe(1);
    expect(countRows(repoDir, 'transition_idempotency_conflicts')).toBe(1);
  });

  it('fails session next closed when transition history no longer matches the audit ledger', async () => {
    const repoDir = await makeThreadloopRepo();
    const { session_id: sessionId } = await startSession(repoDir, 'Corrupt history');
    await transition(repoDir, sessionId, 'framed', 0, 'corrupt-history:framed');
    closeSqliteConnections(repoDir);
    withStateDb(
      repoDir,
      (db) =>
        withTriggersDisabled(db, 'session_transitions', () =>
          db
            .prepare(`UPDATE session_transitions SET input_json = '{"tampered":true}' WHERE session_id = ?`)
            .run(sessionId),
        ),
      { readOnly: false },
    );

    for (const failure of [
      await runCliError(repoDir, ['session', 'next', '--session', sessionId, '--json']),
      await transitionFailure(repoDir, sessionId, 'framed', 0, 'corrupt-history:framed'),
    ]) {
      expect(failure.error.code).toBe('STATE_CORRUPTED');
      expect(failure.error.message).toContain('Invalid session transition history');
    }
    expect(readLifecycle(repoDir)).toEqual({ status: 'framed', state_version: 1 });
    expect(countRows(repoDir, 'session_transitions', 'session_id = ?', sessionId)).toBe(1);
  });

  it('maps a missing audit genesis during session next to actionable audit recovery', async () => {
    const repoDir = await makeThreadloopRepo();
    const { session_id: sessionId } = await startSession(repoDir);
    closeSqliteConnections(repoDir);
    deleteAuditLedger(repoDir, sessionId);

    expect(await runCliError(repoDir, ['session', 'next', '--session', sessionId, '--json'])).toMatchObject({
      error: {
        code: 'AUDIT_VERIFICATION_FAILED',
        details: {
          session_id: sessionId,
          audit_error: { code: 'AUDIT_SEQUENCE_MISMATCH' },
          hint: 'Restore the ledger from trusted storage.',
        },
      },
    });
    expect(readLifecycle(repoDir)).toEqual({ status: 'queued', state_version: 0 });
    expect(countRows(repoDir, 'audit_events')).toBe(0);
  });

  it('fails reads and writes closed when the task projection drifts from authoritative history', async () => {
    const repoDir = await makeThreadloopRepo();
    const { session_id: sessionId, task_id: taskId } = await startSession(repoDir);
    await transition(repoDir, sessionId, 'framed', 0, 'projection-drift:framed');
    closeSqliteConnections(repoDir);
    const auditCount = countRows(repoDir, 'audit_events', 'session_id = ?', sessionId);
    withStateDb(repoDir, (db) => db.prepare(`UPDATE tasks SET status = 'implementing' WHERE id = ?`).run(taskId), {
      readOnly: false,
    });

    for (const args of [
      ['session', 'next', '--session', sessionId, '--json'],
      transitionArgs(sessionId, 'verifying', 1, 'projection-drift:transition'),
      transitionArgs(sessionId, 'verifying', 1, 'projection-drift:framed', { changed_request: true }),
    ]) {
      const { error } = await runCliError(repoDir, args);
      expect(error.code).toBe('STATE_CORRUPTED');
      expect(error.message).toContain('current lifecycle projection does not match transition history');
    }
    expect(readLifecycle(repoDir)).toEqual({ status: 'implementing', state_version: 1 });
    expect(countRows(repoDir, 'session_transitions')).toBe(1);
    expect(countRows(repoDir, 'audit_events', 'session_id = ?', sessionId)).toBe(auditCount);
  });

  it('binds a no-transition task projection to the session-started genesis event', async () => {
    const repoDir = await makeThreadloopRepo();
    const { session_id: sessionId, task_id: taskId } = await startSession(repoDir);
    closeSqliteConnections(repoDir);
    withStateDb(repoDir, (db) => db.prepare(`UPDATE tasks SET status = 'implementing' WHERE id = ?`).run(taskId), {
      readOnly: false,
    });

    const { error } = await runCliError(repoDir, ['session', 'next', '--session', sessionId, '--json']);
    expect(error.code).toBe('STATE_CORRUPTED');
    expect(error.message).toContain('current lifecycle projection does not match transition history');
  });

  it('rolls back the schema upgrade when transition history is inconsistent', async () => {
    const repoDir = await makeThreadloopRepo();
    const { session_id: sessionId } = await startSession(repoDir, 'Legacy corrupt history');
    await transition(repoDir, sessionId, 'framed', 0, 'legacy-corrupt:framed');
    closeSqliteConnections(repoDir);
    // The triggers stay dropped: a v7 database without them is what the rolled-back upgrade must leave behind.
    withStateDb(
      repoDir,
      (db) =>
        db.exec(`
          UPDATE metadata SET value = '7' WHERE key = 'schema_version';
          DROP TRIGGER session_transitions_no_update;
          DROP TRIGGER session_transitions_no_delete;
          DROP TRIGGER session_transitions_no_replace;
          UPDATE session_transitions SET input_json = '{"tampered":true}';
        `),
      { readOnly: false },
    );

    const failure = await runCliFailure(repoDir, ['init']);
    expect(failure.stderr).toContain('threadloop [STATE_CORRUPTED]: Invalid session transition history');
    expect(failure.stderr).toContain(
      'Hint: Restore transition history from trusted storage, then rerun `threadloop init`.',
    );
    closeSqliteConnections(repoDir);

    expect(readSchemaVersion(repoDir)).toEqual({ value: '7' });
    withStateDb(repoDir, (db) => {
      expect(
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'session_transitions_no_%'`)
          .all(),
      ).toEqual([]);
      expect(db.prepare(`SELECT input_json FROM session_transitions`).get()).toEqual({
        input_json: '{"tampered":true}',
      });
    });
  });
});

describe('session transition command', () => {
  it('atomically transitions queued to framed and replays an identical wake exactly', async () => {
    const repoDir = await makeThreadloopRepo();
    const { session_id: sessionId, task_id: taskId } = await startSession(repoDir);
    const key = `wake:${sessionId}:0`;

    const first = await runCli(repoDir, transitionArgs(sessionId, 'framed', 0, key, '{"z":2,"a":1}'));
    const replay = await runCli(repoDir, transitionArgs(sessionId, 'framed', 0, key, '{"a":1,"z":2}'));

    expect(parseJson(first.stdout)).toMatchObject({
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
    expect(readLifecycle(repoDir)).toEqual({ status: 'framed', state_version: 1 });
    expect(countRows(repoDir, 'session_transitions')).toBe(1);
    expect(countRows(repoDir, 'transition_idempotency')).toBe(1);
    expect(withStateDb(repoDir, (db) => db.prepare(`SELECT task_id, session_id FROM active_state`).get())).toEqual({
      task_id: taskId,
      session_id: sessionId,
    });
  });

  it('rejects changed content for an existing key, caches stale failures, and validates proof plans first', async () => {
    const repoDir = await makeThreadloopRepo();
    const { session_id: sessionId } = await startSession(repoDir);
    const key = `wake:${sessionId}:0`;
    await transition(repoDir, sessionId, 'framed', 0, key);

    expect((await transitionFailure(repoDir, sessionId, 'blocked', 0, key, { block: {} })).error.code).toBe(
      'IDEMPOTENCY_CONFLICT',
    );

    const staleArgs = transitionArgs(sessionId, 'proof_ready', 0, `wake:${sessionId}:stale`);
    const stale = await runCliFailure(repoDir, staleArgs);
    expect((await runCliFailure(repoDir, staleArgs)).stderr).toBe(stale.stderr);
    expect(parseJson<{ error: { code: string } }>(stale.stderr).error.code).toBe('STATE_VERSION_CONFLICT');

    const guardedArgs = transitionArgs(sessionId, 'proof_ready', 1, `wake:${sessionId}:guard`);
    const guarded = await runCliFailure(repoDir, guardedArgs);
    expect((await runCliFailure(repoDir, guardedArgs)).stderr).toBe(guarded.stderr);
    expect(parseJson(guarded.stderr)).toMatchObject({
      error: { code: 'INVALID_ARGUMENT', details: { field: 'proof_plan' } },
    });

    const rejectedKey = `wake:${sessionId}:rejected`;
    await transitionFailure(repoDir, sessionId, 'blocked', 1, rejectedKey, { block: {} });
    expect((await transitionFailure(repoDir, sessionId, 'proof_ready', 1, rejectedKey)).error.code).toBe(
      'IDEMPOTENCY_CONFLICT',
    );

    expect(readLifecycle(repoDir)).toEqual({ status: 'framed', state_version: 1 });
    expect(countRows(repoDir, 'session_transitions')).toBe(1);
    expect(
      withStateDb(repoDir, (db) =>
        db.prepare(`SELECT outcome, COUNT(*) AS count FROM transition_idempotency GROUP BY outcome`).all(),
      ),
    ).toEqual([
      { outcome: 'applied', count: 1 },
      { outcome: 'rejected', count: 2 },
    ]);
  });

  it('audits each distinct conflicting request once while replaying an exact conflict idempotently', async () => {
    const repoDir = await makeThreadloopRepo();
    const { session_id: sessionId } = await startSession(repoDir);
    const key = `wake:${sessionId}:conflict`;
    await transition(repoDir, sessionId, 'framed', 0, key);

    const firstConflictArgs = transitionArgs(sessionId, 'blocked', 0, key, { block: { reason: 'first' } });
    const [firstConflict, firstReplay] = await Promise.all([
      runCliFailure(repoDir, firstConflictArgs),
      runCliFailure(repoDir, firstConflictArgs),
    ]);
    expect(firstReplay.stderr).toBe(firstConflict.stderr);
    expect(parseJson<{ error: { code: string } }>(firstConflict.stderr).error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(
      (await transitionFailure(repoDir, sessionId, 'proof_ready', 0, key, { proof_plan: { marker: 'second' } })).error
        .code,
    ).toBe('IDEMPOTENCY_CONFLICT');

    expect(readLifecycle(repoDir)).toEqual({ status: 'framed', state_version: 1 });
    expect(countRows(repoDir, 'transition_idempotency_conflicts')).toBe(2);
    const conflictAudits = withStateDb(repoDir, (db) =>
      db
        .prepare(`SELECT event_json FROM audit_events WHERE session_id = ? AND event_type = 'guard_decision'`)
        .all(sessionId)
        .map((row) => parseJson<{ payload: { error?: { code?: string } } }>(String(row.event_json)))
        .filter((event) => event.payload.error?.code === 'IDEMPOTENCY_CONFLICT'),
    );
    expect(conflictAudits).toHaveLength(2);
  });

  it('preserves and restores the prior state only with complete blocking and recovery evidence', async () => {
    const repoDir = await makeThreadloopRepo();
    const { session_id: sessionId } = await startSession(repoDir);
    const recovery = { approved_by: 'Nnenna', evidence_ref: 'incident:123:resolved', reason: 'Access restored' };

    expect(
      (
        await transitionFailure(repoDir, sessionId, 'blocked', 0, 'block:incomplete', {
          block: { reason: 'No access' },
        })
      ).error.code,
    ).toBe('TRANSITION_GUARD_FAILED');
    await transition(repoDir, sessionId, 'blocked', 0, 'block:complete', {
      block: {
        stop_code: 'ACCESS_DENIED',
        recovery: 'Restore access',
        reason: 'No access',
        evidence_ref: 'incident:123',
      },
    });
    expect(
      (await transitionFailure(repoDir, sessionId, 'framed', 1, 'recovery:wrong-target', { recovery })).error.code,
    ).toBe('TRANSITION_NOT_ALLOWED');
    await transition(repoDir, sessionId, 'queued', 1, 'recovery:complete', { recovery });

    expect(
      withStateDb(repoDir, (db) => db.prepare(`SELECT status, state_version, blocked_from_state FROM tasks`).get()),
    ).toEqual({
      status: 'queued',
      state_version: 2,
      blocked_from_state: null,
    });
    expect(countRows(repoDir, 'session_transitions')).toBe(2);
  });

  it('allows one winner across processes racing from the same state version', async () => {
    const repoDir = await makeThreadloopRepo();
    const { session_id: sessionId } = await startSession(repoDir);
    const results = await Promise.allSettled([
      runCli(repoDir, transitionArgs(sessionId, 'framed', 0, 'race:left')),
      runCli(repoDir, transitionArgs(sessionId, 'framed', 0, 'race:right')),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(parseJson<{ error: { code: string } }>((rejected?.reason as { stderr?: string }).stderr).error.code).toBe(
      'STATE_VERSION_CONFLICT',
    );
    expect(countRows(repoDir, 'session_transitions')).toBe(1);
    expect(countRows(repoDir, 'transition_idempotency')).toBe(2);
  });

  it('deduplicates identical cross-process wakes into one transition record', async () => {
    const repoDir = await makeThreadloopRepo();
    const { session_id: sessionId } = await startSession(repoDir);
    const args = transitionArgs(sessionId, 'framed', 0, 'race:identical');
    const [left, right] = await Promise.all([runCli(repoDir, args), runCli(repoDir, args)]);

    expect(left.stdout).toBe(right.stdout);
    expect(countRows(repoDir, 'session_transitions')).toBe(1);
    expect(countRows(repoDir, 'transition_idempotency')).toBe(1);
  });

  it('rejects malformed public input before mutation', async () => {
    const repoDir = await makeThreadloopRepo();
    const { session_id: sessionId } = await startSession(repoDir);

    for (const [target, version, key, actor, input] of [
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
    ] as const) {
      const scenario = `target=${target} version=${version} key=${key} actor=${actor} input=${input}`;
      const { error } = await transitionFailure(repoDir, sessionId, target, version, key, input, actor);
      expect(error.code, scenario).toBe('INVALID_ARGUMENT');
      expect(readLifecycle(repoDir), scenario).toEqual({ status: 'queued', state_version: 0 });
      expect(countRows(repoDir, 'transition_idempotency'), scenario).toBe(0);
    }
  });

  it('caches structural rejection but does not cache an unknown session', async () => {
    const repoDir = await makeThreadloopRepo();
    const { session_id: sessionId } = await startSession(repoDir);
    const structuralArgs = transitionArgs(sessionId, 'implementing', 0, 'invalid:edge');
    const first = await runCliFailure(repoDir, structuralArgs);
    expect((await runCliFailure(repoDir, structuralArgs)).stderr).toBe(first.stderr);
    expect(parseJson<{ error: { code: string } }>(first.stderr).error.code).toBe('TRANSITION_NOT_ALLOWED');

    expect((await transitionFailure(repoDir, 'session_missing', 'framed', 0, 'missing:session')).error.code).toBe(
      'SESSION_NOT_FOUND',
    );
    expect(countRows(repoDir, 'transition_idempotency')).toBe(1);
  });

  it('rolls back state, history, and idempotency when the atomic write fails', async () => {
    const repoDir = await makeThreadloopRepo();
    const { session_id: sessionId } = await startSession(repoDir);
    withStateDb(
      repoDir,
      (db) =>
        db.exec(`
          CREATE TRIGGER reject_transition_idempotency
          BEFORE INSERT ON transition_idempotency
          BEGIN
            SELECT RAISE(ABORT, 'injected idempotency failure');
          END;
        `),
      { readOnly: false },
    );

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
    closeSqliteConnections(repoDir);

    expect(readLifecycle(repoDir)).toEqual({ status: 'queued', state_version: 0 });
    expect(countRows(repoDir, 'session_transitions')).toBe(0);
    expect(countRows(repoDir, 'transition_idempotency')).toBe(0);
  });

  it('keeps completion atomic behind an injected authoritative guard seam', async () => {
    const repoDir = await makeThreadloopRepo();
    const { session_id: sessionId } = await startSession(repoDir);
    await forceStates(repoDir, sessionId, 0, readyForHuman);

    const result = await forceTransition(repoDir, sessionId, 'completed', 7, 'future:completion', {
      approval_receipt: 'future:#42',
    });
    expect(result).toMatchObject({ ok: true, data: { lifecycle: { state: 'completed', state_version: 8 } } });
    expect(typeof result.data.session.ended_at).toBe('string');
    closeSqliteConnections(repoDir);

    expect(readLifecycle(repoDir)).toEqual({ status: 'completed', state_version: 8 });
    expect(withStateDb(repoDir, (db) => typeof db.prepare(`SELECT ended_at FROM sessions`).get()?.ended_at)).toBe(
      'string',
    );
    expect(countRows(repoDir, 'active_sessions')).toBe(0);
    expect(countRows(repoDir, 'active_state')).toBe(0);
    expect(countRows(repoDir, 'session_transitions')).toBe(8);
    expect(countRows(repoDir, 'transition_idempotency')).toBe(8);
  });

  it('fails public completion closed without changing the ready-for-human session', async () => {
    const repoDir = await makeThreadloopRepo();
    const { session_id: sessionId } = await startSession(repoDir);
    await forceStates(repoDir, sessionId, 0, readyForHuman);

    expect(await transitionFailure(repoDir, sessionId, 'completed', 7, 'public:completion')).toMatchObject({
      error: { code: 'TRANSITION_GUARD_FAILED', details: { guard_failures: [{ owner_issue: 42 }] } },
    });
    expect(readLifecycle(repoDir)).toEqual({ status: 'ready_for_human', state_version: 7 });
    expect(countRows(repoDir, 'sessions', 'ended_at IS NULL')).toBe(1);
    expect(countRows(repoDir, 'active_sessions')).toBe(1);
  });
});

describe('session next command', { timeout: 15_000 }, () => {
  it('reports both repository paths for a pending rename', async () => {
    const repoDir = await makeThreadloopRepo();
    await commitFiles(repoDir, 'add rename fixture', { 'renamed-from.txt': 'rename fixture\n' });
    const { session_id: sessionId } = await startSession(repoDir, 'Rename task');
    await git(repoDir, 'mv', 'renamed-from.txt', 'renamed-to.txt');

    const next = await sessionNext<{ repository: { worktree: { changed_files: string[] } } }>(repoDir, sessionId);
    expect(next.repository.worktree.changed_files).toEqual(
      expect.arrayContaining(['renamed-from.txt', 'renamed-to.txt']),
    );
  });

  it('returns live sanitized repository facts without mutating ThreadLoop state', async () => {
    const repoDir = await makeThreadloopRepo();
    await commitFiles(repoDir, 'fixture', { 'README.md': '# fixture\n' });
    await git(
      repoDir,
      'remote',
      'add',
      'origin',
      'https://token:secret@github.com/nnennandukwe/threadloop.git?access_token=never#fragment',
    );
    const { session_id: sessionId } = await startSession(repoDir, 'Next task');
    await git(repoDir, 'add', '-f', '.threadloop/config.json');
    await git(repoDir, 'commit', '-m', 'track ThreadLoop config');
    const beforeBytes = await readFile(stateDbPath(repoDir));
    await writeFile(path.join(repoDir, 'README.md'), '# changed\n', 'utf8');
    await writeFile(path.join(repoDir, 'untracked.txt'), 'new\n', 'utf8');
    await writeFile(path.join(repoDir, 'staged.txt'), 'staged\n', 'utf8');
    await git(repoDir, 'add', 'staged.txt');
    const trackedConfig = await readFile(path.join(repoDir, '.threadloop/config.json'), 'utf8');
    await writeFile(path.join(repoDir, '.threadloop/config.json'), `${trackedConfig}\n`, 'utf8');

    const next = parseJson((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout);

    expect(next).toMatchObject({
      ok: true,
      command: 'session next',
      data: {
        session_id: sessionId,
        lifecycle: { state: 'queued', state_version: 0, storage_schema_version: 8, contract_status: 'current' },
        candidate: { from_state: 'queued', target_state: 'framed', expected_state_version: 0, executable: true },
        repository: {
          identity: { source: 'origin', host: 'github.com', owner: 'nnennandukwe', name: 'threadloop' },
          worktree: {
            clean: false,
            changed_files: ['.threadloop/config.json', 'README.md', 'staged.txt', 'untracked.txt'],
          },
        },
      },
    });
    expect(JSON.stringify(next)).not.toContain('token');
    expect(JSON.stringify(next)).not.toContain(repoDir);
    expect(await readFile(stateDbPath(repoDir))).toEqual(beforeBytes);
  });

  it('reports blocked recovery and completed terminal states honestly', async () => {
    const repoDir = await makeThreadloopRepo();
    const { session_id: sessionId } = await startSession(repoDir, 'Terminal task');
    await transition(repoDir, sessionId, 'blocked', 0, 'blocked:next', {
      block: {
        reason: 'No access',
        evidence_ref: 'incident:123',
        recovery: 'Restore access',
        stop_code: 'ACCESS_DENIED',
      },
    });

    expect(await sessionNext(repoDir, sessionId)).toMatchObject({
      candidate: { from_state: 'blocked', target_state: 'queued', expected_state_version: 1, executable: false },
      terminal_reason: 'BLOCKED_REQUIRES_HUMAN_RECOVERY',
    });

    await forceTransition(repoDir, sessionId, 'queued', 1, 'fixture:recover', {
      recovery: {
        approved_by: 'test-controller',
        evidence_ref: 'recovery:test',
        reason: 'Prepare a completed terminal fixture.',
      },
    });
    await forceStates(repoDir, sessionId, 2, [...readyForHuman, 'completed'], 'terminal');

    expect(await sessionNext(repoDir, sessionId)).toMatchObject({ candidate: null, terminal_reason: 'COMPLETED' });
  });
});
