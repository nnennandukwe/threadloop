import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveTestCliBundle, runCli, parseJson } from '../helpers/cli.js';
import { managedWorkflowFixture } from '../helpers/workflow-execution.js';
import { DatabaseSync } from '../../src/adapters/fs/sqlite-driver.js';
import { openCollection } from '../../src/adapters/fs/workflow-collection-store.js';
import { GaapState } from '../../src/adapters/fs/gaap-state.js';
import { registerManagedGaapExecutor, inspectManagedGaapExecutor } from '../../src/services/gaap-executor.js';
import { threadloopPaths } from '../../src/adapters/fs/repo.js';
import { afterEach, expect, it } from 'vitest';
import { createWorkflowStore } from '../../src/adapters/fs/workflow-store.js';
import { closeSqliteConnections, ensureStateDatabase, withReadSnapshot } from '../../src/adapters/fs/sqlite-store.js';
import { prepareSensorObservation } from '../../src/services/workflow-preparation.js';
import type { DecisionReply } from '../../src/domain/workflow-run.js';
import { prepareWorkflowGenesis } from '../../src/services/workflow-genesis.js';
import {
  applyWorkflow,
  decideWorkflow,
  observeWorkflow,
  workflowControllerInput,
  workflowGaapBinding,
} from '../../src/services/workflow-evaluation.js';
import { cleanupTemporaryState, git } from '../helpers/session.js';
import { governedProfile, governedWorkflowFixture } from '../helpers/workflow-run.js';

const producerRoots: string[] = [];
afterEach(async () => {
  await cleanupTemporaryState();
  await Promise.all(producerRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const at = '2026-11-21T18:00:00.000Z';

it('refuses execution on a v1 run without installing execution tables', async () => {
  const { control } = await governedWorkflowFixture();
  const run = 'session_wf_legacy';
  await ensureStateDatabase(control);
  const genesis = prepareWorkflowGenesis(control, run, governedProfile, 'setup.json');
  const store = createWorkflowStore(control, () => at);
  const initial = store.create(run, genesis.requestJson, (now) => genesis.build(now));
  const snapshot = store.read(run),
    decision = decideWorkflow(snapshot, observeWorkflow(snapshot), at);
  expect(() =>
    store.reserveExecution(run, decision, () => {
      throw new Error('unexpected reservation callback');
    }),
  ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_RUNTIME_UNSUPPORTED' }));
  expect(store.read(run).view).toEqual(initial);
  expect(
    withReadSnapshot(control, (db) =>
      db.prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'workflow_execution_*'").all(),
    ),
  ).toEqual([]);
});
const run = 'session_wf_managed';

async function engineeringRun(time = at) {
  const { control, producerRoot, host } = await managedWorkflowFixture();
  producerRoots.push(producerRoot);
  await ensureStateDatabase(control);
  const store = createWorkflowStore(control, () => time);
  const genesis = prepareWorkflowGenesis(control, run, governedProfile, 'setup.json');
  const created = store.create(run, genesis.requestJson, (now) => genesis.build(now));
  for (const edge of ['frame', 'bind_plan', 'begin_implementation']) {
    const before = store.read(run),
      decision = decideWorkflow(before, observeWorkflow(before), time);
    store.apply(run, edge, decision, (current, now) => applyWorkflow(current, decision, now));
  }
  const snapshot = store.read(run),
    observed = observeWorkflow(snapshot),
    proposal = decideWorkflow(snapshot, observed, time);
  const decision = proposal.controller_decision.decision;
  if (decision.outcome !== 'engineering_action_required') throw new Error('Expected the selected engineering action');
  const binding = workflowGaapBinding(
    snapshot,
    workflowControllerInput(snapshot, observed, time),
    decision.action_request,
  );
  const reserve = () => store.reserveExecution(run, proposal, () => ({ observed, binding }));
  const db = new DatabaseSync(threadloopPaths(control).stateDbPath);
  return { control, store, db, genesis, created, proposal, host, reserve };
}
function unexpected(): never {
  throw new Error('Unexpected fresh operation');
}

it('holds a reservation across independent connections and enrolls only its pending child after a lost registration reply', async () => {
  const { store, control, db, created, reserve, genesis, proposal, host } = await engineeringRun();
  try {
    const reservation = reserve(),
      id = reservation.owner.reservation_id;
    expect(created.execution_revision).toBe(0);
    expect(
      db.prepare('SELECT revision,active_reservation FROM workflow_execution_heads WHERE run_id=?').get(run),
    ).toEqual({ revision: 1, active_reservation: id });
    expect(db.prepare('SELECT version FROM workflow_heads WHERE run_id=?').get(run)).toEqual({ version: 3 });
    const child = new GaapState(reservation.child_directory);
    expect(() =>
      store.withExecutionFence(
        run,
        id,
        'register',
        () => {},
        () => {
          db.exec('PRAGMA busy_timeout=0');
          expect(() => db.exec('BEGIN IMMEDIATE')).toThrow(/locked|busy/i);
          registerManagedGaapExecutor(child, reservation.owner, reservation.binding, host, at);
          throw new Error('lost registration reply');
        },
      ),
    ).toThrow('lost registration reply');
    closeSqliteConnections(control);
    const reopened = createWorkflowStore(control, () => at);
    expect(reopened.create(run, genesis.requestJson, unexpected)).toEqual(created);
    expect(reopened.reserveExecution(run, proposal, unexpected)).toEqual(reservation);
    expect(() => reopened.apply(run, 'held-apply', proposal, unexpected)).toThrowError(
      expect.objectContaining({ code: 'TRANSITION_GUARD_FAILED' }),
    );
    const inspected = await inspectManagedGaapExecutor(child, reservation.owner);
    expect(inspected).toMatchObject({ launch_count: 0, admitted: [], observations: [] });
    expect(() =>
      reopened.enrollExecution(run, id, { ...inspected, binding_digest: '0'.repeat(64) }, () => {}),
    ).toThrowError(expect.objectContaining({ code: 'STATE_CORRUPTED' }));
    expect(reopened.read(run).view.execution_revision).toBe(1);
    const enrolled = reopened.enrollExecution(run, id, inspected, () => {});
    expect(enrolled.child?.request.request.attempt_id).toBe(inspected.projection.attempts[0]?.id);
    let sampled = at;
    const expiring = createWorkflowStore(control, () => sampled);
    expect(() =>
      expiring.withExecutionFence(
        run,
        id,
        'start',
        () => {
          sampled = inspected.projection.claims[0]!.valid_until;
        },
        unexpected,
      ),
    ).toThrowError(expect.objectContaining({ code: 'EXECUTOR_REJECTED' }));
    expect(reopened.enrollExecution(run, id, inspected, unexpected)).toEqual(enrolled);
    const altered = structuredClone(inspected);
    altered.authority = [];
    expect(() => reopened.enrollExecution(run, id, altered, unexpected)).toThrowError(
      expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
    );
    expect(reopened.read(run)).toMatchObject({
      view: { state_version: 3, execution_revision: 2 },
      managed_execution: { active: { owner: reservation.owner, child: { launch_count: 0 } } },
    });
    expect(() => reopened.withExecutionFence(run, id, 'register', () => {}, unexpected)).toThrowError(
      expect.objectContaining({ code: 'EXECUTOR_REJECTED' }),
    );
    expect(() => db.exec("UPDATE workflow_execution_events SET body='{}'")).toThrow(/immutable/);
    expect(() =>
      db.exec('INSERT OR REPLACE INTO workflow_execution_events SELECT * FROM workflow_execution_events'),
    ).toThrow(/exists/);
    expect(() => db.exec('DELETE FROM workflow_execution_events')).toThrow(/immutable/);
    const target = { kind: 'signed-gate' as const, gate_id: 'check' };
    reopened.prepare(run, 'bind-exec-head', 3, target, (snapshot, id, now) =>
      prepareSensorObservation(snapshot, observeWorkflow(snapshot), target, id, now),
    );
    const retainedEvent = db.prepare("SELECT body FROM workflow_events WHERE run_id=? AND kind='prepare'").get(run)!;
    expect(JSON.parse(String(retainedEvent.body))).toMatchObject({
      execution_head: { revision: 2, digest: reopened.read(run).view.execution_digest },
    });
    const original = db.prepare('SELECT revision,digest FROM workflow_execution_heads WHERE run_id=?').get(run)!;
    db.prepare('UPDATE workflow_execution_heads SET digest=? WHERE run_id=?').run('0'.repeat(64), run);
    expect(() => reopened.read(run)).toThrowError(expect.objectContaining({ code: 'STATE_CORRUPTED' }));
    db.prepare('UPDATE workflow_execution_heads SET digest=? WHERE run_id=?').run(String(original.digest), run);
    const triggerSql = (name: string) =>
      String(db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name)?.sql);
    const noUpdate = triggerSql('workflow_execution_events_no_update'),
      noDelete = triggerSql('workflow_execution_events_no_delete');
    db.exec('DROP TRIGGER workflow_execution_events_no_update');
    db.exec(
      'CREATE TRIGGER workflow_execution_events_no_update BEFORE UPDATE ON workflow_execution_events BEGIN SELECT 1; END',
    );
    expect(() => reopened.read(run)).toThrowError(expect.objectContaining({ code: 'STATE_CORRUPTED' }));
    db.exec('DROP TRIGGER workflow_execution_events_no_update');
    db.exec(noUpdate);
    db.exec('DROP TRIGGER workflow_execution_events_no_delete');
    db.prepare('DELETE FROM workflow_execution_events WHERE run_id=?').run(run);
    db.exec(noDelete);
    db.prepare('UPDATE workflow_execution_heads SET revision=0,digest=?,active_reservation=NULL WHERE run_id=?').run(
      String(created.execution_digest),
      run,
    );
    expect(() => reopened.read(run)).toThrow(/different execution prefix/);
  } finally {
    db.close();
  }
});

it('recovers the reservation across process loss and competing execute requests', async () => {
  const { control, db, store } = await engineeringRun(new Date().toISOString());
  await git(control, 'init', '-b', 'main');
  await runCli(control, ['init']);
  const filename = path.join(control, 'saved-decision.json');
  const preload = fileURLToPath(new URL('../fixtures/workflow/sqlite-cut.mjs', import.meta.url));
  const args = [
    '--import',
    preload,
    resolveTestCliBundle(),
    'workflow',
    'execute',
    run,
    '--decision',
    filename,
    '--json',
  ];
  const interrupt = async (point: string) => {
    const result = await promisify(execFile)(process.execPath, args, {
      cwd: control,
      env: { ...process.env, THREADLOOP_TEST_SQLITE_CUT: point },
      timeout: 15000,
    }).then(
      () => null,
      (cause: Error & { signal?: string; stderr?: string }) => cause,
    );
    expect(result?.stderr).toContain('workflow-cut=' + point);
    expect(result?.signal).toBe('SIGKILL');
  };
  try {
    const saved = (await runCli(control, ['workflow', 'decide', run, '--json'])).stdout;
    const proposal = parseJson<{ data: DecisionReply }>(saved).data;
    await writeFile(filename, saved);
    for (const cut of ['after workflow_execution_events', 'after workflow_execution_heads', 'before commit']) {
      await interrupt(cut);
      expect(store.read(run).managed_execution).toMatchObject({ active: null, revision: 0, reservations: [] });
    }
    await Promise.all([interrupt('after commit'), interrupt('after commit')]);
    closeSqliteConnections(control);
    const snapshot = createWorkflowStore(control).read(run);
    expect(snapshot.view).toMatchObject({ state_version: 3, execution_revision: 1, evidence_revision: 0 });
    const retained = snapshot.managed_execution?.reservations;
    expect(retained).toHaveLength(1);
    expect(retained?.[0]).toMatchObject({ child: null, imported: null, proposal });
    expect(db.prepare('SELECT count(*) AS n FROM workflow_execution_events WHERE run_id=?').get(run)?.n).toBe(1);
  } finally {
    db.close();
  }
}, 30_000);

it('refuses a second managed run after its collection schema disappeared', async () => {
  const { control, producerRoot } = await managedWorkflowFixture();
  producerRoots.push(producerRoot);
  await ensureStateDatabase(control);
  const store = createWorkflowStore(control, () => at);
  function create(runId: string) {
    const genesis = prepareWorkflowGenesis(control, runId, governedProfile, 'setup.json');
    return store.create(runId, genesis.requestJson, (now) => genesis.build(now));
  }
  create(run);
  const db = new DatabaseSync(threadloopPaths(control).stateDbPath);
  try {
    db.exec('DROP TABLE workflow_collection_events');
    expect(() => store.read(run)).toThrowError(expect.objectContaining({ code: 'STATE_CORRUPTED' }));
    expect(() => create('session_wf_second')).toThrowError(expect.objectContaining({ code: 'STATE_CORRUPTED' }));
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='workflow_collection_events'").get()).toBeUndefined();
    expect(db.prepare("SELECT run_id FROM workflow_runs WHERE run_id='session_wf_second'").get()).toBeUndefined();
  } finally {
    db.close();
  }
});

it.each(['execution', 'collection'])(
  'refuses to reuse a run ID with surviving %s records after loss of the lifecycle binding',
  async (ledger) => {
    const { control, producerRoot, setup } = await managedWorkflowFixture();
    producerRoots.push(producerRoot);
    await ensureStateDatabase(control);
    const store = createWorkflowStore(control, () => at);
    const create = (id: string, filename: string) => {
      const genesis = prepareWorkflowGenesis(control, id, governedProfile, filename);
      return store.create(id, genesis.requestJson, (now) => genesis.build(now));
    };
    create(run, 'setup.json');
    if (ledger === 'collection') {
      openCollection(
        control,
        run,
        'gate',
        { kind: 'local-gate', target: 'check', state_version: 0 },
        (s) => s.genesis.baseline.content_digest,
      );
    }
    const legacy: Record<string, unknown> = { ...setup, schema_version: 'threadloop.workflow-setup/1' };
    delete legacy.gaap;
    await writeFile(path.join(control, 'legacy.json'), JSON.stringify(legacy));
    const other = create('session_wf_unaffected', 'legacy.json');
    const db = new DatabaseSync(threadloopPaths(control).stateDbPath);
    try {
      db.exec('PRAGMA foreign_keys=OFF');
      const missing = ['workflow_heads', 'workflow_events', 'workflow_runs'];
      if (ledger === 'collection') missing.push('workflow_execution_heads');
      for (const table of missing) {
        const trigger = table + '_no_delete',
          original = db.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(trigger)!;
        db.exec('DROP TRIGGER ' + trigger);
        db.prepare('DELETE FROM ' + table + ' WHERE run_id=?').run(run);
        db.exec(String(original.sql));
      }
      expect(() => create(run, 'legacy.json')).toThrowError(expect.objectContaining({ code: 'STATE_CORRUPTED' }));
      expect(store.read('session_wf_unaffected').view).toEqual(other);
      expect(db.prepare('SELECT run_id FROM workflow_runs WHERE run_id=?').get(run)).toBeUndefined();
      if (ledger === 'execution')
        expect(db.prepare('SELECT revision FROM workflow_execution_heads WHERE run_id=?').get(run)).toEqual({
          revision: 0,
        });
      else
        expect(db.prepare('SELECT phase FROM workflow_collection_events WHERE run_id=?').get(run)).toEqual({
          phase: 'intent',
        });
    } finally {
      db.close();
    }
  },
);
