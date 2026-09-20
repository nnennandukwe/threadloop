import { z } from 'zod';
import { compiledGraphSchema } from '../workflow-graph/contracts.js';
import { controllerDecisionSchema, controllerInputSchema } from '../controller-contract/contracts.js';

const text = z.string().regex(/\S/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const caseId = z.string().regex(/^case_[0-9]{3}$/);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const claimReference = z.strictObject({ id: text, version: counter.min(1) });
const diagnosticSchema = z.strictObject({ code: text, path: text, identifier: text.nullable() });
const invalidResult = z.strictObject({ status: z.literal('invalid'), diagnostics: z.array(diagnosticSchema).min(1) });
const operation = z.enum(['compile_graph', 'decide', 'execution_scenario']);
export const versions = {
  protocol: 'threadloop.controller-conformance/0.1',
  request_schema: 'threadloop.conformance-request/0.1',
  response_schema: 'threadloop.conformance-response/0.1',
  fixture_schema: 'threadloop.conformance-fixture/0.1',
  manifest_schema: 'threadloop.conformance-manifest/0.1',
  canonicalization: 'threadloop.conformance-json/0.1',
  digest_profile: 'threadloop.conformance-sha256/0.1',
} as const;
const profileFields = {
  protocol: z.literal(versions.protocol),
  fixture_schema: z.literal(versions.fixture_schema),
  canonicalization: z.literal(versions.canonicalization),
  digest_profile: z.literal(versions.digest_profile),
};
export const subjectSchema = z.strictObject({ name: text, version: text, revision: text, artifact_digest: digest });
const requestPayload = z.strictObject({
  ...profileFields,
  schema: z.literal(versions.request_schema),
  corpus_digest: digest,
  case_id: caseId,
  operation,
  // Invalid domain documents are intentional test inputs. The transport remains strict.
  input: z.json(),
  input_digest: digest,
});
export const requestSchema = z.strictObject({ request: requestPayload, request_digest: digest });
const stepResult = z.strictObject({
  disposition: z.enum(['applied', 'rejected', 'conflict']),
  code: text,
  revision: counter,
  claim: claimReference.nullable(),
  attempt_id: text.nullable(),
  replayed: z.boolean(),
});
export const executionSummarySchema = z.strictObject({
  revision: counter,
  request_status: z.enum(['open', 'satisfied', 'cancelled', 'invalidated']),
  claims: z.array(
    z.strictObject({
      id: text,
      version: counter.min(1),
      attempt_id: text,
      status: z.enum(['active', 'released', 'expired', 'replaced', 'invalidated', 'cancelled', 'completed']),
    }),
  ),
  attempts: z.array(
    z.strictObject({
      id: text,
      claim: claimReference,
      status: z.enum([
        'pending',
        'running',
        'succeeded',
        'failed',
        'blocked',
        'interrupted',
        'cancelled',
        'unknown_outcome',
      ]),
      effect: z.enum(['not_started', 'none', 'occurred', 'unknown']),
      receipt_id: text.nullable(),
    }),
  ),
  receipts: z.array(z.strictObject({ id: text, receipt_digest: digest, code: text })),
  conflicts: z.array(
    z.strictObject({
      namespace: z.enum([
        'operation',
        'request',
        'receipt',
        'claim',
        'attempt',
        'recovery_evidence',
        'receipt_admission',
      ]),
      identity: text,
      original_digest: digest,
      incoming_digest: digest,
      resolved_by: text.nullable(),
    }),
  ),
  controller: controllerInputSchema.pick({ execution: true, invalidated_claims: true, existing_requests: true }),
});
export const resultSchema = z.discriminatedUnion('status', [
  invalidResult,
  z.strictObject({ status: z.literal('compiled'), compiled_graph: compiledGraphSchema }),
  z.strictObject({ status: z.literal('decision'), decision: controllerDecisionSchema }),
  z.strictObject({ status: z.literal('execution'), steps: z.array(stepResult), projection: executionSummarySchema }),
]);
export const responseSchema = z.strictObject({
  response: z.strictObject({
    ...profileFields,
    schema: z.literal(versions.response_schema),
    request_digest: digest,
    subject: subjectSchema,
    result: resultSchema,
  }),
  response_digest: digest,
});
export const requiredCoverage = [
  'valid_graph',
  'unreachable_terminal',
  'uncontrolled_cycle',
  'ambiguous_action',
  'duplicate_request',
  'concurrent_claims',
  'expired_claim',
  'replaced_claim',
  'stale_receipt',
  'late_receipt',
  'out_of_order_receipt',
  'gaap_without_authority',
  'human_completion',
  'post_verification_mutation',
  'idempotency_conflict',
] as const;
export const fixtureSchema = z.strictObject({
  schema: z.literal(versions.fixture_schema),
  id: caseId,
  title: text,
  rationale: text,
  references: z.array(text).min(1),
  coverage: z.array(z.enum([...requiredCoverage, 'positive_control'])).min(1),
  semantic_check: z.enum(['graph', 'candidate', 'execution', 'selection_pending']),
  operation,
  input: z.json(),
  expected: resultSchema,
});
const fixturePath = z.string().regex(/^fixtures\/case_[0-9]{3}\.json$/);
export const manifestSchema = z.strictObject({
  manifest: z.strictObject({
    ...profileFields,
    schema: z.literal(versions.manifest_schema),
    compatibility_digest: digest,
    entries: z
      .array(
        z.strictObject({
          id: caseId,
          operation,
          path: fixturePath,
          input_digest: digest,
          fixture_digest: digest,
        }),
      )
      .min(1),
  }),
  corpus_digest: digest,
});
export const compatibilitySchema = z.strictObject({
  schema: z.literal('threadloop.conformance-compatibility/0.1'),
  contracts: z
    .array(
      z.strictObject({
        name: z.enum(['workflow-graph', 'controller', 'execution', 'executor']),
        version: z.literal('0.1'),
        schemas: z.array(z.strictObject({ path: z.string().regex(/^[a-z-]+\.schema\.json$/), sha256: digest })).min(1),
      }),
    )
    .length(4),
});
// Concrete independent-host simulation, never populated from executor assertions.
export const executionScenarioSchema = z.strictObject({
  initial: z.strictObject({ context: z.json(), request: z.json(), policy: z.json() }),
  steps: z.array(z.strictObject({ context: z.json(), operation: z.json() })).max(256),
  admitted_digests: z.array(digest),
  projection_snapshot: z.json(),
});
export type Fixture = z.infer<typeof fixtureSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export type SubjectRequest = z.infer<typeof requestSchema>;
export type SubjectResponse = z.infer<typeof responseSchema>;
export type CaseResult = z.infer<typeof resultSchema>;

export function publishedConformanceSchemas() {
  return Object.fromEntries(
    Object.entries({
      request: requestSchema,
      response: responseSchema,
      fixture: fixtureSchema,
      manifest: manifestSchema,
      compatibility: compatibilitySchema,
      'execution-scenario': executionScenarioSchema,
    }).map(([name, schema]) => [
      name,
      {
        ...z.toJSONSchema(schema, { target: 'draft-2020-12', reused: 'ref' }),
        $id: `https://github.com/nnennandukwe/threadloop/contracts/controller-conformance/0.1/${name}`,
      },
    ]),
  );
}
