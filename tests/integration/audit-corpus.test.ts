import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, rm, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { MAX_AUDIT_CORPUS_BYTES, MAX_AUDIT_CORPUS_RECORDS } from '../../src/domain/audit-corpus-limits.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import * as auditCorpus from '../../src/domain/audit-corpus.js';
import { exportAuditCorpus } from '../../src/services/audit-corpus.js';
import { parseJson, resolveTestCliBundle, runCli, runCliError, transition } from '../helpers/cli.js';
import { cleanupTemporaryState, makeCommittedRepo, makeTempDir, startSession } from '../helpers/session.js';
import {
  countRows,
  stateDbPath,
  tamperAuditEventHash,
  withStateDb,
  withTriggersDisabled,
} from '../helpers/state-db.js';

afterEach(cleanupTemporaryState);

const { verifyAuditCorpus } = auditCorpus;

it('requires a regular file for standalone corpus verification', async () => {
  const directory = await makeTempDir();
  const error = await runCliError(directory, ['audit', 'verify-export', '--input', directory, '--json']);
  expect(error.error).toMatchObject({
    code: 'AUDIT_CORPUS_INVALID',
    details: { reason: 'Corpus verification requires a regular file.' },
  });
});

it.skipIf(process.platform === 'win32')('rejects a FIFO without waiting for a writer', async () => {
  const directory = await makeTempDir();
  const fifo = path.join(directory, 'corpus.pipe');
  execFileSync('mkfifo', [fifo]);
  const result = spawnSync(
    process.execPath,
    [resolveTestCliBundle(), 'audit', 'verify-export', '--input', fifo, '--json'],
    {
      cwd: directory,
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(parseJson(result.stderr)).toMatchObject({
    error: { details: { reason: 'Corpus verification requires a regular file.' } },
  });
});

it('reports byte and record limits for an oversized file and excess record separators', async () => {
  const directory = await makeTempDir();
  const file = path.join(directory, 'input.jsonl');
  const verify = () => runCliError(directory, ['audit', 'verify-export', '--input', file, '--json']);
  await writeFile(file, '');
  await truncate(file, MAX_AUDIT_CORPUS_BYTES + 1);
  const expected = {
    error: {
      code: 'AUDIT_CORPUS_INVALID',
      details: {
        max_bytes: MAX_AUDIT_CORPUS_BYTES,
        max_records: MAX_AUDIT_CORPUS_RECORDS,
        hint: expect.stringContaining('audit corpus --session') as unknown,
      },
    },
  };
  expect(await verify()).toMatchObject(expected);
  await writeFile(file, '\n'.repeat(MAX_AUDIT_CORPUS_RECORDS + 1));
  expect(await verify()).toMatchObject(expected);
});

it('refuses to publish an oversized corpus and lets a smaller selection retry', async () => {
  const repoDir = await makeCommittedRepo();
  const { session_id: id } = await startSession(repoDir);
  await startSession(repoDir);
  const output = path.join(repoDir, 'bounded.jsonl');
  // Substitute only the encoder output to exercise publication admission with a small fixture.
  const encode = auditCorpus.createAuditCorpus;
  const encoder = vi.spyOn(auditCorpus, 'createAuditCorpus').mockImplementationOnce((...args) => ({
    ...encode(...args),
    content: '\n'.repeat(MAX_AUDIT_CORPUS_RECORDS + 1),
  }));
  try {
    await expect(exportAuditCorpus({ cwd: repoDir, all: true, output })).rejects.toMatchObject({
      code: 'AUDIT_CORPUS_INVALID',
      details: { max_records: MAX_AUDIT_CORPUS_RECORDS },
    });
  } finally {
    encoder.mockRestore();
  }
  await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  await runCli(repoDir, ['audit', 'corpus', '--session', id, '--output', output, '--json']);
  expect(verifyAuditCorpus(await readFile(output, 'utf8'), sha256).session_count).toBe(1);
});

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

it('reports unavailable ledger consistently with single-session export and preserves the missing state', async () => {
  const repoDir = await makeCommittedRepo();
  const { session_id: sessionId } = await startSession(repoDir);
  withStateDb(repoDir, (db) => db.exec('DROP TABLE audit_events'), { readOnly: false });
  const output = path.join(repoDir, 'unavailable.jsonl');
  for (const command of [
    ['audit', 'export', '--session', sessionId, '--output', output, '--json'],
    ['audit', 'corpus', '--all', '--output', output, '--json'],
  ]) {
    expect(await runCliError(repoDir, command)).toMatchObject({ error: { code: 'AUDIT_UNAVAILABLE' } });
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

it('reports unavailable storage without recreating a missing state database', async () => {
  const repoDir = await makeCommittedRepo();
  const output = path.join(repoDir, 'corpus.jsonl');
  const args = ['audit', 'corpus', '--all', '--output', output, '--json'];
  expect(await runCliError(repoDir, args)).toMatchObject({ error: { code: 'THREADLOOP_NOT_INITIALIZED' } });
  await startSession(repoDir);
  const database = stateDbPath(repoDir);
  await rm(database);
  expect(await runCliError(repoDir, args)).toMatchObject({
    error: { code: 'AUDIT_UNAVAILABLE', details: { schema_version: null, reason: 'database_missing' } },
  });
  await expect(readFile(database)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('retains all-session and explicit membership semantics across a batch of sessions', async () => {
  const repoDir = await makeCommittedRepo();
  const ids: string[] = [];
  for (let index = 0; index < 16; index++) ids.push((await startSession(repoDir, `Batch fixture ${index}`)).session_id);
  for (const [name, selector, expected] of [
    ['all', ['--all'], ids],
    ['selected', ['--session', ids[0]!, ids[15]!], [ids[0]!, ids[15]!]],
  ] as const) {
    const output = path.join(repoDir, `${name}.jsonl`);
    await runCli(repoDir, ['audit', 'corpus', ...selector, '--output', output, '--json']);
    const inspected = verifyAuditCorpus(await readFile(output, 'utf8'), sha256);
    expect(inspected.manifest.sessions.map((session) => session.session_id)).toEqual([...expected].sort());
    expect(inspected.event_count).toBe(expected.length);
  }
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
