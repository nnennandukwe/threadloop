import { canonicalJson } from '../../src/domain/canonical-json.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { actionRequestSchema, controllerInputSchema, type ActionRequest, type ControllerInput } from './contracts.js';
import { diagnostic, validateShape, type Diagnostic, type ValidationResult } from '../workflow-graph/contracts.js';
import { validateGraphBinding } from '../workflow-graph/compiler.js';
import { supportsGuard } from './guards.js';

export function validateControllerInput(input: unknown): ValidationResult<ControllerInput> {
  const parsed = validateShape(controllerInputSchema, input);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  const graph = validateGraphBinding(
    { graph_schema_version: value.binding.graph_schema_version, graph_digest: value.binding.graph_digest },
    value.compiled_graph,
  );
  if (!graph.ok) return graph;
  const errors: Diagnostic[] = [];
  const reject = (code: string, path: string, message: string) => errors.push(issue(code, path, message));
  const state = graph.value.graph.states.find((state) => state.id === value.binding.source_state);
  if (!state) reject('UNKNOWN_STATE', '$.binding.source_state', 'The source state is not declared by the bound graph.');
  if (value.policy.digest !== sha256(canonicalJson(value.policy.rules)))
    reject('POLICY_DIGEST_MISMATCH', '$.policy', 'Policy contents differ from their claimed digest.');
  for (const family of ['local_proof', 'independent_proof'] as const) {
    const required = graph.value.graph.guards.some(
      (guard) =>
        guard.capability === family ||
        (guard.capability === 'review' && guard.parameters.condition === 'proof_set_current'),
    );
    const gates =
      family === 'local_proof' ? value.policy.rules.local_gate_ids : value.policy.rules.independent_gate_ids;
    if (required && gates.length === 0)
      reject('INVALID_PROOF_POLICY', '$.policy.rules', `The graph requires a nonempty ${family} gate configuration.`);
  }
  if ((value.binding.subject.kind === 'repository') !== (value.observation.repository !== null))
    reject(
      'OBSERVATION_KIND_MISMATCH',
      '$.observation',
      'Repository subjects require repository facts; artifacts do not accept them.',
    );
  const sets: [string, string[]][] = [
    ['receipts', value.receipts.map((item) => item.id)],
    ['receipt_sequences', value.receipts.map((item) => String(item.sequence))],
    ['local_gate_ids', value.policy.rules.local_gate_ids],
    ['independent_gate_ids', value.policy.rules.independent_gate_ids],
    ['evidence_policies', value.policy.rules.evidence_policies.map((item) => item.id)],
    ['authorities', value.policy.rules.authorities.map((item) => item.type + ':' + item.identity.id)],
    ['available_capabilities', value.available_capabilities.map(canonicalJson)],
    ['invalidated_claims', value.invalidated_claims.map(canonicalJson)],
    ['existing_requests', value.existing_requests.map((item) => item.idempotency_key)],
  ];
  if (value.history.status === 'verified') {
    const history = value.history;
    const budgets = graph.value.graph.budgets.map((item) => item.id).sort();
    if (!same(budgets, history.budget_counts.map((item) => item.budget_id).sort()))
      reject('INVALID_HISTORY', '$.history.budget_counts', 'Supply one count for each declared budget.');
    if ((graph.value.graph.phase_policy !== null) !== (history.phase !== null))
      reject('INVALID_HISTORY', '$.history.phase', 'Phase projection must agree with the graph phase policy.');
    if (
      history.prior_state !== null &&
      !graph.value.graph.states.some((item) => item.id === history.prior_state && item.kind === 'active')
    )
      reject('INVALID_HISTORY', '$.history.prior_state', 'Prior state must name an active state.');
    if (state?.kind === 'suspended' && history.prior_state === null)
      reject('INVALID_HISTORY', '$.history.prior_state', 'Suspension requires the recorded prior state.');
  }
  const times: (string | null)[] = [value.evaluation_time, value.observation.valid_until];
  for (const receipt of value.receipts) {
    times.push(receipt.valid_until);
    if (
      receipt.workflow_run_id !== value.binding.workflow_run_id ||
      receipt.graph_digest !== value.binding.graph_digest ||
      receipt.source_state_version > value.binding.state_version
    )
      reject(
        'RECEIPT_BINDING_MISMATCH',
        '$.receipts',
        `Receipt ${receipt.id} belongs to another run, graph, or future state version.`,
      );
    if (!value.policy.rules.evidence_policies.some((policy) => same(policy, receipt.policy)))
      reject(
        'UNTRUSTED_EVIDENCE_POLICY',
        '$.receipts',
        `Receipt ${receipt.id} uses an unaccepted verification policy.`,
      );
    if (sha256(canonicalJson(receipt.payload)) !== receipt.payload_digest)
      reject('RECEIPT_DIGEST_MISMATCH', '$.receipts', `Receipt ${receipt.id} payload does not match its digest.`);
    if ('findings' in receipt.payload)
      sets.push([`receipts.${receipt.id}.findings`, receipt.payload.findings.map((finding) => finding.id)]);
  }
  if (value.execution.status !== 'idle') {
    const request = value.execution.request;
    errors.push(...validateRequestStructure(value, request));
    if (
      request.request.actor !== 'executor' ||
      request.request.binding.workflow_run_id !== value.binding.workflow_run_id ||
      request.request.binding.graph_digest !== value.binding.graph_digest
    )
      reject(
        'EXECUTION_BINDING_MISMATCH',
        '$.execution.request',
        'Execution must reference executor work in this run and graph.',
      );
    times.push(request.request.constraints.valid_until);
    if (value.execution.status === 'in_flight') times.push(value.execution.claim.valid_until);
  }
  for (const [path, entries] of sets)
    if (new Set(entries).size !== entries.length)
      reject('DUPLICATE_IDENTITY', '$.' + path, 'Duplicate identities make the snapshot ambiguous.');
  for (const time of times)
    if (time !== null && (!Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time))
      reject('INVALID_TIMESTAMP', '$.evaluation_time', 'Use a real UTC instant with exactly three fractional digits.');
  if (times.slice(1).some((time) => time !== null) && value.evaluation_time === null)
    reject('EVALUATION_TIME_REQUIRED', '$.evaluation_time', 'Validity deadlines require an explicit evaluation time.');
  return errors.length ? { ok: false, diagnostics: errors } : parsed;
}

export function issue(code: string, path: string, message: string): Diagnostic {
  return diagnostic(
    code,
    path,
    null,
    message,
    'Restore the matching snapshot, evidence, or contract document and validate again; do not execute this candidate.',
  );
}

export function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function requestIdentity(binding: ActionRequest['request']['binding'], actionId: string): string {
  return sha256(canonicalJson({ schema_version: '0.1', binding, action_id: actionId }));
}

export function expired(deadline: string | null, input: ControllerInput): boolean {
  return deadline !== null && (input.evaluation_time === null || input.evaluation_time >= deadline);
}

export function currentObservation(input: ControllerInput): boolean {
  return (
    input.observation.status === 'verified' &&
    same(input.binding.subject, input.observation.subject) &&
    input.observation.state_version === input.binding.state_version &&
    !expired(input.observation.valid_until, input)
  );
}

function evidenceStream(receipt: ControllerInput['receipts'][number]): string {
  const payload = receipt.payload;
  return canonicalJson({
    workflow_policy: receipt.workflow_policy,
    type: payload.type,
    gate: 'gate_id' in payload ? payload.gate_id : null,
    stage: 'stage' in payload ? payload.stage : null,
    scope: 'scope' in payload ? payload.scope : null,
    kind: 'kind' in payload ? payload.kind : null,
    prior_state: 'prior_state' in payload ? payload.prior_state : null,
    destination: 'destination' in payload ? payload.destination : null,
    approver: 'approver' in payload ? payload.approver : null,
  });
}

export function currentReceipt(receipt: ControllerInput['receipts'][number], input: ControllerInput): boolean {
  return (
    same(receipt.subject, input.binding.subject) &&
    !expired(receipt.valid_until, input) &&
    same(receipt.workflow_policy, { id: input.policy.id, digest: input.policy.digest }) &&
    !(
      receipt.origin.kind === 'attempt' &&
      input.invalidated_claims.some((claim) =>
        same(claim, receipt.origin.kind === 'attempt' ? receipt.origin.claim : null),
      )
    ) &&
    !input.receipts.some(
      (other) =>
        other.sequence > receipt.sequence &&
        same(other.subject, receipt.subject) &&
        evidenceStream(other) === evidenceStream(receipt),
    )
  );
}

// Necessary type constraints, not a guard evaluator or an authorization grant.
const actionFamilies: Record<ActionRequest['request']['capability'], readonly string[]> = {
  frame_change: [],
  bind_proof_plan: ['proof_plan'],
  implement_change: ['repository_observation'],
  commit_change: ['repository_observation'],
  run_local_gates: ['local_proof'],
  obtain_independent_proof: ['independent_proof'],
  record_pre_pr_review: ['pre_pr_review'],
  obtain_review_evidence: ['review', 'completion_observed'],
  repair_change: ['repository_observation', 'review'],
  correct_gate_setup: ['local_proof'],
  restore_proof_authority: ['proof_plan'],
  restore_repository: ['repository_observation'],
  restore_evidence: ['local_proof', 'independent_proof', 'pre_pr_review', 'review'],
  prepare_release: ['artifact'],
  verify_release: ['artifact'],
  publish_release: ['completion_observed'],
  verify_publication: ['artifact'],
  block_run: ['block_evidence'],
  recover_run: ['human_approval'],
  approve_change: ['human_approval'],
  merge_change: ['completion_observed'],
};

export function guardFamilies(capability: string, parameters: object): readonly string[] {
  if (capability === 'repository') return ['repository_observation'];
  if (capability === 'proof_plan_bound') return ['proof_plan'];
  if (capability === 'recorded_prior_state') return ['human_approval'];
  if (capability === 'budget_available') return ['block_evidence'];
  if (capability === 'review' && 'condition' in parameters && parameters.condition === 'proof_set_current')
    return ['local_proof', 'independent_proof', 'review'];
  return [capability];
}

export function validateActionRequest(snapshot: unknown, request: unknown): ValidationResult<ActionRequest> {
  const input = validateControllerInput(snapshot);
  if (!input.ok) return input;
  const parsed = validateShape(actionRequestSchema, request);
  if (!parsed.ok) return parsed;
  return validateRequestInSnapshot(input.value, parsed.value);
}

function validateRequestStructure(input: ControllerInput, envelope: ActionRequest): Diagnostic[] {
  const request = envelope.request;
  const errors: Diagnostic[] = [];
  const reject = (code: string, path: string, message: string) => errors.push(issue(code, path, message));
  if (sha256(canonicalJson(request)) !== envelope.request_digest)
    reject('REQUEST_DIGEST_MISMATCH', '$.request_digest', 'Request contents do not match their digest.');
  if (request.idempotency_key !== requestIdentity(request.binding, request.action_id))
    reject(
      'IDEMPOTENCY_IDENTITY_MISMATCH',
      '$.request.idempotency_key',
      'Idempotency identity must identify this logical action slot.',
    );
  if (
    !request.authorities.some((authority) => authority.type === 'threadloop') ||
    (request.actor === 'human' && !request.authorities.some((authority) => authority.type === 'human'))
  )
    reject(
      'AUTHORITY_UNAVAILABLE',
      '$.request.authorities',
      'Required ThreadLoop or human authority identity is missing.',
    );
  if (
    request.constraints.valid_until !== null &&
    (!Number.isFinite(Date.parse(request.constraints.valid_until)) ||
      new Date(request.constraints.valid_until).toISOString() !== request.constraints.valid_until)
  )
    reject(
      'INVALID_TIMESTAMP',
      '$.request.constraints.valid_until',
      'Use a real UTC instant with exactly three fractional digits.',
    );
  const graph = input.compiled_graph.graph;
  const action = graph.required_actions.find((item) => item.id === request.action_id);
  if (!action || action.capability !== request.capability || action.authority !== request.actor)
    reject(
      'ACTION_BINDING_MISMATCH',
      '$.request.action_id',
      'Request actor and capability must match the graph action.',
    );
  const edge = graph.transitions.find(
    (edge) => edge.id === request.transition_id && edge.from === request.binding.source_state,
  );
  if (!edge)
    reject(
      'ACTION_TRANSITION_MISMATCH',
      '$.request.transition_id',
      'The selected transition must leave the request source state.',
    );
  for (const guardId of request.guard_ids) {
    const guard = graph.guards.find((guard) => guard.id === guardId);
    if (!guard || !edge?.guard_refs.includes(guardId) || !guard.required_actions.includes(request.action_id))
      reject(
        'ACTION_GUARD_MISMATCH',
        '$.request.guard_ids',
        'Each remedy must be declared by a guard of the selected transition.',
      );
  }
  for (const requirement of request.evidence_requirements) {
    const guard = graph.guards.find((guard) => guard.id === requirement.guard_id);
    if (
      !same(requirement.subject, request.binding.subject) ||
      !request.guard_ids.includes(requirement.guard_id) ||
      !guard ||
      !guardFamilies(guard.capability, guard.parameters).includes(requirement.family) ||
      !actionFamilies[request.capability].includes(requirement.family)
    )
      reject(
        'EVIDENCE_REQUIREMENT_MISMATCH',
        '$.request.evidence_requirements',
        'Evidence requirements must match the subject, selected guards, and action capability.',
      );
  }
  if (request.guard_ids.some((id) => !request.evidence_requirements.some((requirement) => requirement.guard_id === id)))
    reject(
      'MISSING_EVIDENCE_REQUIREMENT',
      '$.request.evidence_requirements',
      'Every remedied guard needs an explicit evidence requirement.',
    );
  for (const [path, values] of [
    ['guard_ids', request.guard_ids],
    ['evidence_ids', request.evidence_ids],
    ['inputs', request.inputs.map((item) => item.role)],
    ['evidence_requirements', request.evidence_requirements.map(canonicalJson)],
  ] as const) {
    if (new Set(values).size !== values.length)
      reject('DUPLICATE_IDENTITY', '$.request.' + path, 'A request cannot contain duplicate references.');
    if (!same(values, [...values].sort()))
      reject(
        'NON_CANONICAL_REQUEST',
        '$.request.' + path,
        'Request reference arrays must use the documented canonical order.',
      );
  }
  return errors;
}

export function validateRequestInSnapshot(
  input: ControllerInput,
  envelope: ActionRequest,
  mode: 'new' | 'in_flight' = 'new',
): ValidationResult<ActionRequest> {
  const request = envelope.request;
  const errors = validateRequestStructure(input, envelope);
  const reject = (code: string, path: string, message: string) => errors.push(issue(code, path, message));
  if (!same(request.binding, input.binding))
    reject(
      'REQUEST_BINDING_MISMATCH',
      '$.request.binding',
      'Request must bind the exact current run, state version, graph, and subject.',
    );
  if (
    !same(request.policy, { id: input.policy.id, digest: input.policy.digest }) ||
    !same(request.authorities, input.policy.rules.authorities)
  )
    reject(
      'POLICY_BINDING_MISMATCH',
      '$.request.policy',
      'Request must retain the exact policy and authority identities.',
    );
  if (!actionPrerequisites(input, request))
    reject(
      'ACTION_PREREQUISITE_MISSING',
      '$.request.evidence_ids',
      'Supply current prerequisite evidence and facts for this action; an executor must not choose a workaround.',
    );
  if (!currentObservation(input))
    reject(
      'STALE_OBSERVATION',
      '$.observation',
      'Obtain a current verified subject observation before constructing a request.',
    );
  if (input.history.status !== 'verified')
    reject('INVALID_HISTORY', '$.history', 'Requests require a verified history projection.');
  if (mode === 'new' && input.execution.status !== 'idle')
    reject(
      'EXECUTION_NOT_IDLE',
      '$.execution',
      'Wait for current execution or reconcile its outcome before requesting work.',
    );
  if (expired(request.constraints.valid_until, input))
    reject('REQUEST_EXPIRED', '$.request.constraints.valid_until', 'The request validity interval has ended.');
  if (
    !input.available_capabilities.some((item) => item.capability === request.capability && item.actor === request.actor)
  )
    reject(
      'UNSUPPORTED_CAPABILITY',
      '$.available_capabilities',
      'This actor capability is unavailable; do not substitute an executor or human.',
    );
  const deadlines = [input.observation.valid_until];
  for (const id of request.evidence_ids) {
    const receipt = input.receipts.find((receipt) => receipt.id === id);
    if (!receipt || !currentReceipt(receipt, input))
      reject(
        'STALE_OR_MISSING_EVIDENCE',
        '$.request.evidence_ids',
        `Receipt ${id} is missing, stale, superseded, expired, or from an invalidated claim.`,
      );
    if (receipt) deadlines.push(receipt.valid_until);
  }
  if (
    deadlines.some(
      (deadline) =>
        deadline !== null && (request.constraints.valid_until === null || request.constraints.valid_until > deadline),
    )
  )
    reject(
      'VALIDITY_WIDENED',
      '$.request.constraints.valid_until',
      'Request validity must not exceed its observation or supporting evidence.',
    );
  for (const artifact of request.inputs)
    if (artifact.role === 'proof_plan' && !same(artifact.artifact, input.policy.rules.proof_plan))
      reject('PROOF_PLAN_MISMATCH', '$.request.inputs', 'Use the immutable proof plan from the explicit policy.');
  if (
    ['run_local_gates', 'obtain_independent_proof'].includes(request.capability) &&
    !request.inputs.some((item) => item.role === 'proof_plan' && same(item.artifact, input.policy.rules.proof_plan))
  )
    reject('PROOF_PLAN_REQUIRED', '$.request.inputs', 'Proof collection requires the bound proof plan input.');
  for (const existing of input.existing_requests)
    if (existing.idempotency_key === request.idempotency_key && existing.request_digest !== envelope.request_digest)
      reject(
        'IDEMPOTENCY_CONFLICT',
        '$.existing_requests',
        'The same logical action identity already binds different request contents.',
      );
  return errors.length ? { ok: false, diagnostics: errors } : { ok: true, value: envelope };
}

function actionPrerequisites(input: ControllerInput, request: ActionRequest['request']): boolean {
  const receipts = input.receipts.filter(
    (receipt) => request.evidence_ids.includes(receipt.id) && currentReceipt(receipt, input),
  );
  const local = () =>
    supportsGuard(
      input,
      { id: 'prerequisite', capability: 'local_proof', parameters: { result: 'passed' }, required_actions: [] },
      receipts,
    );
  const independent = () =>
    supportsGuard(
      input,
      { id: 'prerequisite', capability: 'independent_proof', parameters: {}, required_actions: [] },
      receipts,
    );
  const approval = () =>
    supportsGuard(
      input,
      {
        id: 'prerequisite',
        capability: 'human_approval',
        parameters: { scope: 'current_subject' },
        required_actions: [],
      },
      receipts,
    );
  const clearReview = () =>
    supportsGuard(
      input,
      { id: 'prerequisite', capability: 'review', parameters: { condition: 'clear' }, required_actions: [] },
      receipts,
    );
  const releaseVerified = () =>
    supportsGuard(
      input,
      {
        id: 'prerequisite',
        capability: 'artifact',
        parameters: { stage: 'release_verified', result: 'passed' },
        required_actions: [],
      },
      receipts,
    );
  switch (request.capability) {
    case 'run_local_gates':
      return (
        input.policy.rules.local_gate_ids.length > 0 &&
        supportsGuard(
          input,
          {
            id: 'prerequisite',
            capability: 'repository',
            parameters: { condition: 'clean_plan_branch' },
            required_actions: [],
          },
          receipts,
        )
      );
    case 'obtain_independent_proof':
      return local();
    case 'record_pre_pr_review':
    case 'obtain_review_evidence':
      return local() && independent();
    case 'approve_change':
      return input.binding.subject.kind === 'repository'
        ? local() && independent() && clearReview()
        : releaseVerified();
    case 'merge_change':
      return input.binding.subject.kind === 'repository' && local() && independent() && clearReview() && approval();
    case 'publish_release':
      return (
        input.binding.subject.kind === 'artifact' &&
        input.policy.rules.publication_destination !== null &&
        releaseVerified() &&
        approval()
      );
    case 'correct_gate_setup':
      return receipts.some(
        (receipt) => receipt.payload.type === 'local_proof' && receipt.payload.result === 'setup_failed',
      );
    case 'repair_change': {
      const failure = receipts.some(
        (receipt) =>
          (receipt.payload.type === 'local_proof' && receipt.payload.result === 'failed') ||
          (receipt.payload.type === 'review' &&
            (receipt.payload.outcome === 'changes_required' ||
              receipt.payload.findings.some((finding) => finding.blocking && !finding.outdated))),
      );
      const setupFailed = receipts.some(
        (receipt) => receipt.payload.type === 'local_proof' && receipt.payload.result === 'setup_failed',
      );
      const history = input.history;
      const admitted =
        history.status === 'verified' &&
        input.compiled_graph.graph.budgets.some((budget) => {
          const used = history.budget_counts.find((count) => count.budget_id === budget.id)?.used ?? 0;
          return (
            used > 0 &&
            used <= budget.limit &&
            input.compiled_graph.graph.transitions.some(
              (edge) => budget.transition_refs.includes(edge.id) && edge.to === input.binding.source_state,
            )
          );
        });
      return failure && !setupFailed && admitted;
    }
    default:
      return true;
  }
}
