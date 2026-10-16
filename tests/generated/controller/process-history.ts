import fc from 'fast-check';
import { runProcessHistory } from './process-adapter.js';
import { processHistorySchema, type ProcessHistory } from './process-model.js';

const mode = fc.constantFrom<ProcessHistory['mode']>(
  'success',
  'block',
  'failed',
  'interrupted',
  'effect_response_lost',
  'effect_publication_lost',
);
const fault = fc.constantFrom<ProcessHistory['fault']>(
  'none',
  'dispatch.before_commit',
  'dispatch.after_commit',
  'observation.before_commit',
  'admission.prepared',
  'admission.blobs',
  'admission.result',
  'admission.after_commit',
);
const step = fc.constantFrom<ProcessHistory['steps'][number]>(
  'run',
  'admit',
  'restart',
  'evaluate',
  'mutate',
  'inspect',
  'cancel',
);
export async function checkProcessHistories(seed: number, deep = false) {
  const histories = fc.record({
    schema: fc.constant('threadloop.generated-process-history/1' as const),
    mode,
    fault,
    steps: fc.array(step, { minLength: 1, maxLength: deep ? 16 : 6 }),
  });
  const result = await fc.check(
    fc.asyncProperty(histories, async (history) => {
      await runProcessHistory(processHistorySchema.parse(history));
    }),
    { seed, numRuns: deep ? 24 : 6 },
  );
  if (result.failed)
    throw new Error(
      'Generated process counterexample. Save the history as a named regression.\n' +
        JSON.stringify(
          {
            schema: 'threadloop.generated-failure/1',
            subject: 'threadloop.gaap-binding/1 + threadloop-contracts/0.1',
            seed: result.seed,
            path: result.counterexamplePath,
            shrinks: result.numShrinks,
            history: result.counterexample?.[0],
            cause: String(result.errorInstance),
          },
          null,
          2,
        ),
    );
}
