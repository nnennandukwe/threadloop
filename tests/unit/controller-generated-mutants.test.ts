import { expect, it } from 'vitest';
import { runHistory } from '../generated/controller/history.js';
import { mutants, withMutant } from '../generated/controller/mutants.js';
import { scenarioSchema } from '../generated/controller/scenario.js';
import type { Scenario } from '../generated/controller/scenario.js';

for (const mutant of mutants)
  it(`kills ${mutant.name} in executable subject code`, async () => {
    const history: Scenario = {
      schema: 'threadloop.generated-history/1',
      retry: 'reconciliation_required',
      steps: mutant.steps,
    };
    await runHistory(history);
    await withMutant(mutant, async (apis) => {
      await expect(runHistory(history, apis)).rejects.toThrow(
        mutant.name === 'duplicate advancement' ? /DUPLICATE_JOURNAL_ENTRY|audit entry count/ : /step |executor cannot/,
      );
    });
  });

it('shrinks an unsafe subject history reproducibly and retains a standalone replay sequence', async () => {
  const { default: fc } = await import('fast-check');
  const mutant = mutants[0]!;
  await withMutant(mutant, async (apis) => {
    const property = fc.asyncProperty(
      fc.array(fc.constant({ kind: 'restart' as const }), { maxLength: 12 }),
      async (noise) => {
        await runHistory(
          {
            schema: 'threadloop.generated-history/1',
            retry: 'reconciliation_required',
            steps: [...noise, ...mutant.steps],
          },
          apis,
        );
      },
    );
    const first = await fc.check(property, { seed: 112, numRuns: 10 });
    const repeated = await fc.check(property, { seed: 112, numRuns: 10 });
    expect(first.failed).toBe(true);
    expect(first.numShrinks).toBeGreaterThan(0);
    expect(repeated.counterexamplePath).toBe(first.counterexamplePath);
    expect(repeated.counterexample).toEqual(first.counterexample);
    expect(first.counterexample).toEqual([[]]);
    const serialized = JSON.stringify({
      schema: 'threadloop.generated-history/1',
      retry: 'reconciliation_required',
      steps: [...first.counterexample![0], ...mutant.steps],
    });
    const history = scenarioSchema.parse(JSON.parse(serialized));
    await runHistory(history);
    await expect(runHistory(history, apis)).rejects.toThrow(/step /);
  });
});
