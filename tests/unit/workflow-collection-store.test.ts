import { rm } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { threadloopPaths } from '../../src/adapters/fs/repo.js';
import { DatabaseSync } from '../../src/adapters/fs/sqlite-driver.js';
import { closeSqliteConnections, ensureStateDatabase } from '../../src/adapters/fs/sqlite-store.js';
import {
  activeWorkflowCollections,
  claimCollectionLaunch,
  finishCollection,
  openCollection,
} from '../../src/adapters/fs/workflow-collection-store.js';
import { createWorkflowStore } from '../../src/adapters/fs/workflow-store.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import type { RunSnapshot } from '../../src/domain/workflow-run.js';
import { prepareWorkflowGenesis } from '../../src/services/workflow-genesis.js';
import { cleanupTemporaryState } from '../helpers/session.js';
import { managedWorkflowFixture } from '../helpers/workflow-execution.js';
import { governedProfile } from '../helpers/workflow-run.js';

const run = 'session_wf_gate_recovery';
const target = { kind: 'local-gate' as const, target: 'check', state_version: 0 };
const subject = (snapshot: RunSnapshot) => snapshot.genesis.baseline.content_digest;
const producerRoots: string[] = [];
afterEach(async () => {
  await Promise.all(producerRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await cleanupTemporaryState();
});

async function fixture() {
  const { control, producerRoot } = await managedWorkflowFixture();
  producerRoots.push(producerRoot);
  await ensureStateDatabase(control);
  const genesis = prepareWorkflowGenesis(control, run, governedProfile, 'setup.json');
  createWorkflowStore(control).create(run, genesis.requestJson, (now) => genesis.build(now));
  return { control, open: () => openCollection(control, run, 'key', target, subject) };
}

it('reopens a lost reservation and commits one launch claim under fresh authority', async () => {
  const { control, open } = await fixture();
  const first = open();
  if (first.stage !== 'collect') throw new Error('Expected a reserved collection.');
  const { attempt } = first.intent;
  closeSqliteConnections(control);
  expect(open()).toMatchObject({ stage: 'collect', intent: { attempt } });
  expect(activeWorkflowCollections(control, run)).toMatchObject([{ attempt, phase: 'reserved' }]);
  expect(() => claimCollectionLaunch(control, run, 'key', attempt, () => 'different subject')).toThrow();
  expect(claimCollectionLaunch(control, run, 'key', attempt, subject)).toBe(true);
  closeSqliteConnections(control);
  expect(claimCollectionLaunch(control, run, 'key', attempt, subject)).toBe(false);
  expect(activeWorkflowCollections(control, run)).toMatchObject([{ attempt, phase: 'launch_claimed' }]);
  expect(open).toThrowError(
    expect.objectContaining({ details: expect.objectContaining({ attempt, key: 'key' }) as object }),
  );
  expect(() => finishCollection(control, run, 'key', { phase: 'failed', reason: 'unknown output' })).toThrow();
  expect(() => openCollection(control, run, 'another-key', target, subject)).toThrow();
});

it('keeps an earlier bare intent held and preserves its original bytes', async () => {
  const { control, open } = await fixture();
  const snapshot = createWorkflowStore(control).read(run);
  const attempt = 'a70d8803-d3c9-429a-8649-0fe242ac240b';
  const body = canonicalJson({ phase: 'intent', intent: { ...target, attempt, subject_digest: subject(snapshot) } });
  const digest = sha256(canonicalJson([run, 'key', 0, 'intent', body]));
  const database = new DatabaseSync(threadloopPaths(control).stateDbPath);
  try {
    database
      .prepare('INSERT INTO workflow_collection_events VALUES(?,?,?,?,?,?)')
      .run(run, 'key', 0, 'intent', body, digest);
    expect(open).toThrowError(
      expect.objectContaining({ details: expect.objectContaining({ attempt, key: 'key' }) as object }),
    );
    expect(() => claimCollectionLaunch(control, run, 'key', attempt, subject)).toThrow();
    expect(database.prepare('SELECT body,digest FROM workflow_collection_events').all()).toEqual([{ body, digest }]);
  } finally {
    database.close();
  }
});

it('protects an acquired launch claim from reset, replacement and removal', async () => {
  const { control, open } = await fixture();
  const first = open();
  if (first.stage !== 'collect') throw new Error('Expected a reserved collection.');
  const database = new DatabaseSync(threadloopPaths(control).stateDbPath);
  try {
    expect(() =>
      database.exec('INSERT OR REPLACE INTO workflow_gate_launches SELECT * FROM workflow_gate_launches'),
    ).toThrow();
    expect(claimCollectionLaunch(control, run, 'key', first.intent.attempt, subject)).toBe(true);
    for (const sql of [
      'UPDATE workflow_gate_launches SET claimed=0',
      'UPDATE workflow_gate_launches SET claimed=1',
      'INSERT OR REPLACE INTO workflow_gate_launches SELECT * FROM workflow_gate_launches',
      'DELETE FROM workflow_gate_launches',
    ]) {
      expect(() => database.exec(sql)).toThrow();
    }
    expect(database.prepare('SELECT claimed FROM workflow_gate_launches').get()?.claimed).toBe(1);
  } finally {
    database.close();
  }
});

it('refuses to recreate a lost launch ledger while a marked intent depends on it', async () => {
  const { control, open } = await fixture();
  const first = open();
  if (first.stage !== 'collect') throw new Error('Expected a reserved collection.');
  expect(claimCollectionLaunch(control, run, 'key', first.intent.attempt, subject)).toBe(true);
  const database = new DatabaseSync(threadloopPaths(control).stateDbPath);
  try {
    database.exec('DROP TABLE workflow_gate_launches');
    expect(open).toThrow();
    expect(() => claimCollectionLaunch(control, run, 'key', first.intent.attempt, subject)).toThrow();
    expect(() => activeWorkflowCollections(control, run)).toThrow();
    const other = 'session_wf_other';
    const genesis = prepareWorkflowGenesis(control, other, governedProfile, 'setup.json');
    createWorkflowStore(control).create(other, genesis.requestJson, (now) => genesis.build(now));
    expect(() => openCollection(control, other, 'fresh', target, subject)).toThrow();
    expect(database.prepare("SELECT sql FROM sqlite_schema WHERE name='workflow_gate_launches'").get()).toBeUndefined();
  } finally {
    database.close();
  }
});

it('diagnoses a missing reservation even when an exact retry has a retained refusal', async () => {
  const { control, open } = await fixture();
  open();
  finishCollection(control, run, 'key', { phase: 'failed', reason: 'stale subject' });
  expect(open).toThrow('stale subject');
  const database = new DatabaseSync(threadloopPaths(control).stateDbPath);
  try {
    const trigger = 'workflow_gate_launches_no_delete';
    const original = database.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(trigger)!;
    database.exec('DROP TRIGGER ' + trigger);
    database.prepare('DELETE FROM workflow_gate_launches WHERE run_id=?').run(run);
    database.exec(String(original.sql));
    expect(open).toThrowError(expect.objectContaining({ code: 'STATE_CORRUPTED' }));
  } finally {
    database.close();
  }
});

it('refuses to recreate a run with an orphaned gate-launch claim', async () => {
  const { control, open } = await fixture();
  const first = open();
  if (first.stage !== 'collect') throw new Error('Expected a reserved collection.');
  expect(claimCollectionLaunch(control, run, 'key', first.intent.attempt, subject)).toBe(true);
  const database = new DatabaseSync(threadloopPaths(control).stateDbPath);
  try {
    database.exec('PRAGMA foreign_keys=OFF');
    for (const table of [
      'workflow_heads',
      'workflow_events',
      'workflow_collection_events',
      'workflow_execution_heads',
      'workflow_runs',
    ]) {
      const trigger = table === 'workflow_collection_events' ? 'workflow_collection_no_delete' : table + '_no_delete';
      const original = database.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(trigger)!;
      database.exec('DROP TRIGGER ' + trigger);
      database.prepare('DELETE FROM ' + table + ' WHERE run_id=?').run(run);
      database.exec(String(original.sql));
    }
    expect(() =>
      createWorkflowStore(control).create(run, '{}', () => {
        throw new Error('Unexpected new run.');
      }),
    ).toThrowError(expect.objectContaining({ code: 'STATE_CORRUPTED' }));
    expect(database.prepare('SELECT claimed FROM workflow_gate_launches WHERE run_id=?').get(run)?.claimed).toBe(1);
  } finally {
    database.close();
  }
});
