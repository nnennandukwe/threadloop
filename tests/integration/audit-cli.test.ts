import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseJson, runCli, runCliError, transition, transitionFailure } from '../helpers/cli.js';
import { cleanupTemporaryState, makeCommittedRepo, startSession } from '../helpers/session.js';
import {
  countRows,
  readLifecycle,
  stateDbPath,
  tamperAuditEventHash,
  withStateDb,
  withTriggersDisabled,
} from '../helpers/state-db.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import type { DatabaseSync } from '../../src/adapters/fs/sqlite-driver.js';
import { closeSqliteConnections } from '../../src/adapters/fs/sqlite-store.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { exportSessionAudit, transitionSession } from '../../src/services/session-service.js';

/** A framed session whose ledger holds session_started, guard_decision, and transition_applied. */
async function makeSession() {
  const repoDir = await makeCommittedRepo({ branch: 'issue-42/audit', remote: null });
  const { session_id: sessionId } = await startSession(repoDir, 'Audit task');
  await transition(repoDir, sessionId, 'framed', 0, 'audit:frame');
  return { repoDir, sessionId };
}

const verifyArgs = (sessionId: string, ...extra: string[]) => [
  'audit',
  'verify',
  '--session',
  sessionId,
  ...extra,
  '--json',
];
const exportArgs = (sessionId: string, output: string) => [
  'audit',
  'export',
  '--session',
  sessionId,
  '--output',
  output,
  '--json',
];

/** Tampers with the stored ledger through its own connection, with the immutability triggers out of the way. */
function tamperLedger(repoDir: string, mutate: (db: DatabaseSync) => void) {
  withStateDb(repoDir, (db) => withTriggersDisabled(db, 'audit_events', () => mutate(db)), { readOnly: false });
}

afterEach(cleanupTemporaryState);

describe('audit CLI', () => {
  it('shows, verifies, and exclusively exports the canonical hash-linked ledger', async () => {
    const { repoDir, sessionId } = await makeSession();
    const shown = parseJson<{ data: { root: string; events: Array<{ event_sha256: string }> } }>(
      (await runCli(repoDir, ['audit', 'show', '--session', sessionId, '--json'])).stdout,
    );

    expect(shown.data).toMatchObject({
      contract_version: 1,
      session_id: sessionId,
      count: 3,
      coverage: 'full',
      verification: { valid: true },
      events: [
        { event: { event_type: 'session_started' } },
        { event: { event_type: 'guard_decision' } },
        { event: { event_type: 'transition_applied' } },
      ],
    });
    expect(shown.data.root).toMatch(/^[a-f0-9]{64}$/);
    expect(shown.data.events.every((event) => /^[a-f0-9]{64}$/.test(event.event_sha256))).toBe(true);

    const textShow = await runCli(repoDir, ['audit', 'show', '--session', sessionId]);
    expect(textShow.stdout).toContain(`Audit ${sessionId}: 3 event(s)`);
    expect(textShow.stdout).toContain('Events:');
    expect(textShow.stdout).toMatch(/#1 session_started \S+ [a-f0-9]{64}/);
    expect(textShow.stdout).toMatch(/#2 guard_decision \S+ [a-f0-9]{64}/);
    expect(textShow.stdout).toMatch(/#3 transition_applied \S+ [a-f0-9]{64}/);

    expect(parseJson((await runCli(repoDir, verifyArgs(sessionId, '--root', shown.data.root))).stdout)).toMatchObject({
      data: { valid: true, root: shown.data.root },
    });

    const outputPath = path.join(repoDir, 'audit-output', 'session.jsonl');
    const exported = parseJson((await runCli(repoDir, exportArgs(sessionId, outputPath))).stdout);
    const lines = (await readFile(outputPath, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => parseJson<{ event: { event_type: string }; event_sha256: string }>(line));
    expect(exported).toMatchObject({ data: { count: 3, root: shown.data.root, output: outputPath } });
    expect(lines).toHaveLength(3);
    expect(lines[0]?.event.event_type).toBe('session_started');
    expect(lines[0]?.event_sha256).toMatch(/^[a-f0-9]{64}$/);

    expect((await runCliError(repoDir, exportArgs(sessionId, outputPath))).error.code).toBe('AUDIT_EXPORT_CONFLICT');
    expect((await readFile(outputPath, 'utf8')).trimEnd().split('\n')).toHaveLength(3);
  });

  it('maps audit export I/O failures to a stable error with the safe output path and recovery hint', async () => {
    const { repoDir, sessionId } = await makeSession();
    const nonDirectory = path.join(repoDir, 'not-a-directory');
    await writeFile(nonDirectory, 'blocks directory creation\n', 'utf8');
    const outputPath = path.join(nonDirectory, 'session.jsonl');

    expect(await runCliError(repoDir, exportArgs(sessionId, outputPath))).toMatchObject({
      error: {
        code: 'AUDIT_EXPORT_FAILED',
        message: 'ThreadLoop could not publish the verified audit export.',
        details: {
          output: outputPath,
          hint: 'Choose a writable output path whose parent is a directory, then retry the export.',
        },
      },
    });

    const serviceFailure = await exportSessionAudit({ cwd: repoDir, sessionId, outputPath }).catch(
      (error: unknown) => error,
    );
    expect(serviceFailure).toMatchObject({ code: 'AUDIT_EXPORT_FAILED' });
    expect((serviceFailure as Error).cause).toBeInstanceOf(Error);
  });

  it.each([
    {
      name: 'unavailable',
      expectedCode: 'AUDIT_UNAVAILABLE',
      mutate: (db: DatabaseSync) => db.exec(`DROP TABLE audit_events`),
    },
    {
      name: 'empty',
      expectedCode: 'AUDIT_EMPTY',
      mutate: (db: DatabaseSync) => withTriggersDisabled(db, 'audit_events', () => db.exec(`DELETE FROM audit_events`)),
    },
  ])('fails closed when the audit ledger is $name', async ({ expectedCode, mutate }) => {
    const { repoDir, sessionId } = await makeSession();
    closeSqliteConnections(repoDir);
    withStateDb(repoDir, mutate, { readOnly: false });
    const outputPath = path.join(repoDir, `${expectedCode}.jsonl`);

    for (const command of [verifyArgs(sessionId), exportArgs(sessionId, outputPath)]) {
      const { error } = await runCliError(repoDir, command);
      expect(error).toMatchObject({ code: expectedCode, details: { session_id: sessionId } });
      expect(String(error.details.hint).length).toBeGreaterThan(0);
    }
    await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a structured session error when the state database does not exist yet', async () => {
    const { repoDir, sessionId } = await makeSession();
    await rm(stateDbPath(repoDir));

    expect(await runCliError(repoDir, verifyArgs(sessionId))).toMatchObject({
      error: { code: 'SESSION_NOT_FOUND', details: { session_id: sessionId } },
    });
  });

  it('reports corruption and blocks later controller mutations without changing lifecycle state', async () => {
    const { repoDir, sessionId } = await makeSession();
    closeSqliteConnections(repoDir);
    tamperAuditEventHash(repoDir, 2);
    const hashMismatch = {
      error: {
        code: 'AUDIT_VERIFICATION_FAILED',
        details: { audit_error: { code: 'AUDIT_HASH_MISMATCH', sequence: 2 } },
      },
    };

    expect(await runCliError(repoDir, verifyArgs(sessionId))).toMatchObject(hashMismatch);
    expect(
      await transitionFailure(repoDir, sessionId, 'blocked', 1, 'audit:block-after-corruption', {
        block: {
          reason: 'audit corruption',
          evidence_ref: 'audit:2',
          recovery: 'restore ledger',
          stop_code: 'AUDIT_CORRUPT',
        },
      }),
    ).toMatchObject(hashMismatch);
    expect(readLifecycle(repoDir)).toEqual({ status: 'framed', state_version: 1 });
    expect(countRows(repoDir, 'transition_idempotency', 'idempotency_key = ?', 'audit:block-after-corruption')).toBe(0);
  });

  it('invalidates a cached audit root after another connection changes the ledger', async () => {
    const { repoDir, sessionId } = await makeSession();
    await expect(
      transitionSession({
        cwd: repoDir,
        sessionId,
        targetState: 'blocked',
        expectedStateVersion: 1,
        idempotencyKey: 'audit:cache-root',
        actor: 'agent',
        input: {
          block: {
            reason: 'exercise cached audit verification',
            evidence_ref: 'audit:cache',
            recovery: 'restore the session',
            stop_code: 'AUDIT_CACHE_TEST',
          },
        },
      }),
    ).resolves.toMatchObject({ data: { lifecycle: { state: 'blocked', state_version: 2 } } });

    // Deliberately leaves the store's cached connection open: the cache must notice this foreign write itself.
    tamperAuditEventHash(repoDir, 1);

    await expect(
      transitionSession({
        cwd: repoDir,
        sessionId,
        targetState: 'framed',
        expectedStateVersion: 2,
        idempotencyKey: 'audit:cache-root:invalidated',
        actor: 'agent',
        input: {
          recovery: {
            reason: 'resume after cache test',
            evidence_ref: 'audit:cache:resolved',
            approved_by: 'Test User',
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'AUDIT_VERIFICATION_FAILED',
      details: { audit_error: { code: 'AUDIT_HASH_MISMATCH', sequence: 1 } },
    });
    expect(readLifecycle(repoDir)).toEqual({ status: 'blocked', state_version: 2 });
  });

  it('reports retained-root and row-canonicalization failures with structured reasons', async () => {
    const { repoDir, sessionId } = await makeSession();
    expect(await runCliError(repoDir, verifyArgs(sessionId, '--root', 'f'.repeat(64)))).toMatchObject({
      error: {
        code: 'AUDIT_VERIFICATION_FAILED',
        details: { audit_error: { code: 'AUDIT_ROOT_MISMATCH' } },
      },
    });

    closeSqliteConnections(repoDir);
    tamperLedger(repoDir, (db) =>
      db.exec(`UPDATE audit_events SET state_version = state_version + 1 WHERE sequence = 2`),
    );
    expect(await runCliError(repoDir, verifyArgs(sessionId))).toMatchObject({
      error: {
        code: 'AUDIT_VERIFICATION_FAILED',
        details: { audit_error: { code: 'AUDIT_CANONICALIZATION_MISMATCH', sequence: 2 } },
      },
    });
  });

  it.each([
    { name: 'sequence', expectedCode: 'AUDIT_SEQUENCE_MISMATCH', field: 'sequence', value: 4 },
    { name: 'link', expectedCode: 'AUDIT_LINK_MISMATCH', field: 'previous_sha256', value: 'f'.repeat(64) },
  ])('reports a structured $name mismatch through the public command', async ({ expectedCode, field, value }) => {
    const { repoDir, sessionId } = await makeSession();
    closeSqliteConnections(repoDir);
    // Rewrites the column, the canonical event, and its digest together, so only the chain property under test breaks.
    tamperLedger(repoDir, (db) => {
      const row = db.prepare(`SELECT event_json FROM audit_events WHERE sequence = 2`).get() as { event_json: string };
      const eventJson = canonicalJson({ ...(JSON.parse(row.event_json) as Record<string, unknown>), [field]: value });
      db.prepare(`UPDATE audit_events SET ${field} = ?, event_json = ?, event_sha256 = ? WHERE sequence = 2`).run(
        value,
        eventJson,
        sha256(eventJson),
      );
    });

    expect(await runCliError(repoDir, verifyArgs(sessionId))).toMatchObject({
      error: {
        code: 'AUDIT_VERIFICATION_FAILED',
        details: { audit_error: { code: expectedCode, sequence: 2 } },
      },
    });
  });
});
