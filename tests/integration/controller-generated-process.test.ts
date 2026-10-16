import { it } from 'vitest';
import { runProcessHistory } from '../generated/controller/process-adapter.js';
import { checkProcessHistories } from '../generated/controller/process-history.js';

for (const seed of [112, 111])
  it(`generated real process and SQLite history, seed ${seed}`, async () => {
    await checkProcessHistories(seed);
  });

for (const mode of ['effect_response_lost', 'effect_publication_lost', 'block'] as const)
  it(`named regression: ${mode} survives restart without blind replay`, async () => {
    await runProcessHistory({
      schema: 'threadloop.generated-process-history/1',
      mode,
      fault: 'none',
      steps: ['run', 'restart', 'evaluate', 'run', 'inspect'],
    });
  });

for (const fault of [
  'none',
  'dispatch.before_commit',
  'dispatch.after_commit',
  'observation.before_commit',
  'admission.prepared',
  'admission.blobs',
  'admission.result',
  'admission.after_commit',
] as const)
  it(`named regression: ${fault} has consistent restart and retained-output recovery`, async () => {
    await runProcessHistory({
      schema: 'threadloop.generated-process-history/1',
      mode: 'success',
      fault,
      steps: ['run', 'restart', 'admit', 'restart', 'evaluate', 'run'],
    });
  });

it('named regression: pre-aborted dispatch rollback leaves a fresh run eligible', async () => {
  await runProcessHistory({
    schema: 'threadloop.generated-process-history/1',
    mode: 'success',
    fault: 'dispatch.before_commit',
    steps: ['cancel', 'restart', 'run', 'inspect'],
  });
});

for (const fault of ['admission.prepared', 'admission.blobs', 'admission.result'] as const)
  it(`named regression: ${fault} returns rejection from run and throws from direct admission`, async () => {
    await runProcessHistory({
      schema: 'threadloop.generated-process-history/1',
      mode: 'success',
      fault,
      steps: ['run', 'restart', 'rearm_fault', 'admit', 'restart', 'admit', 'inspect'],
    });
  });
