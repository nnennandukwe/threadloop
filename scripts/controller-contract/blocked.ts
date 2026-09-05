import type { ControllerDecision, ControllerInput } from './contracts.js';
import type { Diagnostic } from '../workflow-graph/contracts.js';
import { currentObservation, currentReceipt, expired, issue, validateRequestInSnapshot } from './validation.js';

type Reason = Extract<ControllerDecision['decision'], { outcome: 'blocked' }>['reasons'][number];

/** Checks the supplied reason's facts, without searching for a preferred alternative decision. */
export function validateBlockedReasons(input: ControllerInput, reasons: Reason[]): Diagnostic[] {
  return reasons.flatMap((reason, index) => {
    const path = `$.decision.reasons[${index}]`;
    if (reason.code === 'AMBIGUOUS_REMEDY' || reason.code === 'NO_APPLICABLE_REMEDY')
      return [
        issue(
          'SELECTION_PROOF_REQUIRED',
          path,
          'This reason requires exhaustive selector proof, which the candidate validator does not provide.',
        ),
      ];
    return supportedReason(input, reason)
      ? []
      : [issue('BLOCKED_REASON_MISMATCH', path, `The snapshot does not establish ${reason.code}.`)];
  });
}

function supportedReason(input: ControllerInput, reason: Reason): boolean {
  const execution = input.execution;
  const graph = input.compiled_graph.graph;
  const edges = graph.transitions.filter((edge) => edge.from === input.binding.source_state);
  const guards = graph.guards.filter((guard) => edges.some((edge) => edge.guard_refs.includes(guard.id)));
  switch (reason.code) {
    case 'STALE_OBSERVATION':
      return !currentObservation(input);
    case 'INVALID_HISTORY':
      return input.history.status !== 'verified';
    case 'CLAIM_EXPIRED':
      return execution.status === 'in_flight' && expired(execution.claim.valid_until, input);
    case 'EXECUTION_RECONCILIATION_REQUIRED':
      return (
        execution.status === 'reconciliation_required' ||
        (execution.status === 'in_flight' &&
          (expired(execution.claim.valid_until, input) ||
            input.invalidated_claims.some(
              (claim) => claim.id === execution.claim.id && claim.version === execution.claim.version,
            ) ||
            !validateRequestInSnapshot(input, execution.request, 'in_flight').ok))
      );
    case 'UNSUPPORTED_CAPABILITY': {
      const action = graph.required_actions.find((action) => action.id === reason.action_id);
      return (
        action !== undefined &&
        guards.some((guard) => guard.required_actions.includes(action.id)) &&
        !input.available_capabilities.some(
          (available) => available.capability === action.capability && available.actor === action.authority,
        )
      );
    }
    case 'IDEMPOTENCY_CONFLICT': {
      const result = validateRequestInSnapshot(input, reason.request);
      return !result.ok && result.diagnostics.every((diagnostic) => diagnostic.code === 'IDEMPOTENCY_CONFLICT');
    }
    case 'AUTHORITY_UNAVAILABLE': {
      const edge = edges.find((edge) => edge.id === reason.transition_id);
      return (
        edge !== undefined &&
        edge.authority.some((type) => !input.policy.rules.authorities.some((authority) => authority.type === type))
      );
    }
    case 'EVIDENCE_UNAVAILABLE': {
      const guard = guards.find((guard) => guard.id === reason.guard_id);
      return (
        guard !== undefined &&
        currentObservation(input) &&
        input.history.status === 'verified' &&
        missingEvidence(input, guard)
      );
    }
    default:
      return false;
  }
}

function missingEvidence(
  input: ControllerInput,
  guard: ControllerInput['compiled_graph']['graph']['guards'][number],
): boolean {
  const payloads = input.receipts.filter((receipt) => currentReceipt(receipt, input)).map((receipt) => receipt.payload);
  const missingLocal = () =>
    input.policy.rules.local_gate_ids.some(
      (gate) => !payloads.some((payload) => payload.type === 'local_proof' && payload.gate_id === gate),
    );
  const missingIndependent = () =>
    input.policy.rules.independent_gate_ids.some(
      (gate) => !payloads.some((payload) => payload.type === 'independent_proof' && payload.gate_id === gate),
    );
  switch (guard.capability) {
    case 'local_proof':
      return missingLocal();
    case 'independent_proof':
      return missingIndependent();
    case 'review':
      return (
        !payloads.some((payload) => payload.type === 'review') ||
        (guard.parameters.condition === 'proof_set_current' && (missingLocal() || missingIndependent()))
      );
    case 'human_approval':
      return !payloads.some(
        (payload) =>
          payload.type === 'human_approval' &&
          payload.scope === guard.parameters.scope &&
          input.policy.rules.authorities.some(
            (authority) => authority.type === 'human' && authority.identity.id === payload.approver.id,
          ),
      );
    case 'completion_observed':
      return !payloads.some(
        (payload) =>
          payload.type === 'completion_observed' &&
          payload.kind === guard.parameters.kind &&
          (payload.kind !== 'publication' || payload.destination === input.policy.rules.publication_destination),
      );
    case 'artifact':
      return !payloads.some((payload) => payload.type === 'artifact' && payload.stage === guard.parameters.stage);
    case 'pre_pr_review':
    case 'block_evidence':
    case 'stop_requested':
      return !payloads.some((payload) => payload.type === guard.capability);
    default:
      return false;
  }
}
