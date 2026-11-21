import { z } from 'zod';
import { createWorkflowStore } from '../adapters/fs/workflow-store.js';
import { readGaapFile } from '../adapters/fs/gaap-files.js';
import { ThreadloopError } from '../contracts/errors.js';
import { isPlainObject } from '../domain/canonical-json.js';
import { parseGaapJson } from '../domain/gaap-json.js';
import type { DecisionReply } from '../domain/workflow-run.js';
import { assertInitializedReadOnly, resolveRepositoryRoot } from './preconditions.js';
import { validateWorkflowRunId } from './workflow-genesis.js';

export async function workflowStoreFor(cwd: string, run: string) {
  validateWorkflowRunId(run);
  const root = await resolveRepositoryRoot(cwd);
  await assertInitializedReadOnly(root);
  return { root, store: createWorkflowStore(root) };
}

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const identity = z.strictObject({ id: z.string().min(1), digest });
const expected = z.strictObject({
  workflow_run_id: z.string().min(1),
  graph_schema_version: z.literal('0.1'),
  graph_digest: digest,
  policy: identity,
  state: z.string().min(1),
  state_version: z.number().int().nonnegative(),
  history_digest: digest,
  evidence_revision: z.number().int().nonnegative(),
  subject: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('repository'),
      repository_id: z.string().min(1),
      revision: z.string().min(1),
      content_digest: digest,
    }),
    z.strictObject({ kind: z.literal('artifact'), artifact_id: z.string().min(1), content_digest: digest }),
  ]),
  evaluation_time: z.iso.datetime({ precision: 3 }),
  input_digest: digest,
  decision_digest: digest,
});

export function readWorkflowDecision(filename: string, run: string): DecisionReply {
  const raw = parseGaapJson(readGaapFile(filename, 4 * 1024 * 1024));
  const result = z
    .strictObject({
      ok: z.literal(true),
      command: z.literal('workflow decide'),
      data: z.strictObject({
        controller_decision: z.strictObject({ decision: z.record(z.string(), z.unknown()), decision_digest: digest }),
        expectation: z.union([
          expected,
          expected.extend({ execution_revision: z.number().int().nonnegative(), execution_digest: digest }),
        ]),
      }),
    })
    .safeParse(raw);
  if (
    !result.success ||
    result.data.data.expectation.workflow_run_id !== run ||
    !isPlainObject(result.data.data.controller_decision.decision.binding)
  )
    throw new ThreadloopError('INVALID_ARGUMENT', 'Supply a successful workflow decide response for this run.', {
      details: {
        reason: 'invalid_decision',
        hint: 'Run threadloop workflow decide for this run and save its JSON response.',
      },
    });
  // Every field is compared with the full decision reconstructed by the selector under the writer lock.
  return result.data.data as DecisionReply;
}
