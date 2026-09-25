import { digest, same, validateShape, type ValidationResult } from '../contract-kernel/kernel.js';
import { executorRequestSchema, executorResultSchema, type ExecutorRequest, type ExecutorResult } from './contracts.js';
import { invalid, validateJsonValue } from './codec.js';
import { projectControllerExecution, replayExecutionJournal, requestReference } from '../execution-contract/model.js';
import type { ExecutionAuthority } from '../execution-contract/authority.js';
import { executionJournalSchema } from '../execution-contract/contracts.js';
import { sameSubjectIdentity } from '../controller-contract/contracts.js';
import { requestIdentity } from '../controller-contract/validation.js';

export function validateExecutorRequest(value: unknown): ValidationResult<ExecutorRequest> {
  const bounded = validateJsonValue(value);
  if (!bounded.ok) return bounded;
  const parsed = validateShape(executorRequestSchema, value);
  if (!parsed.ok) return parsed;
  const envelope = parsed.value;
  const { request } = envelope;
  const action = request.action_request;
  if (digest(request) !== envelope.request_digest || digest(action.request) !== action.request_digest)
    return invalid(
      'REQUEST_DIGEST_MISMATCH',
      'Executor and Action Request contents must match their retained digests.',
    );
  if (action.request.actor !== 'executor')
    return invalid('HUMAN_REQUEST', 'Human Action Requests cannot enter the executor interface.');
  if (action.request.idempotency_key !== requestIdentity(action.request.binding, action.request.action_id))
    return invalid('REQUEST_IDENTITY_MISMATCH', 'Action identity must match the exact action slot.');
  // The schema already rejects duplicate policies and evidence types.
  const approvals = request.parameters.approval_context;
  if (new Set(approvals.map((approval) => approval.approval_id)).size !== approvals.length)
    return invalid('DUPLICATE_PARAMETER', 'Approval identities must be unique.');
  if (
    approvals.some(
      (approval) =>
        approval.subject_digest !== action.request.binding.subject.content_digest ||
        approval.evidence.evidence_type !== 'approval',
    )
  )
    return invalid(
      'APPROVAL_BINDING_MISMATCH',
      'Approval evidence must target the exact requested subject and use the approval evidence type.',
    );
  return parsed;
}

/** Identifies a host-approved immutable request; the digest is not an authentication mechanism. */
export function executorRequestAdmissionDigest(request: ExecutorRequest): string {
  return digest({ domain: 'threadloop.executor-request-admission/0.1', request });
}

/** Development preflight, not a dispatch or receipt admission. Requires independently admitted history and snapshot. */
export function validateExecutorContext(
  value: unknown,
  journal: unknown,
  snapshot: unknown,
  authority: ExecutionAuthority,
): ValidationResult<ExecutorRequest> {
  const parsed = validateExecutorRequest(value);
  if (!parsed.ok) return parsed;
  const projection = projectControllerExecution(journal, snapshot, authority);
  if (!projection.ok) return projection;
  const history = validateShape(executionJournalSchema, journal);
  if (!history.ok) return history;
  const replay = replayExecutionJournal(history.value, authority);
  if (!replay.ok) return replay;
  const request = parsed.value.request;
  const current = projection.value.execution;
  if (
    current.status !== 'in_flight' ||
    current.attempt.status !== 'running' ||
    !same(current.request, request.action_request) ||
    !same({ id: current.claim.id, version: current.claim.version }, request.claim) ||
    current.attempt.id !== request.attempt_id ||
    !same(replay.value.claims.at(-1)?.executor, request.executor) ||
    !same(request.execution_policy, {
      id: history.value.execution.execution_policy.id,
      digest: history.value.execution.execution_policy.digest,
    })
  )
    return invalid(
      'EXECUTOR_CONTEXT_MISMATCH',
      'A current started Attempt with exact claim, executor, policy, and request bindings is required.',
    );
  try {
    if (authority.isAdmitted(executorRequestAdmissionDigest(parsed.value)) !== true)
      return invalid(
        'UNTRUSTED_EXECUTOR_REQUEST',
        'Independent authority must approve the complete execution parameters and mapping-policy identity.',
      );
  } catch {
    return invalid('UNTRUSTED_EXECUTOR_REQUEST', 'Executor request authority is unavailable.');
  }
  return parsed;
}

export function validateExecutorResult(value: unknown, requestValue: unknown): ValidationResult<ExecutorResult> {
  const request = validateExecutorRequest(requestValue);
  if (!request.ok) return request;
  const bounded = validateJsonValue(value);
  if (!bounded.ok) return bounded;
  const parsed = validateShape(executorResultSchema, value);
  if (!parsed.ok) return parsed;
  const { result } = parsed.value;
  const receipt = result.attempt_receipt.receipt;
  const input = request.value.request;
  if (digest(result) !== parsed.value.result_digest || digest(receipt) !== result.attempt_receipt.receipt_digest)
    return invalid('RESULT_DIGEST_MISMATCH', 'Result and Attempt receipt must match their canonical digests.');
  if (
    result.request_digest !== request.value.request_digest ||
    !same(receipt.request, requestReference(input.action_request)) ||
    !same(receipt.binding, input.action_request.request.binding) ||
    !same(receipt.execution_policy, input.execution_policy) ||
    !same(receipt.claim, input.claim) ||
    receipt.attempt_id !== input.attempt_id ||
    !same(receipt.executor, input.executor)
  )
    return invalid(
      'RESULT_BINDING_MISMATCH',
      'Result must retain every exact request, run, graph, state, subject, policy, claim, Attempt, and executor binding.',
    );
  const statuses = {
    completed: 'succeeded',
    authority_required: 'blocked',
    effect_denied: 'blocked',
    blocked: 'blocked',
    failed: 'failed',
    interrupted: 'interrupted',
    cancelled: 'cancelled',
    budget_exhausted: 'blocked',
  } as const;
  if (receipt.status !== statuses[result.reason.code])
    return invalid('RESULT_STATUS_MISMATCH', 'Reason and Attempt status disagree.');
  if (receipt.status === 'succeeded' && (receipt.effect === 'unknown' || receipt.evidence.length === 0))
    return invalid('INVALID_SUCCESS', 'A successful candidate requires known effect claims and supporting evidence.');
  if (receipt.effect === 'occurred' && receipt.resulting_subject === null)
    return invalid('RESULT_SUBJECT_MISMATCH', 'An occurred effect must identify the resulting subject.');
  const initialSubject = input.action_request.request.binding.subject;
  const resultingSubject = receipt.resulting_subject;
  if (!sameSubjectIdentity(resultingSubject, initialSubject))
    return invalid('RESULT_SUBJECT_MISMATCH', 'Result must identify the original repository or artifact.');
  let currentDigest = initialSubject.content_digest;
  for (const effect of result.effects) {
    if (effect.before_subject_digest !== currentDigest)
      return invalid('RESULT_EFFECT_MISMATCH', 'Observed mutations must form a contiguous subject chain.');
    currentDigest = effect.after_subject_digest;
  }
  if (
    (receipt.effect === 'none' &&
      (result.effects.length > 0 || (resultingSubject !== null && !same(resultingSubject, initialSubject)))) ||
    (receipt.effect === 'occurred' && result.effects.length === 0) ||
    (result.effects.length > 0 && resultingSubject?.content_digest !== currentDigest) ||
    (receipt.status === 'succeeded' && resultingSubject !== null && resultingSubject.content_digest !== currentDigest)
  )
    return invalid('RESULT_EFFECT_MISMATCH', 'Effect claims and resulting subject disagree with the mutation summary.');
  if (new Set(receipt.evidence.map((entry) => entry.id)).size !== receipt.evidence.length)
    return invalid(
      'DUPLICATE_RESULT_EVIDENCE',
      'Attempt receipt evidence IDs must be unique; assign a distinct identity to each retained entry.',
    );
  if (
    !receipt.evidence.some(
      (entry) => entry.id === result.source_receipt.id && entry.digest === result.source_receipt.digest,
    )
  )
    return invalid(
      'RESULT_SOURCE_MISMATCH',
      'The source receipt identity and digest must be retained in Attempt receipt evidence.',
    );
  const retainedDigests = new Set(receipt.evidence.map((entry) => entry.digest));
  const reportedEvidence = [
    ...result.evidence,
    ...result.effects.flatMap((effect) => effect.evidence),
    ...result.verification.flatMap((verification) => verification.evidence),
  ];
  if (reportedEvidence.some((entry) => !retainedDigests.has(entry.digest)))
    return invalid(
      'RESULT_EVIDENCE_MISMATCH',
      'Retain every reported supporting, effect, and verification evidence digest in the Attempt receipt.',
    );
  if (receipt.status === 'succeeded') {
    const verification = result.verification.filter((entry) => entry.subject_digest === currentDigest).at(-1);
    if (
      !verification ||
      verification.verdict !== 'PASS' ||
      verification.actor_id === input.executor.id ||
      !input.parameters.required_verification.evidence_types.every((type) =>
        verification.evidence.some((entry) => entry.evidence_type === type),
      )
    )
      return invalid(
        'RESULT_VERIFICATION_MISMATCH',
        'Success requires latest-subject passing verification by a different actor with every requested evidence type.',
      );
  }
  const budget = input.parameters.resource_budget;
  if (
    receipt.status === 'succeeded' &&
    (result.usage.cost_micros > budget.max_cost_micros ||
      result.usage.elapsed_ms > budget.max_elapsed_ms ||
      result.usage.model_tokens > budget.max_model_tokens ||
      result.usage.tool_calls > budget.max_tool_calls)
  )
    return invalid('RESULT_USAGE_MISMATCH', 'A successful candidate cannot exceed its explicit resource budget.');
  return parsed;
}
