import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runCli, runCliError, sessionNext } from '../helpers/cli.js';
import { cleanupTemporaryState, makeRepo, startSession } from '../helpers/session.js';
import { installLegacyGateSchema } from '../helpers/legacy-gate-schema.js';
import { stateDbPath, withStateDb } from '../helpers/state-db.js';

afterEach(cleanupTemporaryState);

it('reads a session with an unrelated additive SQLite table', async () => {
  const repo = await makeRepo();
  const { session_id: id } = await startSession(repo);
  withStateDb(repo, (db) => db.exec('CREATE TABLE "optional feature" (value TEXT)'), { readOnly: false });
  expect(await sessionNext(repo, id)).toMatchObject({ lifecycle: { contract_status: 'current' } });
});

it('plans the next session action without the unrelated snapshot writer table', async () => {
  const repo = await makeRepo();
  const { session_id: id } = await startSession(repo);
  withStateDb(repo, (db) => db.exec('DROP TABLE repo_snapshots'), { readOnly: false });
  expect(await sessionNext(repo, id)).toMatchObject({ lifecycle: { storage_capabilities: ['session_next_v1'] } });
});

it('reads status, next and audit exports from a pre-adoption store without changing its bytes', async () => {
  const repo = await makeRepo();
  const { session_id: id } = await startSession(repo);
  await installLegacyGateSchema(repo, 8);
  // A status read must neither depend on this write-only projection nor recreate it.
  withStateDb(repo, (db) => db.exec('DROP TABLE active_state'), { readOnly: false });
  const before = await readFile(stateDbPath(repo));
  for (const args of [
    ['session', 'status'],
    ['session', 'next'],
    ['audit', 'export', '--output', path.join(repo, 'single.jsonl')],
  ]) {
    await runCli(repo, [...args, '--session', id, '--json']);
    expect(await readFile(stateDbPath(repo))).toEqual(before);
  }
});

it('refuses to project a capability when a required append-only trigger has lost its protection', async () => {
  const repo = await makeRepo();
  const { session_id: id } = await startSession(repo);
  withStateDb(
    repo,
    (db) =>
      db.exec(`
    DROP TRIGGER gate_receipts_no_update;
    CREATE TRIGGER gate_receipts_no_update BEFORE UPDATE ON gate_receipts BEGIN SELECT 1; END;
  `),
    { readOnly: false },
  );
  const { error } = await runCliError(repo, ['session', 'next', '--session', id, '--json']);
  expect(error.code).toBe('STATE_CORRUPTED');
  expect(error.message).toContain('gate_receipts_no_update');
  expect((await runCli(repo, ['audit', 'verify', '--session', id, '--json'])).stdout).toContain('"valid": true');
});

it('withholds the session-next capability until an operator upgrades a generation-7 store', async () => {
  const repo = await makeRepo();
  const { session_id: id } = await startSession(repo);
  await installLegacyGateSchema(repo, 7);
  expect(await sessionNext(repo, id)).toMatchObject({
    lifecycle: { storage_schema_version: 7, contract_status: 'migration_required', storage_capabilities: [] },
  });
});

it('reports an absent session without creating a database when only the configuration remains', async () => {
  const repo = await makeRepo();
  const { session_id: id } = await startSession(repo);
  await unlink(stateDbPath(repo));
  expect((await runCliError(repo, ['session', 'status', '--session', id, '--json'])).error.code).toBe(
    'SESSION_NOT_FOUND',
  );
  await expect(readFile(stateDbPath(repo))).rejects.toMatchObject({ code: 'ENOENT' });
});
