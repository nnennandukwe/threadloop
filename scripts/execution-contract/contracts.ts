import { z } from 'zod';
import { actionRequestSchema, controllerInputSchema, subjectSchema } from '../controller-contract/contracts.js';

const text = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ precision: 3 });
const identity = z.strictObject({ id: text, digest });
const requestReference = z.strictObject({ idempotency_key: digest, request_digest: digest });
const binding = controllerInputSchema.shape.binding;
const claimReference = z.strictObject({ id: text, version: counter.min(1) });
const executor = z.strictObject({ id: text, incarnation: text });
const actor = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('executor'), executor }),
  z.strictObject({ kind: z.enum(['threadloop', 'human']), identity }),
]);
const boundFields = { request: requestReference, binding, execution_policy: identity };
const attemptFields = { ...boundFields, claim: claimReference, attempt_id: text, executor };

export const executionPolicySchema = z.strictObject({
  id: text,
  digest,
  rules: z.strictObject({
    request: requestReference,
    workflow_policy: identity,
    retry_safety: z.enum(['reconciliation_required', 'repeatable_after_stop', 'repeatable_with_overlap']),
    max_attempts: counter.min(1),
  }),
});

export const attemptReceiptSchema = z.strictObject({
  receipt: z.strictObject({
    schema_version: z.literal('0.1'),
    id: text,
    ...attemptFields,
    status: z.enum(['succeeded', 'failed', 'blocked', 'interrupted', 'cancelled']),
    effect: z.enum(['none', 'occurred', 'unknown']),
    resulting_subject: subjectSchema.nullable(),
    finished_at: timestamp,
    evidence: z.array(identity),
  }),
  receipt_digest: digest,
});

// These are already-admitted independent observations, not executor assertions.
export const recoveryEvidenceSchema = z.strictObject({
  evidence: z.strictObject({
    schema_version: z.literal('0.1'),
    id: text,
    ...attemptFields,
    kind: z.enum(['executor_stopped', 'effect_occurred', 'no_effect']),
    observed_at: timestamp,
    resulting_subject: subjectSchema.nullable(),
    verification_policy: identity,
    acceptance: identity,
  }),
  evidence_digest: digest,
});

export const executionContextSchema = z.strictObject({
  snapshot: controllerInputSchema,
  actor,
  recovery_evidence: z.array(recoveryEvidenceSchema),
});

const target = { claim: claimReference, attempt_id: text };
const grant = { claim_id: text, attempt_id: text, executor, valid_until: timestamp };
export const executionOperationSchema = z.strictObject({
  schema_version: z.literal('0.1'),
  id: text,
  ...boundFields,
  actor,
  expected_revision: counter,
  expected_execution_digest: digest,
  command: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('acquire'), ...grant }),
    z.strictObject({ kind: z.literal('register_request'), request: actionRequestSchema }),
    z.strictObject({
      kind: z.literal('replace'),
      ...grant,
      previous_claim: claimReference,
      evidence_ids: z.array(text),
    }),
    z.strictObject({ kind: z.literal('start'), ...target }),
    z.strictObject({ kind: z.literal('renew'), ...target, valid_until: timestamp }),
    z.strictObject({ kind: z.literal('release'), ...target }),
    z.strictObject({ kind: z.literal('expire'), ...target }),
    z.strictObject({ kind: z.literal('cancel'), reason: text }),
    z.strictObject({
      kind: z.literal('invalidate'),
      reason: z.enum(['binding_changed', 'authority_revoked', 'integrity_failure', 'request_expired']),
    }),
    z.strictObject({ kind: z.literal('submit_receipt'), receipt: attemptReceiptSchema }),
    z.strictObject({
      kind: z.literal('reconcile'),
      ...target,
      disposition: z.enum(['effect_confirmed', 'no_effect_confirmed', 'abandon']),
      evidence_ids: z.array(text).min(1),
      reason: text,
    }),
    z.strictObject({ kind: z.literal('resolve_conflict'), conflict_id: digest, original_digest: digest, reason: text }),
  ]),
});

export const executionJournalSchema = z.strictObject({
  execution: z.strictObject({
    schema_version: z.literal('0.1'),
    action_request: actionRequestSchema,
    execution_policy: executionPolicySchema,
    initial_context: executionContextSchema,
    entries: z.array(z.strictObject({ context: executionContextSchema, operation: executionOperationSchema })),
  }),
  execution_digest: digest,
});

export const executionClaimSchema = z.strictObject({
  schema_version: z.literal('0.1'),
  id: text,
  version: counter.min(1),
  ...boundFields,
  executor,
  attempt_id: text,
  status: z.enum(['active', 'released', 'expired', 'replaced', 'invalidated', 'cancelled', 'completed']),
  acquired_at: timestamp,
  renewed_at: timestamp.nullable(),
  valid_until: timestamp,
  closed_at: timestamp.nullable(),
});

export const attemptSchema = z.strictObject({
  schema_version: z.literal('0.1'),
  id: text,
  ...boundFields,
  claim: claimReference,
  executor,
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
  created_at: timestamp,
  started_at: timestamp.nullable(),
  ended_at: timestamp.nullable(),
  receipt_id: text.nullable(),
  resulting_subject: subjectSchema.nullable(),
  resolution: z
    .strictObject({
      operation_id: text,
      disposition: z.enum(['effect_confirmed', 'no_effect_confirmed', 'abandon']),
      evidence_ids: z.array(text).min(1),
      operator: identity,
      resolved_at: timestamp,
    })
    .nullable(),
});

export type ExecutionJournal = z.infer<typeof executionJournalSchema>;
export type ExecutionContext = z.infer<typeof executionContextSchema>;
export type ExecutionOperation = z.infer<typeof executionOperationSchema>;
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;
export type ExecutionClaim = z.infer<typeof executionClaimSchema>;
export type Attempt = z.infer<typeof attemptSchema>;
export type AttemptReceipt = z.infer<typeof attemptReceiptSchema>;
export type RecoveryEvidence = z.infer<typeof recoveryEvidenceSchema>;

export function publishedExecutionSchemas() {
  return Object.fromEntries(
    Object.entries({
      'execution-journal': executionJournalSchema,
      'execution-operation': executionOperationSchema,
      'execution-claim': executionClaimSchema,
      attempt: attemptSchema,
      'attempt-receipt': attemptReceiptSchema,
      'recovery-evidence': recoveryEvidenceSchema,
      'execution-policy': executionPolicySchema,
    }).map(([name, schema]) => [
      name,
      {
        ...z.toJSONSchema(schema, { target: 'draft-2020-12', reused: 'ref' }),
        $id: `https://github.com/nnennandukwe/threadloop/contracts/execution/0.1/${name}`,
      },
    ]),
  );
}
