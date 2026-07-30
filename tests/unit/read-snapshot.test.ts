import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from '../../src/adapters/fs/sqlite-driver.js';
import {
  closeSqliteConnections,
  ensureStateDatabase,
  resetSqliteConnections,
  withReadSnapshot,
} from '../../src/adapters/fs/sqlite-store.js';

const temporaryRepos: string[] = [];
const PROBE_KEY = 'read_snapshot_probe';

afterEach(async () => {
  await closeSqliteConnections();
  await resetSqliteConnections();
  await Promise.all(temporaryRepos.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeStateDatabase() {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), 'threadloop-read-snapshot-'));
  temporaryRepos.push(repoDir);
  await ensureStateDatabase(repoDir);
  return { repoDir, stateDbPath: path.join(repoDir, '.threadloop/state/state.db') };
}

function countProbeRows(db: DatabaseSync) {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM metadata WHERE key = ?`).get(PROBE_KEY) as { count: number };
  return row.count;
}

describe('read snapshot isolation', () => {
  it('hides a concurrent commit from every read inside one snapshot', async () => {
    const { repoDir, stateDbPath } = await makeStateDatabase();
    // A second connection stands in for another ThreadLoop process racing this read.
    const concurrentWriter = new DatabaseSync(stateDbPath);

    try {
      const observed = withReadSnapshot(repoDir, (db) => {
        const before = countProbeRows(db);

        concurrentWriter.exec('BEGIN IMMEDIATE');
        concurrentWriter.prepare(`INSERT INTO metadata (key, value) VALUES (?, ?)`).run(PROBE_KEY, 'committed');
        concurrentWriter.exec('COMMIT');

        return { before, after: countProbeRows(db) };
      });

      // Without an enclosing read transaction the second statement gets a fresh
      // implicit snapshot and observes the commit, which is how a projection and
      // the history it is checked against come to disagree.
      expect(observed.before).toBe(0);
      expect(observed.after).toBe(0);

      // Guards against a vacuous pass: the concurrent write really did commit, and
      // a later snapshot sees it.
      expect(withReadSnapshot(repoDir, countProbeRows)).toBe(1);
    } finally {
      concurrentWriter.close();
    }
  });

  it('releases the snapshot so later reads observe earlier commits', async () => {
    const { repoDir, stateDbPath } = await makeStateDatabase();
    const concurrentWriter = new DatabaseSync(stateDbPath);

    try {
      expect(withReadSnapshot(repoDir, countProbeRows)).toBe(0);

      concurrentWriter.exec('BEGIN IMMEDIATE');
      concurrentWriter.prepare(`INSERT INTO metadata (key, value) VALUES (?, ?)`).run(PROBE_KEY, 'committed');
      concurrentWriter.exec('COMMIT');

      expect(withReadSnapshot(repoDir, countProbeRows)).toBe(1);
    } finally {
      concurrentWriter.close();
    }
  });

  it('rolls back the snapshot and still closes the connection when a read throws', async () => {
    const { repoDir } = await makeStateDatabase();

    expect(() =>
      withReadSnapshot(repoDir, () => {
        throw new Error('read failed');
      }),
    ).toThrow('read failed');

    // A leaked transaction or handle would make this second read fail or hang.
    expect(withReadSnapshot(repoDir, countProbeRows)).toBe(0);
  });
});
