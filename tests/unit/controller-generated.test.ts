import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { canonicalExecutorJson } from 'threadloop-contracts/executor';
import { checkHistories, profiles, runHistory } from '../generated/controller/history.js';
import { scenarioSchema } from '../generated/controller/scenario.js';

const fixtureSchema = z.array(z.strictObject({ name: z.string(), history: scenarioSchema }));
const fixtures = fixtureSchema.parse(
  JSON.parse(await readFile(new URL('../fixtures/controller-generated/regressions.json', import.meta.url), 'utf8')),
);
const profile = profiles.ci;
describe('generated controller histories over public contracts', () => {
  for (const fixture of fixtures)
    it(fixture.name, async () => {
      await runHistory(fixture.history);
    });
  for (const seed of profile.seeds)
    it(`seed ${seed}, ${profile.runs} histories, at most ${profile.maxSteps + 5} steps`, async () => {
      await checkHistories(seed, profile.maxSteps, profile.runs);
    });
});

it('uses the published canonical bytes across the public adapter boundary', async () => {
  const bytes = (
    await readFile(
      new URL(import.meta.resolve('threadloop-contracts/assets/executor-v0.1/fixtures/gaap-request.canonical')),
      'utf8',
    )
  ).trimEnd();
  const value: unknown = JSON.parse(bytes);
  const canonical = canonicalExecutorJson(value);
  expect(canonical.ok && canonical.value).toBe(bytes);
});
