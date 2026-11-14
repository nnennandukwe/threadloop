import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { verifyAuditCorpus } from '../../src/domain/audit-corpus.js';
import { parseJson, runCli, runCliError, transition } from '../helpers/cli.js';
import { cleanupTemporaryState, makeCommittedRepo, makeTempDir, startSession } from '../helpers/session.js';
import { countRows, tamperAuditEventHash, withStateDb, withTriggersDisabled } from '../helpers/state-db.js';

afterEach(cleanupTemporaryState);

function makeLegacy(repoDir: string, sessionId: string, forward = false) {
  withStateDb(
    repoDir,
    (db) =>
      withTriggersDisabled(db, 'audit_events', () => {
        const row = db.prepare('SELECT event_json FROM audit_events WHERE session_id = ?').get(sessionId) as {
          event_json: string;
        };
        const event = JSON.parse(row.event_json) as { payload: Record<string, unknown>; event_type: string };
        delete event.payload.run_configuration;
        if (forward) {
          event.event_type = 'audit_activated';
          event.payload = { coverage: 'schema_v6_forward', lifecycle_state_at_activation: 'queued' };
        }
        const json = canonicalJson(event);
        db.prepare('UPDATE audit_events SET event_json = ?, event_sha256 = ?, event_type = ? WHERE session_id = ?').run(
          json,
          sha256(json),
          event.event_type,
          sessionId,
        );
      }),
    { readOnly: false },
  );
}

it('exports selected new/legacy/mixed chains, preserves native bytes, and verifies outside the source repository', async () => {
  const repoDir = await makeCommittedRepo();
  const first = await startSession(repoDir, 'Runtime identity');
  const second = await startSession(repoDir, 'Legacy identity');
  makeLegacy(repoDir, second.session_id);
  const third = await startSession(repoDir, 'Forward-only coverage');
  makeLegacy(repoDir, third.session_id, true);
  await transition(repoDir, first.session_id, 'framed', 0, 'corpus:frame');
  const output = path.join(repoDir, 'corpus.jsonl');
  const exported = parseJson<{ data: { root: string; session_count: number } }>(
    (
      await runCli(repoDir, [
        'audit',
        'corpus',
        '--session',
        third.session_id,
        first.session_id,
        second.session_id,
        '--output',
        output,
        '--json',
      ])
    ).stdout,
  ).data;
  expect(exported.session_count).toBe(3);
  const content = await readFile(output, 'utf8');
  const independent = verifyAuditCorpus(content, sha256, exported.root);
  expect(independent.manifest.sessions.find((session) => session.session_id === first.session_id)).toMatchObject({
    attribution: 'runtime_only',
    outcome: { state: 'framed' },
  });
  expect(independent.manifest.sessions.find((session) => session.session_id === second.session_id)).toMatchObject({
    attribution: 'legacy_unattributable',
    run_configuration: null,
  });
  expect(independent.manifest.sessions.find((session) => session.session_id === third.session_id)).toMatchObject({
    coverage: 'schema_v6_forward',
    outcome: { started_at: null, counts_scope: 'covered_events' },
  });
  const outside = await makeTempDir();
  expect(
    parseJson(
      (await runCli(outside, ['audit', 'verify-export', '--input', output, '--root', exported.root, '--json'])).stdout,
    ),
  ).toMatchObject({ data: { valid: true, root: exported.root, session_count: 3, event_count: 5 } });
  const allOutput = path.join(repoDir, 'all.jsonl');
  await runCli(repoDir, ['audit', 'corpus', '--all', '--output', allOutput, '--json']);
  expect(await readFile(allOutput, 'utf8')).toBe(content);
  const native = path.join(repoDir, 'native.jsonl');
  await runCli(repoDir, ['audit', 'export', '--session', second.session_id, '--output', native, '--json']);
  expect(
    parseJson<{ event: { payload: Record<string, unknown> } }>((await readFile(native, 'utf8')).trim()).event.payload
      .run_configuration,
  ).toBeUndefined();
  expect(await runCliError(repoDir, ['audit', 'corpus', '--all', '--output', output, '--json'])).toMatchObject({
    error: { code: 'AUDIT_EXPORT_CONFLICT' },
  });
  expect(await readFile(output, 'utf8')).toBe(content);
});

it('rejects selection mistakes and incomplete files without lifecycle or ledger mutations', async () => {
  const repoDir = await makeCommittedRepo();
  const session = await startSession(repoDir);
  const output = path.join(repoDir, 'corpus.jsonl');
  for (const selector of [
    [],
    ['--all', '--session', session.session_id],
    ['--session', session.session_id, session.session_id],
    ['--session', 'missing'],
  ]) {
    expect(await runCliError(repoDir, ['audit', 'corpus', ...selector, '--output', output, '--json'])).toMatchObject({
      error: { code: expect.stringMatching(/INVALID_ARGUMENT|AUDIT_CORPUS_INVALID/) as unknown },
    });
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  await runCli(repoDir, ['audit', 'corpus', '--all', '--output', output, '--json']);
  const original = await readFile(output, 'utf8');
  await writeFile(output, original.split('\n').slice(0, -2).join('\n') + '\n');
  expect(await runCliError(repoDir, ['audit', 'verify-export', '--input', output, '--json'])).toMatchObject({
    error: { code: 'AUDIT_CORPUS_INVALID', details: { hint: expect.any(String) as unknown } },
  });
  expect(countRows(repoDir, 'audit_events')).toBe(1);
  expect(countRows(repoDir, 'session_transitions')).toBe(0);
});

it('rolls back the session-start transaction when genesis persistence fails', async () => {
  const repoDir = await makeCommittedRepo();
  await runCli(repoDir, ['init']);
  withStateDb(
    repoDir,
    (db) =>
      db.exec(
        "CREATE TRIGGER inject_genesis_failure BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'injected genesis failure'); END",
      ),
    { readOnly: false },
  );
  await runCliError(repoDir, ['session', 'start', 'Rollback', '--goal', 'Rollback', '--json']);
  for (const table of ['tasks', 'sessions', 'entries', 'audit_events']) expect(countRows(repoDir, table)).toBe(0);
});

it('refuses the whole selection when one chain is corrupt and rejects invalid UTF-8 without changing retained bytes', async () => {
  const repoDir = await makeCommittedRepo();
  await startSession(repoDir);
  tamperAuditEventHash(repoDir, 1);
  const output = path.join(repoDir, 'corrupt.jsonl');
  expect(await runCliError(repoDir, ['audit', 'corpus', '--all', '--output', output, '--json'])).toMatchObject({
    error: { code: 'AUDIT_CORPUS_INVALID' },
  });
  await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  const bytes = Buffer.from([0xff, 0x0a]);
  await writeFile(output, bytes);
  expect(await runCliError(repoDir, ['audit', 'verify-export', '--input', output, '--json'])).toMatchObject({
    error: { code: 'AUDIT_CORPUS_INVALID', details: { reason: 'Export contains invalid UTF-8 bytes.' } },
  });
  expect(await readFile(output)).toEqual(bytes);
});
