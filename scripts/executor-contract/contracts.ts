import { z } from 'zod';
import { actionRequestSchema, subjectSchema } from '../controller-contract/contracts.js';
import { executionDigest } from '../execution-contract/model.js';
import { attemptReceiptSchema } from '../execution-contract/contracts.js';

const text = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identity = z.strictObject({ id: text, digest });
export const versionedIdentitySchema = z.strictObject({ name: text, version: text, digest });
export const evidenceTypeSchema = z.enum([
  'approval',
  'command_output',
  'artifact',
  'tool_execution',
  'verification_attestation',
  'resource_usage',
  'interruption',
]);
export const evidenceSchema = z.strictObject({ evidence_type: evidenceTypeSchema, digest, locator: text.nullable() });
export const budgetSchema = z.strictObject({
  max_cost_micros: counter,
  max_elapsed_ms: counter,
  max_model_tokens: counter,
  max_tool_calls: counter,
});
export const usageSchema = z.strictObject({
  cost_micros: counter,
  elapsed_ms: counter,
  model_tokens: counter,
  tool_calls: counter,
});
function uniqueArray<T extends z.ZodType>(element: T) {
  return z
    .array(element)
    .min(1)
    .refine((items) => new Set(items.map(executionDigest)).size === items.length, {
      message: 'Array entries must be unique.',
    })
    .meta({ uniqueItems: true });
}

export const parametersSchema = z.strictObject({
  subject_locator: text,
  capability: versionedIdentitySchema,
  task: z.strictObject({ instructions: text, constraints: z.array(text) }),
  policies: uniqueArray(versionedIdentitySchema),
  resource_budget: budgetSchema,
  approval_context: z.array(
    z.strictObject({
      approval_id: text,
      actor_id: text,
      scope: text,
      subject_digest: digest,
      evidence: evidenceSchema,
    }),
  ),
  required_verification: z.strictObject({
    independence: z.literal('different_actor'),
    evidence_types: uniqueArray(evidenceTypeSchema),
  }),
});
const report = attemptReceiptSchema.shape.receipt;
const action = actionRequestSchema.shape.request.options[0];
export const executorRequestSchema = z.strictObject({
  request: z.strictObject({
    schema_version: z.literal('threadloop.executor/0.1'),
    kind: z.literal('execute'),
    action_request: actionRequestSchema.extend({ request: action }),
    execution_policy: report.shape.execution_policy,
    claim: report.shape.claim,
    attempt_id: report.shape.attempt_id,
    executor: report.shape.executor,
    mapping_policy: identity,
    parameters: parametersSchema,
  }),
  request_digest: digest,
});
export const executorResultSchema = z.strictObject({
  result: z.strictObject({
    schema_version: z.literal('threadloop.executor/0.1'),
    kind: z.literal('result'),
    request_digest: digest,
    attempt_receipt: attemptReceiptSchema,
    source_receipt: z.strictObject({ type: z.literal('terminal_run_receipt'), id: text, digest }),
    effects: z.array(
      z.strictObject({
        effect_digest: digest,
        before_subject_digest: digest,
        after_subject_digest: digest,
        evidence: z.array(evidenceSchema).min(1),
      }),
    ),
    verification: z.array(
      z.strictObject({
        actor_id: text,
        subject_digest: digest,
        verdict: z.enum(['PASS', 'FAIL']),
        evidence: z.array(evidenceSchema).min(1),
      }),
    ),
    evidence: z.array(evidenceSchema),
    usage: usageSchema,
    reason: z.strictObject({
      code: z.enum([
        'completed',
        'authority_required',
        'effect_denied',
        'blocked',
        'failed',
        'interrupted',
        'cancelled',
        'budget_exhausted',
      ]),
      message: text,
    }),
  }),
  result_digest: digest,
});
export const gaapMappingPolicySchema = z.strictObject({
  policy: z.strictObject({
    schema_version: z.literal('threadloop.gaap-mapping/0.1'),
    id: text,
    action_capability: action.shape.capability,
    capability: versionedIdentitySchema,
    policies: uniqueArray(versionedIdentitySchema),
    evidence_mapping: z
      .array(
        z.strictObject({
          family: action.shape.evidence_requirements.element.shape.family,
          evidence_types: uniqueArray(evidenceTypeSchema),
        }),
      )
      .min(1),
  }),
  policy_digest: digest,
});
export const resultObservationSchema = z.strictObject({
  finished_at: report.shape.finished_at,
  resulting_subject: subjectSchema,
});
export type ExecutorRequest = z.infer<typeof executorRequestSchema>;
export type ExecutorResult = z.infer<typeof executorResultSchema>;
export type GaapMappingPolicy = z.infer<typeof gaapMappingPolicySchema>;
export type Evidence = z.infer<typeof evidenceSchema>;

export function publishedExecutorSchemas() {
  return Object.fromEntries(
    Object.entries({
      'executor-request': executorRequestSchema,
      'executor-result': executorResultSchema,
      'gaap-mapping-policy': gaapMappingPolicySchema,
      'result-observation': resultObservationSchema,
    }).map(([name, schema]) => [
      name,
      {
        ...z.toJSONSchema(schema, { target: 'draft-2020-12', reused: 'inline' }),
        $id: `https://github.com/nnennandukwe/threadloop/contracts/executor/0.1/${name}`,
      },
    ]),
  );
}
