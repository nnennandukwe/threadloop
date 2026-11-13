import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { ControllerModel } from './model.js';
import { ControllerAdapter } from './adapter.js';
import type { Scenario, Step } from './scenario.js';

const slot = fc.integer({ min: 0, max: 3 });
const actor = fc.constantFrom<'a' | 'b'>('a', 'b');
const stepArbitrary: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constantFrom<'acquire' | 'replace'>('acquire', 'replace'),
    slot,
    actor,
    lease: fc.integer({ min: 1, max: 10 }),
  }),
  fc.record({ kind: fc.constantFrom<'start' | 'release' | 'renew'>('start', 'release', 'renew'), slot, actor }),
  fc.record({ kind: fc.constant('expire' as const), slot }),
  fc.record({
    kind: fc.constant('reconcile' as const),
    slot,
    actor: fc.constantFrom('human' as const, 'executor' as const),
    disposition: fc.constantFrom('no_effect_confirmed' as const, 'effect_confirmed' as const, 'abandon' as const),
    proof: fc.constantFrom('complete' as const, 'missing' as const, 'contradictory' as const),
  }),
  fc.record({
    kind: fc.constant('receipt' as const),
    slot,
    identity: slot,
    status: fc.constantFrom<'succeeded' | 'failed' | 'interrupted'>('succeeded', 'failed', 'interrupted'),
    effect: fc.constantFrom<'none' | 'unknown' | 'occurred'>('none', 'unknown', 'occurred'),
    fault: fc.constantFrom<'none' | 'digest' | 'binding' | 'admission' | 'expired_admission' | 'future' | 'malformed'>(
      'none',
      'digest',
      'binding',
      'admission',
      'expired_admission',
      'future',
      'malformed',
    ),
  }),
  fc.record({ kind: fc.constant('receipt_replay' as const), identity: slot, changed: fc.boolean() }),
  fc.record({ kind: fc.constant('redeliver' as const), index: fc.integer({ min: 0, max: 15 }), changed: fc.boolean() }),
  fc.record({
    kind: fc.constant('cancel' as const),
    actor: fc.constantFrom<'executor' | 'controller' | 'human'>('executor', 'controller', 'human'),
  }),
  fc.record({ kind: fc.constant('clock' as const), by: fc.integer({ min: 1, max: 12 }) }),
  fc.record({
    kind: fc.constant('drift' as const),
    field: fc.constantFrom(
      'none' as const,
      'subject' as const,
      'state' as const,
      'graph' as const,
      'policy' as const,
      'authority' as const,
      'capability' as const,
    ),
  }),
  fc.record({
    kind: fc.constantFrom(
      'restart' as const,
      'evaluate' as const,
      'register_duplicate' as const,
      'register_conflict' as const,
      'invalidate' as const,
      'untrusted' as const,
      'human_request' as const,
      'terminal' as const,
      'executor_transition' as const,
    ),
  }),
);
const acquired: Step[] = [{ kind: 'acquire', slot: 0, actor: 'a', lease: 5 }];
const started: Step[] = [...acquired, { kind: 'start', slot: 0, actor: 'a' }];
const expired: Step[] = [...started, { kind: 'clock', by: 5 }, { kind: 'expire', slot: 0 }];
const prefixes: Step[][] = [
  [],
  acquired,
  started,
  expired,
  [...expired, { kind: 'replace', slot: 1, actor: 'b', lease: 5 }],
  [...started, { kind: 'receipt', slot: 0, identity: 0, status: 'succeeded', effect: 'none', fault: 'none' }],
];
export const profiles = {
  ci: { seeds: [112, 106108, 111112], runs: 24, maxSteps: 20 },
  deep: { seeds: [112, 106108, 111112, 20260920], runs: 128, maxSteps: 64 },
} as const;
export function historyArbitrary(maxSteps: number): fc.Arbitrary<Scenario> {
  return fc.record({
    schema: fc.constant('threadloop.generated-history/1' as const),
    retry: fc.constantFrom('reconciliation_required' as const, 'repeatable_with_overlap' as const),
    steps: fc
      .tuple(fc.constantFrom(...prefixes), fc.array(stepArbitrary, { maxLength: maxSteps }))
      .map(([prefix, suffix]) => [...prefix, ...suffix]),
  });
}
export async function runHistory(
  scenario: Scenario,
  options: {
    api?: Parameters<typeof ControllerAdapter.create>[1];
    controllerApi?: Parameters<typeof ControllerAdapter.create>[2];
  } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'threadloop-history-'));
  try {
    const model = new ControllerModel(scenario);
    const adapter = await ControllerAdapter.create(scenario, options.api, options.controllerApi);
    assert.deepEqual(adapter.observe(), model.observe(), 'initial state');
    for (const [index, step] of scenario.steps.entries()) {
      model.apply(step, index);
      await adapter.apply(step, index, path.join(directory, 'journal.json'));
      assert.deepEqual(adapter.observe(), model.observe(), `step ${index}: ${JSON.stringify(step)}`);
    }
    return adapter.conformanceInput();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function checkHistories(seed: number, maxSteps: number, runs: number) {
  const outcome = await fc.check(
    fc.asyncProperty(historyArbitrary(maxSteps), async (history) => {
      await runHistory(history);
    }),
    { seed, numRuns: runs, verbose: true },
  );
  if (outcome.failed)
    throw new Error(
      'Generated controller counterexample. Save the history as a named regression and run ' +
        'npm run test:controller:replay -- history.json\n' +
        JSON.stringify(
          {
            schema: 'threadloop.generated-failure/1',
            subject: 'threadloop-contracts/0.1',
            seed: outcome.seed,
            path: outcome.counterexamplePath,
            shrinks: outcome.numShrinks,
            history: outcome.counterexample?.[0],
            cause: String(outcome.errorInstance),
          },
          null,
          2,
        ),
    );
}
