import {
  validateControllerInput,
  validateRequestInSnapshot,
  type ControllerInput,
  type ControllerDecision,
} from 'threadloop-contracts/controller';
import type { ValidationResult } from 'threadloop-contracts/workflow';
import { workflowDigest, type WorkflowReason } from './workflow-selection-types.js';
import { canonicalJson } from './canonical-json.js';

import { currentWorkflowReceipts, evaluateWorkflowRoutes } from './workflow-guard-facts.js';
import { chooseWorkflowRemedy } from './workflow-remedies.js';
import { buildSelectedWorkflowRequest } from './workflow-action-request.js';

type WithoutBinding<T> = T extends unknown ? Omit<T, 'schema_version' | 'input_digest' | 'binding'> : never;
type Outcome = WithoutBinding<ControllerDecision['decision']>;

function decision(input: ControllerInput, outcome: Outcome): ValidationResult<ControllerDecision> {
  const payload: ControllerDecision['decision'] = {
    schema_version: '0.1',
    input_digest: workflowDigest(input),
    binding: input.binding,
    ...outcome,
  };
  return { ok: true, value: { decision: payload, decision_digest: workflowDigest(payload) } };
}

function hasExpired(input: ControllerInput, deadline: string | null) {
  return deadline !== null && input.evaluation_time !== null && input.evaluation_time >= deadline;
}

function missingFacts(input: ControllerInput): WorkflowReason | undefined {
  const observed = input.observation;
  if (
    observed.status !== 'verified' ||
    observed.state_version !== input.binding.state_version ||
    canonicalJson(observed.subject) !== canonicalJson(input.binding.subject) ||
    hasExpired(input, observed.valid_until)
  ) {
    return {
      code: 'STALE_OBSERVATION',
      message: 'The observation is unavailable, expired, or bound to different run facts.',
      recovery: 'Refresh the observation for this subject and state version.',
    };
  }
  if (input.history.status !== 'verified') {
    return {
      code: 'INVALID_HISTORY',
      message: input.history.reason,
      recovery: 'Restore and verify the run history before evaluating another decision.',
    };
  }
  return undefined;
}

function outstandingExecution(input: ControllerInput): Outcome | undefined {
  const execution = input.execution;
  if (execution.status === 'idle') return;
  const reconcile: WorkflowReason = {
    code: 'EXECUTION_RECONCILIATION_REQUIRED',
    message: 'The outstanding execution needs reconciliation.',
    recovery: 'Inspect the retained request, claim and Attempt and reconcile their effect before dispatching work.',
  };
  const block = (reason: WorkflowReason): Outcome => ({ outcome: 'blocked', reasons: [reason] });
  if (execution.status === 'reconciliation_required') return block(reconcile);
  if (hasExpired(input, execution.claim.valid_until)) {
    return block({
      code: 'CLAIM_EXPIRED',
      message: 'The current execution claim has expired.',
      recovery: 'Reconcile the existing claim and Attempt before acquiring another claim.',
    });
  }
  const request = execution.request.request;
  if (
    input.invalidated_claims.some(
      (claim) => claim.id === execution.claim.id && claim.version === execution.claim.version,
    )
  ) {
    return block(reconcile);
  }
  const checked = validateRequestInSnapshot(input, execution.request, 'in_flight');
  if (!checked.ok) {
    // Missing observations and history can also make a request prerequisite unprovable.
    // An independent change to the outstanding request still needs reconciliation first.
    const missing = missingFacts(input);
    const dependsOnFacts = checked.diagnostics.every(
      ({ code }) =>
        code === 'STALE_OBSERVATION' || code === 'INVALID_HISTORY' || code === 'ACTION_PREREQUISITE_MISSING',
    );
    return block(missing && dependsOnFacts ? missing : reconcile);
  }
  return {
    outcome: 'waiting',
    request: { idempotency_key: request.idempotency_key, request_digest: execution.request.request_digest },
    claim: { id: execution.claim.id, version: execution.claim.version },
    attempt_id: execution.attempt.id,
  };
}

export function selectWorkflowDecision(snapshot: unknown): ValidationResult<ControllerDecision> {
  const validated = validateControllerInput(snapshot);
  if (!validated.ok) return validated;
  const input = validated.value;
  const outstanding = outstandingExecution(input);
  if (outstanding) return decision(input, outstanding);
  const state = input.compiled_graph.graph.states.find((entry) => entry.id === input.binding.source_state)!;
  if (state.kind === 'terminal') {
    return decision(input, { outcome: 'terminal', terminal_state: state.id });
  }
  const missing = missingFacts(input);
  if (missing) return decision(input, { outcome: 'blocked', reasons: [missing] });
  const receipts = currentWorkflowReceipts(input);
  const routes = evaluateWorkflowRoutes(input, receipts);
  const witnessed = routes
    .filter((route) => route.checks.every((check) => check.evidenceIds !== null))
    .sort((left, right) => left.edge.priority - right.edge.priority);
  const eligible = witnessed.find(({ edge }) =>
    edge.authority.every((type) => input.policy.rules.authorities.some((authority) => authority.type === type)),
  );
  if (eligible) {
    return decision(input, {
      outcome: 'transition_available',
      transition_id: eligible.edge.id,
      target_state: eligible.edge.to,
      checks: eligible.checks.map(({ guard, evidenceIds }) => ({ guard_id: guard.id, evidence_ids: evidenceIds! })),
    });
  }
  if (witnessed.length > 0) {
    const edge = witnessed[0]!.edge;
    return decision(input, {
      outcome: 'blocked',
      reasons: [
        {
          code: 'AUTHORITY_UNAVAILABLE',
          transition_id: edge.id,
          message: `Transition ${edge.id} lacks a required authority.`,
          recovery: 'Restore the required authority identity in the bound workflow policy.',
        },
      ],
    });
  }
  const choice = chooseWorkflowRemedy(input, receipts, routes);
  if (choice.kind === 'blocked') return decision(input, { outcome: 'blocked', reasons: choice.reasons });
  // A conflicting slot still needs the full proposed bytes for reconciliation.
  const proposalInput = input.existing_requests.length > 0 ? { ...input, existing_requests: [] } : input;
  const built = buildSelectedWorkflowRequest(proposalInput, receipts, choice);
  if (!built.ok) return built;
  if (input.existing_requests.length > 0) {
    const checked = validateRequestInSnapshot(input, built.value);
    if (!checked.ok) {
      if (!checked.diagnostics.every((item) => item.code === 'IDEMPOTENCY_CONFLICT')) return checked;
      return decision(input, {
        outcome: 'blocked',
        reasons: [
          {
            code: 'IDEMPOTENCY_CONFLICT',
            request: built.value,
            message: 'A different request occupies this logical action slot.',
            recovery: 'Reconcile the retained request and the current proposal before dispatching work.',
          },
        ],
      });
    }
  }
  const { request, request_digest } = built.value;
  return request.actor === 'human'
    ? decision(input, { outcome: 'human_action_required', action_request: { request, request_digest } })
    : decision(input, { outcome: 'engineering_action_required', action_request: { request, request_digest } });
}
