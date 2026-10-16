import { rm, writeFile } from 'node:fs/promises';
import { writeFileSync as requireWrite } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { controllerFixture } from '../fixtures/gaap-controller.js';
import { GaapState } from '../../src/adapters/fs/gaap-state.js';
import { canonicalExecutorJson, mapGaapResult } from 'threadloop-contracts/executor';
import { canonicalGaapJson, parseGaapJson } from '../../src/domain/gaap-json.js';
import { gaapObjectDigest } from '../../src/domain/gaap-content.js';
import type { GaapStatement } from '../../src/domain/gaap-types.js';
import { signGaapTestStatement } from '../fixtures/gaap.js';
import { gaapVerificationPolicy } from '../../src/domain/gaap-binding.js';
import {
  admitGaapOutput,
  inspectGaapExecutor,
  registerGaapExecutor,
  runGaapExecutor,
} from '../../src/services/gaap-executor.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(mode = 'success') {
  const fixture = await controllerFixture(mode);
  roots.push(fixture.root);
  fixture.host.environment.TEST_GAAP_MAPPING = JSON.stringify(fixture.binding.mapping_policy);
  fixture.host.environment.TEST_GAAP_IMPLEMENTATION = JSON.stringify(fixture.host.verification.implementation);
  return fixture;
}
describe('durable GAAP executor admission', () => {
  it('retries a failed registration after removing only its own uncommitted database', async () => {
    const fixture = await setup();
    const failed = new GaapState(fixture.state, (point) => {
      if (point === 'register.before_commit') throw new Error('injected registration failure');
    });
    expect(() => registerGaapExecutor(failed, fixture.binding, fixture.host)).toThrow('registration failure');
    const retry = new GaapState(fixture.state);
    registerGaapExecutor(retry, fixture.binding, fixture.host);
    expect((await inspectGaapExecutor(retry)).launch_count).toBe(0);
  });
  it('retries a dispatch transaction failure before any launch commits', async () => {
    const fixture = await setup();
    let enabled = true;
    const store = new GaapState(fixture.state, (point) => {
      if (enabled && point === 'dispatch.before_commit') throw new Error('injected dispatch failure');
    });
    registerGaapExecutor(store, fixture.binding, fixture.host);
    await expect(runGaapExecutor(store)).rejects.toThrow('dispatch failure');
    expect(store.inspect().launches).toHaveLength(0);
    enabled = false;
    expect((await runGaapExecutor(store)).status).toBe('admitted');
  });
  it('reports an admission COMMIT followed by reporting failure as committed', async () => {
    const fixture = await setup();
    let admitted = false;
    const store = new GaapState(fixture.state, (point) => {
      if (point === 'admission.result') admitted = true;
      if (admitted && point === 'state.after_commit') throw new Error('injected post-COMMIT failure');
    });
    registerGaapExecutor(store, fixture.binding, fixture.host);
    expect((await runGaapExecutor(store)).status).toBe('committed_with_warning');
    expect((await inspectGaapExecutor(new GaapState(fixture.state))).admitted).toHaveLength(1);
  });
  it('launches once, independently admits and persists evidence before checking its own guards', async () => {
    const fixture = await setup();
    const store = new GaapState(fixture.state);
    registerGaapExecutor(store, fixture.binding, fixture.host);
    const result = await runGaapExecutor(store);
    expect(result).toMatchObject({
      status: 'admitted',
      evaluation: { workflow_state: 'implementing', state_version: 2, lifecycle_mutated: false },
    });
    const inspection = await inspectGaapExecutor(new GaapState(fixture.state));
    expect(inspection.launch_count).toBe(1);
    expect(inspection.admitted).toHaveLength(1);
    expect(inspection.projection.request_status).toBe('satisfied');
    expect(inspection.evaluations).toHaveLength(1);
    await expect(runGaapExecutor(store)).rejects.toThrow();
    expect(await admitGaapOutput(store, 1)).toMatchObject({ status: 'already_admitted' });
  });
  it.each(['malformed', 'nonzero', 'timeout'])(
    'retains %s output without admission or another launch',
    async (mode) => {
      const fixture = await setup(mode);
      if (mode === 'timeout') fixture.host.timeout_ms = 100;
      const store = new GaapState(fixture.state);
      registerGaapExecutor(store, fixture.binding, fixture.host);
      const result = await runGaapExecutor(store);
      expect(result.status).not.toBe('admitted');
      const inspection = await inspectGaapExecutor(store);
      expect(inspection.admitted).toHaveLength(0);
      expect(inspection.launch_count).toBe(1);
      expect(inspection.workflow_state).toBe('implementing');
      await expect(runGaapExecutor(store)).rejects.toThrow();
    },
  );
  it.each(['ask', 'block', 'failed', 'interrupted'])(
    'retains signed %s as uncertain execution without advancing lifecycle',
    async (mode) => {
      const fixture = await setup(mode);
      const store = new GaapState(fixture.state);
      registerGaapExecutor(store, fixture.binding, fixture.host);
      const result = await runGaapExecutor(store);
      expect(result.status).toBe('admitted');
      const inspection = await inspectGaapExecutor(store);
      expect(inspection.projection.attempts[0]?.status).toBe('unknown_outcome');
      expect(inspection.workflow_state).toBe('implementing');
      expect(inspection.state_version).toBe(2);
      expect(inspection.evaluations).toHaveLength(1);
      await expect(runGaapExecutor(store)).rejects.toThrow('already started');
    },
  );
  it.each(['signature', 'unknown_version', 'wrong_capability', 'missing_envelope'])(
    'rejects %s evidence after real transport without admission',
    async (mode) => {
      const fixture = await setup(mode);
      const store = new GaapState(fixture.state);
      registerGaapExecutor(store, fixture.binding, fixture.host);
      const result = await runGaapExecutor(store);
      expect(result.status).toBe('rejected');
      const inspection = await inspectGaapExecutor(store);
      expect(inspection.admitted).toHaveLength(0);
      expect(inspection.workflow_state).toBe('implementing');
    },
  );
  it('rejects physical drift after verification without erasing the changed workspace', async () => {
    const fixture = await setup();
    const store = new GaapState(fixture.state, (point) => {
      if (point === 'admission.prepared') {
        // A synchronous host-side observation change races the final admission fence.
        requireWrite(path.join(fixture.workspace, 'source.txt'), 'changed after verification');
      }
    });
    registerGaapExecutor(store, fixture.binding, fixture.host);
    expect((await runGaapExecutor(store)).status).toBe('rejected');
    expect(store.inspect().accepted).toHaveLength(0);
  });
  it('rejects a changed subject or expired claim before launching', async () => {
    const fixture = await setup();
    const store = new GaapState(fixture.state);
    registerGaapExecutor(store, fixture.binding, fixture.host);
    await writeFile(path.join(fixture.workspace, 'source.txt'), 'changed before launch');
    await expect(runGaapExecutor(store)).rejects.toThrow('changed before dispatch');
    expect((await inspectGaapExecutor(store)).launch_count).toBe(0);
    const expired = await setup();
    const expiredStore = new GaapState(expired.state);
    registerGaapExecutor(expiredStore, expired.binding, expired.host, new Date(Date.now() - 60000).toISOString());
    await expect(runGaapExecutor(expiredStore)).rejects.toThrow();
    expect(expiredStore.inspect().launches).toHaveLength(0);
  });
  it('allows only one concurrent runner to own the Attempt', async () => {
    const fixture = await setup();
    const store = new GaapState(fixture.state);
    registerGaapExecutor(store, fixture.binding, fixture.host);
    const results = await Promise.allSettled([runGaapExecutor(store), runGaapExecutor(new GaapState(fixture.state))]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(store.inspect().launches).toHaveLength(1);
    expect((await inspectGaapExecutor(store)).admitted).toHaveLength(1);
  });
  it('requires host policy adoption before any state or process exists', async () => {
    const fixture = await setup();
    fixture.host.verification.id = 'not-adopted';
    expect(() => registerGaapExecutor(new GaapState(fixture.state), fixture.binding, fixture.host)).toThrow(
      'explicitly trust',
    );
    expect(gaapVerificationPolicy(fixture.host).digest).toHaveLength(64);
  });
  it('retains changed content under a reused source ID without overwriting its first admission', async () => {
    const fixture = await setup();
    const store = new GaapState(fixture.state);
    registerGaapExecutor(store, fixture.binding, fixture.host);
    expect((await runGaapExecutor(store)).status).toBe('admitted');
    const retained = store.inspect();
    const accepted = retained.accepted[0]!;
    const statement = parseGaapJson(accepted.predicate as Uint8Array) as GaapStatement;
    for (const event of statement.predicate.receipt.body.events)
      if (event.event_type === 'verification') event.verifier_id = 'another-synthetic-verifier';
    statement.predicate.receipt.receipt_digest = gaapObjectDigest(statement.predicate.receipt.body);
    const previous = JSON.parse(String(accepted.result)) as {
      result: { attempt_receipt: { receipt: { finished_at: string; resulting_subject: unknown } } };
    };
    const receipt = previous.result.attempt_receipt.receipt;
    const mapped = mapGaapResult(
      retained.root.request,
      retained.root.binding.mapping_policy,
      Buffer.from(canonicalGaapJson(statement.predicate.receipt)),
      { finished_at: receipt.finished_at, resulting_subject: receipt.resulting_subject },
    );
    if (!mapped.ok) throw new Error(JSON.stringify(mapped.diagnostics));
    const encoded = canonicalExecutorJson(mapped.value);
    if (!encoded.ok) throw new Error('Invalid conflict fixture');
    const id = store.mutate(retained.root.revision, (_root, database) =>
      Number(
        database
          .prepare('INSERT INTO observation(status,stdout,stderr,envelope,metadata) VALUES (?,?,?,?,?)')
          .run(
            'ok',
            Buffer.from(encoded.value),
            Buffer.alloc(0),
            signGaapTestStatement(statement),
            retained.observations[0]!.metadata!,
          ).lastInsertRowid,
      ),
    );
    await expect(admitGaapOutput(store, id)).rejects.toThrow('reuses an admitted source identity');
    const after = store.inspect();
    expect(after.accepted).toHaveLength(1);
    expect(after.accepted[0]!.source_digest).toBe(accepted.source_digest);
    expect(after.accepted[0]!.envelope).toEqual(accepted.envelope);
    expect(after.observations).toHaveLength(2);
  });
  it('fails inspection when an admitted blob or evidence record is missing', async () => {
    const fixture = await setup();
    const store = new GaapState(fixture.state);
    registerGaapExecutor(store, fixture.binding, fixture.host);
    expect((await runGaapExecutor(store)).status).toBe('admitted');
    const retained = store.inspect();
    store.mutate(retained.root.revision, (_root, database) => {
      database
        .prepare('UPDATE blob SET bytes=? WHERE digest=?')
        .run(Buffer.from('tampered'), retained.blobs[0]!.digest!);
    });
    await expect(inspectGaapExecutor(store)).rejects.toThrow('retained blob');
  });
  it('keeps admitted evidence after a post-commit evaluation failure', async () => {
    const fixture = await setup();
    const store = new GaapState(fixture.state, (point) => {
      if (point === 'admission.after_commit') throw new Error('injected evaluation failure');
    });
    registerGaapExecutor(store, fixture.binding, fixture.host);
    expect(await runGaapExecutor(store)).toMatchObject({ status: 'committed_with_warning' });
    expect((await inspectGaapExecutor(new GaapState(fixture.state))).admitted).toHaveLength(1);
  });
  it.each(['admission.blobs', 'admission.result'])(
    'rolls back %s and can reimport retained output without rerunning',
    async (failure) => {
      const fixture = await setup();
      let enabled = true;
      const store = new GaapState(fixture.state, (point) => {
        if (enabled && point === failure) throw new Error('injected write failure');
      });
      registerGaapExecutor(store, fixture.binding, fixture.host);
      expect(await runGaapExecutor(store)).toMatchObject({ status: 'rejected' });
      const retained = store.inspect();
      expect(retained.blobs).toHaveLength(0);
      expect(retained.accepted).toHaveLength(0);
      enabled = false;
      expect(await admitGaapOutput(store, 1)).toMatchObject({ status: 'admitted' });
      expect(store.inspect().launches).toHaveLength(1);
    },
  );
  it('fences a response when host authority changes during verification', async () => {
    const fixture = await setup();
    let changed = false;
    const store = new GaapState(fixture.state, (point) => {
      if (point === 'admission.prepared' && !changed) {
        changed = true;
        const current = store.read();
        store.mutate(current.revision, (root) => {
          root.binding.snapshot.binding.state_version++;
        });
      }
    });
    registerGaapExecutor(store, fixture.binding, fixture.host);
    const response = await runGaapExecutor(store);
    expect(response.status).toBe('rejected');
    expect('reason' in response && response.reason).toContain('authority changed');
    expect(store.inspect().accepted).toHaveLength(0);
  });
  it('persists a launch intent before a simulated crash and refuses a blind retry', async () => {
    const fixture = await setup();
    const store = new GaapState(fixture.state, (point) => {
      if (point === 'dispatch.after_commit') throw new Error('simulated crash');
    });
    registerGaapExecutor(store, fixture.binding, fixture.host);
    await expect(runGaapExecutor(store)).rejects.toThrow('simulated crash');
    const reopened = new GaapState(fixture.state);
    expect((await inspectGaapExecutor(reopened)).launch_count).toBe(1);
    await expect(runGaapExecutor(reopened)).rejects.toThrow();
  });
});
