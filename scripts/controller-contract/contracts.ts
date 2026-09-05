import { z } from 'zod';
import { compiledGraphSchema, compiledPayloadSchema } from '../workflow-graph/contracts.js';

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const text = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ precision: 3 });
const identity = z.strictObject({ id: text, digest });
const references = z.array(identifier);

// Derive actor restrictions from the graph catalog instead of maintaining a second action list.
const [ordinaryAction, humanAction] = compiledPayloadSchema.shape.required_actions.element.options;
export const actionActorSchema = z.discriminatedUnion('capability', [
  z.strictObject({ capability: ordinaryAction.shape.capability, actor: ordinaryAction.shape.authority }),
  z.strictObject({ capability: humanAction.shape.capability, actor: humanAction.shape.authority }),
]);

const repositorySubject = z.strictObject({
  kind: z.literal('repository'),
  repository_id: text,
  revision: text,
  content_digest: digest,
});
export const subjectSchema = z.discriminatedUnion('kind', [
  repositorySubject,
  z.strictObject({ kind: z.literal('artifact'), artifact_id: text, content_digest: digest }),
]);

const authority = z.strictObject({ type: z.enum(['threadloop', 'human']), identity });
const evidencePayload = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('proof_plan'), plan: identity, baseline: repositorySubject }),
  z.strictObject({
    type: z.literal('local_proof'),
    gate_id: identifier,
    result: z.enum(['passed', 'failed', 'setup_failed']),
    clean: z.boolean(),
  }),
  z.strictObject({ type: z.literal('independent_proof'), gate_id: identifier, result: z.enum(['passed', 'failed']) }),
  z.strictObject({
    type: z.literal('pre_pr_review'),
    outcome: z.enum(['clean', 'changes_required']),
    findings: z.array(z.strictObject({ id: text, blocking: z.boolean() })),
  }),
  z.strictObject({
    type: z.literal('review'),
    outcome: z.enum(['clean', 'changes_required']),
    findings: z.array(z.strictObject({ id: text, blocking: z.boolean(), outdated: z.boolean() })),
  }),
  z.strictObject({
    type: z.literal('human_approval'),
    scope: z.enum(['current_subject', 'recovery']),
    approver: z.strictObject({ type: z.literal('human'), id: text }),
    reason: text,
  }),
  z.strictObject({ type: z.literal('completion_observed'), kind: z.enum(['merge', 'publication']), destination: text }),
  z.strictObject({
    type: z.literal('block_evidence'),
    reason: text,
    recovery: text,
    stop_code: text,
    prior_state: identifier,
  }),
  z.strictObject({ type: z.literal('stop_requested'), reason: text }),
  z.strictObject({
    type: z.literal('artifact'),
    stage: z.enum(['release_prepared', 'release_verified', 'publication_verified']),
    result: z.enum(['passed', 'failed']),
  }),
]);
const evidenceFamily = z.enum(evidencePayload.options.map((option) => option.shape.type.value));
const claimReference = z.strictObject({ id: text, version: counter.min(1) });
const requestReference = z.strictObject({ idempotency_key: digest, request_digest: digest });
const receipt = z.strictObject({
  id: identifier,
  workflow_run_id: text,
  graph_digest: digest,
  source_state_version: counter,
  subject: subjectSchema,
  sequence: counter.min(1),
  policy: identity,
  workflow_policy: identity,
  acceptance: identity,
  valid_until: timestamp.nullable(),
  origin: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('observation') }),
    z.strictObject({ kind: z.literal('attempt'), request: requestReference, claim: claimReference, attempt_id: text }),
  ]),
  payload: evidencePayload,
  payload_digest: digest,
});

const runBinding = z.strictObject({
  workflow_run_id: text,
  graph_schema_version: z.literal('0.1'),
  graph_digest: digest,
  source_state: identifier,
  state_version: counter,
  subject: subjectSchema,
});
const artifactInput = z.strictObject({
  role: z.enum(['change_context', 'proof_plan', 'implementation_basis', 'release_manifest', 'publication_target']),
  artifact: identity,
});
const requirements = z.array(
  z.strictObject({
    family: z.union([evidenceFamily, z.literal('repository_observation')]),
    guard_id: identifier,
    subject: subjectSchema,
  }),
);
const requestFields = {
  schema_version: z.literal('0.1'),
  binding: runBinding,
  capability_catalog: z.literal('threadloop.sdlc/0.1'),
  action_id: identifier,
  transition_id: identifier,
  guard_ids: references.min(1),
  inputs: z.array(artifactInput),
  evidence_ids: references,
  constraints: z.strictObject({
    require_current_subject: z.literal(true),
    lifecycle_mutation: z.literal(false),
    valid_until: timestamp.nullable(),
  }),
  policy: identity,
  authorities: z.array(authority).min(1),
  evidence_requirements: requirements.min(1),
  idempotency_key: digest,
};
const executorRequest = z.strictObject({
  ...requestFields,
  actor: z.literal('executor'),
  capability: ordinaryAction.shape.capability,
});
const humanRequest = z.strictObject({
  ...requestFields,
  actor: z.literal('human'),
  capability: z.enum([...ordinaryAction.shape.capability.options, ...humanAction.shape.capability.options]),
});
const requestPayloadSchema = z.discriminatedUnion('actor', [executorRequest, humanRequest]);
export const actionRequestSchema = z.strictObject({ request: requestPayloadSchema, request_digest: digest });
export const actionIntentSchema = z.strictObject({
  action_id: identifier,
  transition_id: identifier,
  guard_ids: references.min(1),
  inputs: z.array(artifactInput),
  evidence_ids: references,
  evidence_requirements: requirements.min(1),
  valid_until: timestamp.nullable(),
});
const activeClaim = claimReference.extend({ valid_until: timestamp });
const activeAttempt = z.strictObject({ id: text, status: z.enum(['pending', 'running']) });
const execution = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('idle') }),
  z.strictObject({
    status: z.literal('in_flight'),
    request: actionRequestSchema,
    claim: activeClaim,
    attempt: activeAttempt,
  }),
  z.strictObject({
    status: z.literal('reconciliation_required'),
    request: actionRequestSchema,
    claim: claimReference.nullable(),
    attempt_id: text.nullable(),
    reason: z.enum(['expired', 'replaced', 'unknown_outcome', 'conflict', 'cancelled']),
  }),
]);

export const controllerInputSchema = z.strictObject({
  schema_version: z.literal('0.1'),
  compiled_graph: compiledGraphSchema,
  binding: runBinding,
  observation: z.strictObject({
    id: text,
    subject: subjectSchema,
    state_version: counter,
    status: z.enum(['verified', 'unavailable', 'corrupt']),
    valid_until: timestamp.nullable(),
    repository: z
      .strictObject({
        branch: text.nullable(),
        clean: z.boolean(),
        basis: repositorySubject.nullable(),
        relationship: z.enum(['equal', 'descendant', 'unrelated', 'unknown']),
      })
      .nullable(),
  }),
  history: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('verified'),
      digest,
      proof_plan_bound: z.boolean(),
      phase: z.enum(['pre_pr', 'post_pr']).nullable(),
      budget_counts: z.array(z.strictObject({ budget_id: identifier, used: counter })),
      prior_state: identifier.nullable(),
      implementation_basis: subjectSchema.nullable(),
    }),
    z.strictObject({ status: z.enum(['unavailable', 'corrupt']), reason: text }),
  ]),
  policy: z.strictObject({
    id: text,
    digest,
    rules: z.strictObject({
      selection: z.literal('threadloop.remedies/0.1'),
      proof_plan: identity.nullable(),
      repository_binding: z.strictObject({ branch: text, baseline: repositorySubject }).nullable(),
      publication_destination: text.nullable(),
      local_gate_ids: references,
      independent_gate_ids: references,
      evidence_policies: z.array(identity),
      authorities: z.array(authority).min(1),
    }),
  }),
  available_capabilities: z.array(actionActorSchema),
  receipts: z.array(receipt),
  invalidated_claims: z.array(claimReference),
  execution,
  existing_requests: z.array(requestReference),
  evaluation_time: timestamp.nullable(),
});

const decisionFields = {
  schema_version: z.literal('0.1'),
  input_digest: digest,
  binding: runBinding,
};
const guardCheck = z.strictObject({ guard_id: identifier, evidence_ids: references });
const reasonFields = { message: text, recovery: text };
const decisionPayloadSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    ...decisionFields,
    outcome: z.literal('transition_available'),
    transition_id: identifier,
    target_state: identifier,
    checks: z.array(guardCheck),
  }),
  z.strictObject({
    ...decisionFields,
    outcome: z.literal('engineering_action_required'),
    action_request: z.strictObject({ request: executorRequest, request_digest: digest }),
  }),
  z.strictObject({
    ...decisionFields,
    outcome: z.literal('human_action_required'),
    action_request: z.strictObject({ request: humanRequest, request_digest: digest }),
  }),
  z.strictObject({
    ...decisionFields,
    outcome: z.literal('waiting'),
    request: requestReference,
    claim: claimReference,
    attempt_id: text,
  }),
  z.strictObject({
    ...decisionFields,
    outcome: z.literal('blocked'),
    reasons: z
      .array(
        z.discriminatedUnion('code', [
          z.strictObject({ code: z.literal('STALE_OBSERVATION'), ...reasonFields }),
          z.strictObject({ code: z.literal('INVALID_HISTORY'), ...reasonFields }),
          z.strictObject({ code: z.literal('EXECUTION_RECONCILIATION_REQUIRED'), ...reasonFields }),
          z.strictObject({ code: z.literal('CLAIM_EXPIRED'), ...reasonFields }),
          z.strictObject({ code: z.literal('UNSUPPORTED_CAPABILITY'), action_id: identifier, ...reasonFields }),
          z.strictObject({ code: z.literal('IDEMPOTENCY_CONFLICT'), request: requestReference, ...reasonFields }),
          z.strictObject({ code: z.literal('EVIDENCE_UNAVAILABLE'), guard_id: identifier, ...reasonFields }),
          z.strictObject({ code: z.literal('AUTHORITY_UNAVAILABLE'), transition_id: identifier, ...reasonFields }),
          z.strictObject({ code: z.literal('AMBIGUOUS_REMEDY'), ...reasonFields }),
          z.strictObject({ code: z.literal('NO_APPLICABLE_REMEDY'), ...reasonFields }),
        ]),
      )
      .min(1),
  }),
  z.strictObject({ ...decisionFields, outcome: z.literal('terminal'), terminal_state: identifier }),
]);
export const controllerDecisionSchema = z.strictObject({ decision: decisionPayloadSchema, decision_digest: digest });

export type ControllerInput = z.infer<typeof controllerInputSchema>;
export type ActionIntent = z.infer<typeof actionIntentSchema>;
export type ActionRequest = z.infer<typeof actionRequestSchema>;
export type ControllerDecision = z.infer<typeof controllerDecisionSchema>;

export function publishedControllerSchemas() {
  return Object.fromEntries(
    Object.entries({
      'controller-input': controllerInputSchema,
      'controller-decision': controllerDecisionSchema,
      'action-request': actionRequestSchema,
    }).map(([name, schema]) => [
      name,
      {
        ...z.toJSONSchema(schema, { target: 'draft-2020-12', reused: 'ref' }),
        $id: `https://github.com/nnennandukwe/threadloop/contracts/controller/0.1/${name}`,
      },
    ]),
  );
}
