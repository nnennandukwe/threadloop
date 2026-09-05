import { supportsGuard } from './guards.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { controllerDecisionSchema, type ControllerDecision, type ControllerInput } from './contracts.js';
import { validateShape, type Diagnostic, type ValidationResult } from '../workflow-graph/contracts.js';
import {
  currentObservation,
  currentReceipt,
  expired,
  issue,
  same,
  validateControllerInput,
  validateRequestInSnapshot,
} from './validation.js';

/** Checks a supplied candidate. Success is contract consistency, never execution authority. */
export function validateControllerDecision(
  snapshot: unknown,
  candidate: unknown,
): ValidationResult<ControllerDecision> {
  const input = validateControllerInput(snapshot);
  if (!input.ok) return input;
  const parsed = validateShape(controllerDecisionSchema, candidate);
  if (!parsed.ok) return parsed;
  const value = input.value;
  const decision = parsed.value.decision;
  const errors: Diagnostic[] = [];
  const reject = (code: string, path: string, message: string) => errors.push(issue(code, path, message));
  if (!same(decision.binding, value.binding) || decision.input_digest !== sha256(canonicalJson(value)))
    reject(
      'DECISION_BINDING_MISMATCH',
      '$.decision',
      'The decision must bind the entire canonical input snapshot and its run binding.',
    );
  if (parsed.value.decision_digest !== sha256(canonicalJson(decision)))
    reject('DECISION_DIGEST_MISMATCH', '$.decision_digest', 'The decision contents differ from the claimed digest.');
  const state = value.compiled_graph.graph.states.find((state) => state.id === value.binding.source_state)!;
  if (decision.outcome === 'terminal') {
    if (state.kind !== 'terminal' || decision.terminal_state !== state.id || value.execution.status !== 'idle')
      reject(
        'NOT_TERMINAL',
        '$.decision.terminal_state',
        'Only an already terminal run with no unresolved execution can report terminal.',
      );
  } else if (decision.outcome !== 'blocked') {
    if (state.kind === 'terminal')
      reject(
        'TERMINAL_RUN',
        '$.decision.outcome',
        'A terminal run cannot request work, wait, or offer another transition.',
      );
    if (!currentObservation(value))
      reject('STALE_OBSERVATION', '$.observation', 'Refresh the observation before using an actionable decision.');
    if (value.history.status !== 'verified')
      reject('INVALID_HISTORY', '$.history', 'Restore verified history before considering work or advancement.');
    if (decision.outcome === 'waiting') {
      const execution = value.execution;
      if (
        execution.status !== 'in_flight' ||
        expired(execution.claim.valid_until, value) ||
        expired(execution.request.request.constraints.valid_until, value) ||
        value.invalidated_claims.some(
          (claim) => claim.id === execution.claim.id && claim.version === execution.claim.version,
        ) ||
        !same(execution.request.request.binding, value.binding) ||
        !same(execution.request.request.policy, { id: value.policy.id, digest: value.policy.digest }) ||
        !same(decision.request, {
          idempotency_key: execution.request.request.idempotency_key,
          request_digest: execution.request.request_digest,
        }) ||
        !same(decision.claim, { id: execution.claim.id, version: execution.claim.version }) ||
        decision.attempt_id !== execution.attempt.id
      )
        reject('INVALID_WAIT', '$.decision', 'Waiting must reference matching, current, unexpired execution.');
    } else if (decision.outcome === 'engineering_action_required' || decision.outcome === 'human_action_required') {
      const request = validateRequestInSnapshot(value, decision.action_request);
      if (!request.ok) errors.push(...request.diagnostics);
    } else {
      if (value.execution.status !== 'idle')
        reject('EXECUTION_NOT_IDLE', '$.execution', 'Execution must be reconciled before lifecycle advancement.');
      errors.push(...validateTransition(value, decision));
    }
  }
  return errors.length ? { ok: false, diagnostics: errors } : parsed;
}

type TransitionDecision = Extract<ControllerDecision['decision'], { outcome: 'transition_available' }>;

function validateTransition(input: ControllerInput, decision: TransitionDecision): Diagnostic[] {
  const graph = input.compiled_graph.graph;
  const edge = graph.transitions.find(
    (edge) =>
      edge.id === decision.transition_id &&
      edge.from === input.binding.source_state &&
      edge.to === decision.target_state,
  );
  if (!edge)
    return [
      issue(
        'TRANSITION_BINDING_MISMATCH',
        '$.decision.transition_id',
        'The selected transition must connect the declared source and target states.',
      ),
    ];
  const errors: Diagnostic[] = [];
  if (!same([...edge.guard_refs].sort(), decision.checks.map((check) => check.guard_id).sort()))
    errors.push(
      issue(
        'GUARD_COVERAGE_MISMATCH',
        '$.decision.checks',
        'Supply exactly one check for every guard on the transition.',
      ),
    );
  if (!edge.authority.every((type) => input.policy.rules.authorities.some((authority) => authority.type === type)))
    errors.push(
      issue(
        'AUTHORITY_UNAVAILABLE',
        '$.policy.rules.authorities',
        'Every transition authority must have an explicit identity.',
      ),
    );
  for (const check of decision.checks) {
    const guard = graph.guards.find((guard) => guard.id === check.guard_id);
    const receipts = input.receipts.filter((receipt) => check.evidence_ids.includes(receipt.id));
    if (
      new Set(check.evidence_ids).size !== check.evidence_ids.length ||
      receipts.length !== check.evidence_ids.length ||
      receipts.some((receipt) => !currentReceipt(receipt, input))
    )
      errors.push(
        issue(
          'STALE_OR_MISSING_EVIDENCE',
          '$.decision.checks',
          'Every referenced receipt must be current, intact, unexpired, and unfenced.',
        ),
      );
    if (guard && !supportsGuard(input, guard, receipts))
      errors.push(
        issue('GUARD_EVIDENCE_MISMATCH', '$.decision.checks', `Explicit facts do not support guard ${guard.id}.`),
      );
  }
  return errors;
}
