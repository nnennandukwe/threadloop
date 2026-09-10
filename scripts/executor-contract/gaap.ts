import { validateShape, type ValidationResult } from '../workflow-graph/contracts.js';
import { gaapMappingPolicySchema, resultObservationSchema, type Evidence, type ExecutorResult } from './contracts.js';
import type { GaapRequest } from './gaap-types.js';
import { invalid, parseExecutorMessage, validateJsonValue } from './codec.js';
import { validateExecutorRequest, validateExecutorResult } from './validation.js';
import { executionDigest, requestReference } from '../execution-contract/model.js';
import { same } from '../controller-contract/validation.js';
import { validateGaapReceipt, validateGaapRequest } from './gaap-validation.js';

export function buildGaapRequest(requestValue: unknown, policyValue: unknown): ValidationResult<GaapRequest> {
  const request = validateExecutorRequest(requestValue);
  if (!request.ok) return request;
  const bounded = validateJsonValue(policyValue);
  if (!bounded.ok) return bounded;
  const parsed = validateShape(gaapMappingPolicySchema, policyValue);
  if (!parsed.ok) return parsed;
  const { policy, policy_digest: digest } = parsed.value;
  const input = request.value.request;
  const parameters = input.parameters;
  if (
    executionDigest(policy) !== digest ||
    !same(input.mapping_policy, { id: policy.id, digest }) ||
    input.action_request.request.capability !== policy.action_capability ||
    !same(parameters.capability, policy.capability) ||
    !same(parameters.policies, policy.policies)
  )
    return invalid(
      'GAAP_MAPPING_MISMATCH',
      'Mapping policy must match the exact capability, supported policies, and immutable request.',
    );
  const families = input.action_request.request.evidence_requirements.map((requirement) => requirement.family);
  const mappingFamilies = policy.evidence_mapping.map((entry) => entry.family);
  if (
    new Set(mappingFamilies).size !== mappingFamilies.length ||
    families.some((family) => !mappingFamilies.includes(family))
  )
    return invalid('GAAP_EVIDENCE_MAPPING', 'Every required evidence family needs one explicit supported mapping.');
  const required = [
    ...new Set(
      policy.evidence_mapping
        .filter((entry) => families.includes(entry.family))
        .flatMap((entry) => entry.evidence_types),
    ),
  ].sort();
  if (!same(required, [...parameters.required_verification.evidence_types].sort()))
    return invalid(
      'GAAP_EVIDENCE_MAPPING',
      'Required verification types must exactly cover the selected evidence mappings.',
    );
  const prefix = <T extends { digest: string }>(identity: T): T => ({
    ...identity,
    digest: 'sha256:' + identity.digest,
  });
  const runIdentity = executionDigest({
    domain: 'threadloop.gaap-agent-run/0.1',
    request: requestReference(input.action_request),
    workflow_run_id: input.action_request.request.binding.workflow_run_id,
    claim: input.claim,
    attempt_id: input.attempt_id,
    executor: input.executor,
  });
  return validateGaapRequest({
    schema_version: 'gaap.agent-run-request/0.1.0',
    request_id: 'threadloop_request_' + request.value.request_digest,
    run_id: 'threadloop_attempt_' + runIdentity,
    subject: {
      kind: input.action_request.request.binding.subject.kind,
      locator: parameters.subject_locator,
      digest: 'sha256:' + input.action_request.request.binding.subject.content_digest,
    },
    requested_capability: prefix(parameters.capability),
    task: parameters.task,
    policies: parameters.policies.map(prefix),
    resource_budget: parameters.resource_budget,
    approval_context: parameters.approval_context.map((approval) => ({
      ...approval,
      subject_digest: 'sha256:' + approval.subject_digest,
      evidence: prefix(approval.evidence),
    })),
    required_verification: parameters.required_verification,
  });
}

export function mapGaapResult(
  requestValue: unknown,
  policy: unknown,
  bytes: Uint8Array,
  observationValue: unknown,
): ValidationResult<ExecutorResult> {
  const request = validateExecutorRequest(requestValue);
  if (!request.ok) return request;
  const mapped = buildGaapRequest(request.value, policy);
  if (!mapped.ok) return mapped;
  const parsed = parseExecutorMessage(bytes);
  if (!parsed.ok) return parsed;
  const validated = validateGaapReceipt(parsed.value, mapped.value);
  if (!validated.ok) return validated;
  const bounded = validateJsonValue(observationValue);
  if (!bounded.ok) return bounded;
  const observation = validateShape(resultObservationSchema, observationValue);
  if (!observation.ok) return observation;
  const { body, receipt_digest: sourceDigest } = validated.value;
  const input = request.value.request;
  const initial = input.action_request.request.binding.subject;
  const resulting = observation.value.resulting_subject;
  if (
    'sha256:' + resulting.content_digest !== body.resulting_subject_digest ||
    resulting.kind !== initial.kind ||
    (initial.kind === 'repository' &&
      resulting.kind === 'repository' &&
      initial.repository_id !== resulting.repository_id) ||
    (initial.kind === 'artifact' && resulting.kind === 'artifact' && initial.artifact_id !== resulting.artifact_id) ||
    (body.initial_subject_digest === body.resulting_subject_digest && !same(resulting, initial))
  )
    return invalid(
      'GAAP_RESULT_SUBJECT_MISMATCH',
      'Result observation must identify the exact resulting subject and original repository or artifact.',
    );
  const evidence: Evidence[] = [];
  const effects: ExecutorResult['result']['effects'] = [];
  const verification: ExecutorResult['result']['verification'] = [];
  const convert = (entry: Evidence): Evidence => ({ ...entry, digest: entry.digest.slice(7) });
  for (const event of body.events) {
    switch (event.event_type) {
      case 'mutation':
        effects.push({
          effect_digest: event.protected_effect_digest.slice(7),
          before_subject_digest: event.before_subject_digest.slice(7),
          after_subject_digest: event.after_subject_digest.slice(7),
          evidence: event.evidence.map(convert),
        });
        evidence.push(...event.evidence.map(convert));
        break;
      case 'verification':
        verification.push({
          actor_id: event.verifier_id,
          subject_digest: event.subject_digest.slice(7),
          verdict: event.verdict,
          evidence: event.evidence.map(convert),
        });
        evidence.push(...event.evidence.map(convert));
        break;
      case 'tool_execution':
        evidence.push(...event.evidence.map(convert));
        break;
      case 'approval_recorded':
        evidence.push(convert(event.approval.evidence));
        break;
      case 'interruption':
        evidence.push(convert(event.evidence));
        break;
      case 'status_transition':
      case 'plan_recorded':
      case 'protected_effect_decision':
      case 'usage':
        break;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  }
  let status: ExecutorResult['result']['attempt_receipt']['receipt']['status'];
  let reason: ExecutorResult['result']['reason']['code'];
  switch (body.terminal_status) {
    case 'completed':
      status = 'succeeded';
      reason = 'completed';
      break;
    case 'failed':
      status = 'failed';
      reason = 'failed';
      break;
    case 'interrupted':
      status = 'interrupted';
      reason = 'interrupted';
      break;
    case 'blocked': {
      status = 'blocked';
      const lastDecision = body.events.filter((event) => event.event_type === 'protected_effect_decision').at(-1);
      reason =
        body.terminal_reason === 'runtime.hard_stop'
          ? 'budget_exhausted'
          : lastDecision?.decision.outcome === 'ask' &&
              ['authority.required', lastDecision.decision.code].includes(body.terminal_reason)
            ? 'authority_required'
            : lastDecision?.decision.outcome === 'block' && body.terminal_reason === lastDecision.decision.code
              ? 'effect_denied'
              : 'blocked';
      break;
    }
    default:
      return invalid('GAAP_NONTERMINAL_RESULT', 'A one-shot result must be terminal.');
  }
  const receipt: ExecutorResult['result']['attempt_receipt']['receipt'] = {
    schema_version: '0.1',
    id: 'gaap_' + sourceDigest.slice(7),
    request: requestReference(input.action_request),
    binding: input.action_request.request.binding,
    execution_policy: input.execution_policy,
    claim: input.claim,
    attempt_id: input.attempt_id,
    executor: input.executor,
    status,
    effect: status === 'succeeded' ? (effects.length > 0 ? 'occurred' : 'none') : 'unknown',
    resulting_subject: resulting,
    finished_at: observation.value.finished_at,
    evidence: [
      { id: body.run_id, digest: sourceDigest.slice(7) },
      ...evidence.map((entry, index) => ({ id: 'evidence_' + index, digest: entry.digest })),
    ],
  };
  const result: ExecutorResult['result'] = {
    schema_version: 'threadloop.executor/0.1',
    kind: 'result',
    request_digest: request.value.request_digest,
    attempt_receipt: { receipt, receipt_digest: executionDigest(receipt) },
    source_receipt: { type: 'terminal_run_receipt', id: body.run_id, digest: sourceDigest.slice(7) },
    effects,
    verification,
    evidence,
    usage: body.usage,
    reason: { code: reason, message: body.terminal_reason },
  };
  // Return detached JSON; shared references from the inputs must not escape or imply trust.
  return validateExecutorResult(
    JSON.parse(JSON.stringify({ result, result_digest: executionDigest(result) })) as unknown,
    request.value,
  );
}
