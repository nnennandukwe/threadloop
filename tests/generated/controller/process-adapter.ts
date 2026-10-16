import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { controllerFixture } from '../../fixtures/gaap-controller.js';
import { GaapState } from '../../../src/adapters/fs/gaap-state.js';
import {
  registerGaapExecutor,
  runGaapExecutor,
  admitGaapOutput,
  evaluateGaapController,
  inspectGaapExecutor,
} from '../../../src/services/gaap-executor.js';
import { ProcessModel, type ProcessHistory } from './process-model.js';

export async function runProcessHistory(history: ProcessHistory) {
  const fixture = await controllerFixture(history.mode);
  try {
    fixture.host.environment.TEST_GAAP_MAPPING = JSON.stringify(fixture.binding.mapping_policy);
    fixture.host.environment.TEST_GAAP_IMPLEMENTATION = JSON.stringify(fixture.host.verification.implementation);
    // This suite bounds actions by count; the production wall-clock lease isn't the generated clock.
    fixture.binding.lease_ms = 120000;
    const initial = await readFile(path.join(fixture.workspace, 'source.txt'), 'utf8');
    registerGaapExecutor(new GaapState(fixture.state), fixture.binding, fixture.host);
    let faultHit = false;
    const store = () =>
      new GaapState(fixture.state, (point) => {
        if (!faultHit && history.fault === point) {
          faultHit = true;
          throw new Error('generated fault: ' + point);
        }
      });
    const model = new ProcessModel(history);
    for (const [index, step] of history.steps.entries()) {
      const expectedOutcome = model.apply(step);
      let outcome: string;
      try {
        if (step === 'run' || step === 'cancel') {
          const result = await runGaapExecutor(store(), step === 'cancel' ? AbortSignal.abort() : undefined);
          outcome = result.status;
        } else if (step === 'admit') {
          outcome = (await admitGaapOutput(store(), 1)).status;
        } else if (step === 'mutate') {
          await writeFile(path.join(fixture.workspace, 'source.txt'), 'generated repository mutation\n');
          outcome = 'mutated';
        } else if (step === 'evaluate') {
          const evaluation = evaluateGaapController(store());
          assert.equal(evaluation.lifecycle_mutated, false);
          assert.equal(
            evaluation.candidates.some((entry) => entry.available),
            false,
            'completion evidence cannot invent a lifecycle transition',
          );
          outcome = 'evaluated';
        } else {
          const before = await inspectGaapExecutor(store());
          assert.deepEqual(
            await inspectGaapExecutor(new GaapState(fixture.state)),
            before,
            'fresh SQLite reader must rebuild the same admitted history',
          );
          outcome = step === 'restart' ? 'restarted' : 'inspected';
        }
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
        assert.ok(error instanceof Error && error.message.length > 0, 'rejection needs an operator diagnostic');
        outcome = 'thrown';
      }
      assert.equal(outcome, expectedOutcome, `process step ${index}: ${step}`);
      const actual = await inspectGaapExecutor(new GaapState(fixture.state));
      assert.equal(actual.workflow_state, 'implementing');
      assert.equal(actual.state_version, 2);
      assert.deepEqual(
        {
          launches: actual.launch_count,
          observations: actual.observations.length,
          admitted: actual.admitted.length,
          request: actual.projection.request_status,
          attempt: actual.projection.attempts[0]!.status,
          changed: (await readFile(path.join(fixture.workspace, 'source.txt'), 'utf8')) !== initial,
        },
        model.observe(),
        `persisted process state after ${index}: ${step}`,
      );
      const retained = store().inspect();
      if (actual.admitted.length === 0)
        assert.equal(retained.blobs.length, 0, 'uncommitted admission must retain no partial blobs');
      assert.equal(
        retained.accepted.length,
        actual.projection.receipts.length,
        'authoritative receipt and retained signed evidence counts must agree',
      );
      assert.equal(retained.launches.length <= 1, true);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}
