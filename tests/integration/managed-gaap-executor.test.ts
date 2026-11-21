import path from 'node:path';
import { readdir, rm } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from '../../src/adapters/fs/sqlite-driver.js';
import { GaapState } from '../../src/adapters/fs/gaap-state.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import {
  admitManagedGaapOutput,
  admitGaapOutput,
  evaluateGaapController,
  inspectGaapExecutor,
  inspectManagedGaapExecutor,
  registerManagedGaapExecutor,
  runGaapExecutor,
  runManagedGaapExecutor,
  type ManagedGaapFence,
} from '../../src/services/gaap-executor.js';
import { controllerFixture } from '../fixtures/gaap-controller.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function managedFixture(mode = 'success') {
  const f = await controllerFixture(mode);
  directories.push(f.root);
  f.host.environment.TEST_GAAP_MAPPING = JSON.stringify(f.binding.mapping_policy);
  f.host.environment.TEST_GAAP_IMPLEMENTATION = JSON.stringify(f.host.verification.implementation);
  const owner = {
    workflow_run_id: f.binding.snapshot.binding.workflow_run_id,
    reservation_id: 'reservation-1',
    request_digest: f.binding.action_request.request_digest,
  };
  return { ...f, owner, store: new GaapState(f.state) };
}

it('registers the selected request and pending Attempt under its owning workflow and refuses standalone dispatch', async () => {
  const { store, owner, binding, host, state } = await managedFixture();
  const bindingDigest = sha256(canonicalJson(binding));
  const registered = registerManagedGaapExecutor(store, owner, binding, host);
  const db = new DatabaseSync(path.join(state, 'executor.sqlite'), { readOnly: true });
  try {
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
  } finally {
    db.close();
  }
  await expect(runGaapExecutor(new GaapState(state))).rejects.toThrow(/owning Workflow Run/i);
  await expect(inspectManagedGaapExecutor(new GaapState(state), { ...owner, reservation_id: 'other' })).rejects.toThrow(
    /owner/i,
  );
  const verified = await inspectManagedGaapExecutor(new GaapState(state), owner);
  const publicReport = await inspectGaapExecutor(new GaapState(state));
  expect(publicReport).toMatchObject({
    schema_version: 'threadloop.gaap-inspection/2',
    owner,
    request_digest: registered.request.request_digest,
    revision: 0,
    launch_count: 0,
    observations: [],
    admitted: [],
  });
  expect(canonicalJson(publicReport)).not.toContain(host.workspace);
  expect(canonicalJson(publicReport)).not.toContain('TEST_GAAP_');
  await expect(admitGaapOutput(new GaapState(state), 1)).rejects.toThrow(/owning Workflow Run/);
  expect(() => evaluateGaapController(new GaapState(state))).toThrow(/owning Workflow Run/);
  expect(verified).toMatchObject({
    owner,
    binding_digest: bindingDigest,
    host_digest: sha256(canonicalJson(host)),
    request: registered.request,
    revision: 0,
    launch_count: 0,
    projection: { attempts: [{ status: 'pending' }] },
  });
});

it('holds a started Attempt after revocation, then admits the retained transport through its owning fence without launching again', async () => {
  const { store, owner, binding, host, state } = await managedFixture();
  registerManagedGaapExecutor(store, owner, binding, host);
  const phases: string[] = [];
  const revoked: ManagedGaapFence = (phase, commit) => {
    phases.push(phase);
    if (phase === 'admit') throw new Error('simulated revocation');
    return commit();
  };
  const result = await runManagedGaapExecutor(store, owner, revoked);
  expect(result).toMatchObject({ status: 'rejected', observation_id: 1, reason: 'simulated revocation' });
  expect(phases).toEqual(['start', 'admit']);
  const reopened = new GaapState(state);
  expect(await inspectManagedGaapExecutor(reopened, owner)).toMatchObject({ launch_count: 1, admitted: [] });
  await expect(runManagedGaapExecutor(reopened, owner, revoked)).rejects.toThrow(/already started/);
  const eligible: ManagedGaapFence = (_phase, commit) => commit();
  expect(await admitManagedGaapOutput(reopened, owner, 1, eligible)).toMatchObject({ status: 'admitted' });
  await rm(path.join(state, 'outputs'), { recursive: true });
  expect(await admitManagedGaapOutput(reopened, owner, 1, eligible)).toMatchObject({ status: 'already_admitted' });
  expect(await inspectManagedGaapExecutor(reopened, owner)).toMatchObject({
    launch_count: 1,
    projection: { request_status: 'satisfied' },
    admitted: [{ observation_id: 1 }],
  });
});

it('rechecks the original launch, raw process observation and authenticated admission after the output directory disappears', async () => {
  const { store, owner, binding, host, state } = await managedFixture();
  registerManagedGaapExecutor(store, owner, binding, host);
  expect((await runManagedGaapExecutor(store, owner, (_phase, commit) => commit())).status).toBe('admitted');
  await rm(path.join(state, 'outputs'), { recursive: true });
  const original = await inspectManagedGaapExecutor(store, owner);
  expect(original.admitted).toHaveLength(1);
  const db = new DatabaseSync(path.join(state, 'executor.sqlite'));
  try {
    for (const [table, field, replacement] of [
      ['launch', 'request_digest', 'replaced'],
      ['observation', 'stdout', Buffer.from('{}')],
      ['observation', 'stderr', Buffer.from('replaced host transport report')],
      ['observation', 'envelope', Buffer.from('{}')],
      ['observation', 'status', 'timeout'],
      ['accepted', 'observation_id', 7],
    ] as const) {
      const first = db.prepare(`SELECT ${field} AS value FROM ${table}`).get()!.value!;
      db.prepare(`UPDATE ${table} SET ${field}=?`).run(replacement);
      await expect(inspectManagedGaapExecutor(store, owner), field).rejects.toThrow();
      db.prepare(`UPDATE ${table} SET ${field}=?`).run(first);
    }
  } finally {
    db.close();
  }
  expect(await inspectManagedGaapExecutor(store, owner)).toEqual(original);
});

it('retains healthy history when a later selected request registers, and refuses a reused request key', async () => {
  const fixture = await managedFixture();
  fixture.binding.snapshot.existing_requests.push({ idempotency_key: 'a'.repeat(64), request_digest: 'b'.repeat(64) });
  fixture.binding.snapshot.invalidated_claims.push({ id: 'retired-claim', version: 1 });
  registerManagedGaapExecutor(fixture.store, fixture.owner, fixture.binding, fixture.host);
  const verified = await inspectManagedGaapExecutor(fixture.store, fixture.owner);
  expect(verified.journal.execution.initial_context.snapshot.existing_requests).toEqual(
    fixture.binding.snapshot.existing_requests,
  );
  const reused = await managedFixture();
  reused.binding.snapshot.existing_requests.push({
    idempotency_key: reused.binding.action_request.request.idempotency_key,
    request_digest: 'f'.repeat(64),
  });
  expect(() => registerManagedGaapExecutor(reused.store, reused.owner, reused.binding, reused.host)).toThrow();
});

it('retains a committed launch path when the outer writer loses its fence reply', async () => {
  const { store, owner, binding, host, state } = await managedFixture();
  registerManagedGaapExecutor(store, owner, binding, host);
  const lost: ManagedGaapFence = (_phase, commit) => {
    commit();
    throw new Error('outer acknowledgement lost');
  };
  await expect(runManagedGaapExecutor(store, owner, lost)).rejects.toThrow(/committed/i);
  const verified = await inspectManagedGaapExecutor(store, owner);
  expect(verified).toMatchObject({
    launch_count: 1,
    observations: [],
    projection: { attempts: [{ status: 'running' }] },
  });
  expect(await readdir(path.join(state, 'outputs'))).toHaveLength(1);
  await expect(runManagedGaapExecutor(store, owner, lost)).rejects.toThrow(/already started/);
});
