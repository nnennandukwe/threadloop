import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readAuditCorpusReadOnly } from '../../src/adapters/fs/sqlite-store.js';
import { AuditCorpusLimitError, MAX_AUDIT_CORPUS_BYTES } from '../../src/domain/audit-corpus-limits.js';
import { exportAuditCorpus } from '../../src/services/audit-corpus.js';
import { transition } from '../helpers/cli.js';
import { cleanupTemporaryState, makeCommittedRepo, startSession } from '../helpers/session.js';
import { withStateDb, withTriggersDisabled } from '../helpers/state-db.js';

// Exercise SQLite admission with ordinary sessions and a small, deliberately unreadable row.
vi.mock('../../src/domain/audit-corpus-limits.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/domain/audit-corpus-limits.js')>()),
  MAX_AUDIT_CORPUS_BYTES: 4096,
  MAX_AUDIT_CORPUS_RECORDS: 5,
}));

afterEach(cleanupTemporaryState);

it('checks selection totals before parsing events and avoids unselected sessions', async () => {
  const repo = await makeCommittedRepo();
  const first = (await startSession(repo)).session_id;
  const second = (await startSession(repo)).session_id;
  await transition(repo, second, 'framed', 0, 'selection:frame');
  withStateDb(
    repo,
    (db) =>
      withTriggersDisabled(db, 'audit_events', () => {
        db.prepare('UPDATE audit_events SET event_json = ? WHERE session_id = ? AND sequence = 1').run(
          'invalid',
          second,
        );
      }),
    { readOnly: false },
  );
  // The combined four events plus manifest and seal exceed the five-record test limit.
  for (const selection of [undefined, [second, first]])
    expect(() => readAuditCorpusReadOnly(repo, selection)).toThrow(AuditCorpusLimitError);
  expect(readAuditCorpusReadOnly(repo, [first])).toHaveLength(1);

  withStateDb(
    repo,
    (db) =>
      withTriggersDisabled(db, 'audit_events', () => {
        db.prepare('UPDATE audit_events SET event_json = ? WHERE session_id = ? AND sequence = 1').run(
          '\u00e9'.repeat(MAX_AUDIT_CORPUS_BYTES / 2 + 1),
          second,
        );
      }),
    { readOnly: false },
  );
  // The second session fits the record count, but its first row alone exceeds the UTF-8 byte limit.
  expect(() => readAuditCorpusReadOnly(repo, [second])).toThrow(AuditCorpusLimitError);
  expect(readAuditCorpusReadOnly(repo, [first])).toHaveLength(1);
  const output = path.join(repo, 'selected.jsonl');
  await expect(exportAuditCorpus({ cwd: repo, sessionIds: [second], output })).rejects.toMatchObject({
    code: 'AUDIT_CORPUS_INVALID',
    details: { max_bytes: MAX_AUDIT_CORPUS_BYTES, max_records: 5 },
  });
  await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await exportAuditCorpus({ cwd: repo, sessionIds: [first], output })).session_count).toBe(1);
});

it('bounds session membership even when the selected sessions have missing genesis rows', async () => {
  const repo = await makeCommittedRepo();
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) ids.push((await startSession(repo)).session_id);
  withStateDb(repo, (db) => withTriggersDisabled(db, 'audit_events', () => db.exec('DELETE FROM audit_events')), {
    readOnly: false,
  });
  for (const selection of [undefined, ids])
    expect(() => readAuditCorpusReadOnly(repo, selection)).toThrow(AuditCorpusLimitError);
  expect(() => readAuditCorpusReadOnly(repo, [ids[0]!])).toThrow(/genesis|coverage/);
});
