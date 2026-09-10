import { validateShape, type ValidationResult } from '../workflow-graph/contracts.js';
import { executorRequestSchema, executorResultSchema, type ExecutorRequest, type ExecutorResult } from './contracts.js';
import { invalid, validateJsonValue } from './codec.js';
import {
  executionDigest,
  projectControllerExecution,
  replayExecutionJournal,
  requestReference,
} from '../execution-contract/model.js';
import type { ExecutionAuthority } from '../execution-contract/authority.js';
import { executionJournalSchema } from '../execution-contract/contracts.js';
import { requestIdentity, same } from '../controller-contract/validation.js';

export function validateExecutorRequest(value: unknown): ValidationResult<ExecutorRequest> {
  const bounded = validateJsonValue(value);
  if (!bounded.ok) return bounded;
  const parsed = validateShape(executorRequestSchema, value);
  if (!parsed.ok) return parsed;
  const envelope = parsed.value;
  const { request } = envelope;
  const action = request.action_request;
  if (executionDigest(request) !== envelope.request_digest || executionDigest(action.request) !== action.request_digest)
    return invalid(
      'REQUEST_DIGEST_MISMATCH',
      'Executor and Action Request contents must match their retained digests.',
    );
  if (action.request.actor !== 'executor')
    return invalid('HUMAN_REQUEST', 'Human Action Requests cannot enter the executor interface.');
  if (action.request.idempotency_key !== requestIdentity(action.request.binding, action.request.action_id))
    return invalid('REQUEST_IDENTITY_MISMATCH', 'Action identity must match the exact action slot.');
  const parameters = request.parameters;
  const unique = (items: unknown[]) => new Set(items.map(executionDigest)).size === items.length;
  if (
    !unique(parameters.policies) ||
    !unique(parameters.required_verification.evidence_types) ||
    new Set(parameters.approval_context.map((approval) => approval.approval_id)).size !==
      parameters.approval_context.length
  )
    return invalid('DUPLICATE_PARAMETER', 'Policies, required evidence types, and approval identities must be unique.');
  if (
    parameters.approval_context.some(
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
  return executionDigest({ domain: 'threadloop.executor-request-admission/0.1', request });
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
  if (
    executionDigest(result) !== parsed.value.result_digest ||
    executionDigest(receipt) !== result.attempt_receipt.receipt_digest
  )
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
  if (
    resultingSubject !== null &&
    (resultingSubject.kind !== initialSubject.kind ||
      (initialSubject.kind === 'repository' &&
        resultingSubject.kind === 'repository' &&
        initialSubject.repository_id !== resultingSubject.repository_id) ||
      (initialSubject.kind === 'artifact' &&
        resultingSubject.kind === 'artifact' &&
        initialSubject.artifact_id !== resultingSubject.artifact_id))
  )
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
  const budget = input.parameters.resource_budget;
  if (
    receipt.status === 'succeeded' &&
    (result.usage.cost_micros > budget.max_cost_micros ||
      result.usage.elapsed_ms > budget.max_elapsed_ms ||
      result.usage.model_tokens > budget.max_model_tokens ||
      result.usage.tool_calls > budget.max_tool_calls)
  )
    return invalid('RESULT_USAGE_MISMATCH', 'A successful candidate cannot exceed its explicit resource budget.');
  if (
    !Number.isFinite(Date.parse(receipt.finished_at)) ||
    new Date(receipt.finished_at).toISOString() !== receipt.finished_at
  )
    return invalid('INVALID_TIMESTAMP', 'Completion time must be a real UTC instant with millisecond precision.');
  return parsed;
}
