import { buildActionRequest, validateControllerDecision, type ControllerInput } from 'threadloop-contracts/controller';
import { describe, expect, it } from 'vitest';
import { selectWorkflowDecision } from '../../src/domain/workflow-controller.js';
import { workflowDigest } from '../../src/domain/workflow-selection-types.js';
import { makeWorkflowInput } from '../helpers/workflow-input.js';

describe('workflow controller', () => {
  it('returns binding diagnostics ahead of a possible terminal outcome', () => {
    const input = makeWorkflowInput();
    input.binding.source_state = 'completed';
    input.binding.graph_digest = '0'.repeat(64);
    const result = selectWorkflowDecision(input);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toContain('BINDING_MISMATCH');
  });

  it('observes an idle terminal run even when there is no usable new observation', () => {
    const input = makeWorkflowInput();
    input.binding.source_state = 'completed';
    input.observation.status = 'unavailable';
    const original = structuredClone(input);
    const result = selectWorkflowDecision(input);
    expect(result).toMatchObject({
      ok: true,
      value: { decision: { outcome: 'terminal', terminal_state: 'completed', binding: input.binding } },
    });
    expect(selectWorkflowDecision(input)).toEqual(result);
    expect(input).toEqual(original);
  });
});

function withExecution(): ControllerInput {
  const input = makeWorkflowInput();
  input.binding.source_state = 'implementing';
  const result = buildActionRequest(input, {
    action_id: 'implement',
    transition_id: 'verify_implementation',
    guard_ids: ['work_committed'],
    inputs: [],
    evidence_ids: [],
    evidence_requirements: [
      { family: 'repository_observation', guard_id: 'work_committed', subject: input.binding.subject },
    ],
    valid_until: null,
  });
  if (!result.ok || result.value.request.actor !== 'executor') throw new Error(JSON.stringify(result));
  input.execution = {
    status: 'in_flight',
    request: { request: result.value.request, request_digest: result.value.request_digest },
    claim: { id: 'claim', version: 1, valid_until: '2026-01-02T00:00:00.000Z' },
    attempt: { id: 'attempt', status: 'running' },
  };
  return input;
}

it('waits for exactly the existing request, claim version and Attempt', () => {
  const input = withExecution();
  const result = selectWorkflowDecision(input);
  expect(result).toMatchObject({
    ok: true,
    value: { decision: { outcome: 'waiting', claim: { id: 'claim', version: 1 }, attempt_id: 'attempt' } },
  });
  if (result.ok) expect(validateControllerDecision(input, result.value)).toEqual(result);
});

it('requires reconciliation for a fenced Attempt and reports inclusive claim expiry', () => {
  const input = withExecution();
  input.invalidated_claims = [{ id: 'claim', version: 1 }];
  expect(selectWorkflowDecision(input)).toMatchObject({
    ok: true,
    value: { decision: { outcome: 'blocked', reasons: [{ code: 'EXECUTION_RECONCILIATION_REQUIRED' }] } },
  });
  input.evaluation_time = '2026-01-02T00:00:00.000Z';
  expect(selectWorkflowDecision(input)).toMatchObject({
    ok: true,
    value: { decision: { outcome: 'blocked', reasons: [{ code: 'CLAIM_EXPIRED' }] } },
  });
});

it('blocks an active run with a stale subject or corrupt history before offering progress', () => {
  const input = makeWorkflowInput();
  input.observation.subject = { ...input.binding.subject, content_digest: '0'.repeat(64) };
  expect(selectWorkflowDecision(input)).toMatchObject({
    ok: true,
    value: { decision: { outcome: 'blocked', reasons: [{ code: 'STALE_OBSERVATION' }] } },
  });
  input.observation.subject = input.binding.subject;
  input.history = { status: 'corrupt', reason: 'The retained event digest differs.' };
  expect(selectWorkflowDecision(input)).toMatchObject({
    ok: true,
    value: { decision: { outcome: 'blocked', reasons: [{ code: 'INVALID_HISTORY' }] } },
  });
});

it('chooses the eligible edge with the lowest priority in a differently named graph', () => {
  const profile = {
    schema_version: '0.1',
    profile: { id: 'parcel_dispatch', revision: 1 },
    initial_state: 'receipt',
    states: [
      { id: 'receipt', kind: 'active' },
      { id: 'packing', kind: 'active' },
      { id: 'dispatch', kind: 'active' },
      { id: 'delivered', kind: 'terminal' },
    ],
    transitions: [
      {
        id: 'alphabetically_first',
        from: 'receipt',
        to: 'packing',
        priority: 30,
        guard_refs: [],
        authority: ['threadloop'],
      },
      { id: 'use_dispatch', from: 'receipt', to: 'dispatch', priority: 5, guard_refs: [], authority: ['threadloop'] },
      {
        id: 'ship_packed',
        from: 'packing',
        to: 'delivered',
        guard_refs: ['delivery_authorized', 'delivery_observed'],
        authority: ['threadloop', 'human'],
      },
      {
        id: 'ship_dispatched',
        from: 'dispatch',
        to: 'delivered',
        guard_refs: ['delivery_authorized', 'delivery_observed'],
        authority: ['threadloop', 'human'],
      },
    ],
    guards: [
      {
        id: 'delivery_authorized',
        capability: 'human_approval',
        parameters: { scope: 'current_subject' },
        required_actions: ['authorize'],
      },
      { id: 'delivery_observed', capability: 'completion_observed', parameters: { kind: 'publication' } },
    ],
    required_actions: [{ id: 'authorize', capability: 'approve_change', authority: 'human', parameters: {} }],
  };
  const input = makeWorkflowInput(JSON.stringify(profile));
  const result = selectWorkflowDecision(input);
  expect(result).toMatchObject({
    ok: true,
    value: {
      decision: {
        outcome: 'transition_available',
        transition_id: 'use_dispatch',
        target_state: 'dispatch',
        checks: [],
      },
    },
  });
  if (result.ok) expect(validateControllerDecision(input, result.value)).toEqual(result);
  profile.transitions.reverse();
  expect(selectWorkflowDecision(makeWorkflowInput(JSON.stringify(profile)))).toEqual(result);
});

it('holds an outstanding effect after the run or its execution authority changes', () => {
  const earlier = withExecution();
  const changed = structuredClone(earlier);
  changed.binding.source_state = 'completed';
  changed.binding.state_version += 1;
  const revoked = structuredClone(earlier);
  revoked.available_capabilities = [];
  const newPolicy = structuredClone(earlier);
  newPolicy.policy.rules.local_gate_ids.push('second_check');
  newPolicy.policy.digest = workflowDigest(newPolicy.policy.rules);
  for (const input of [changed, revoked, newPolicy]) {
    const result = selectWorkflowDecision(input);
    expect(result).toMatchObject({
      ok: true,
      value: { decision: { outcome: 'blocked', reasons: [{ code: 'EXECUTION_RECONCILIATION_REQUIRED' }] } },
    });
    if (result.ok) expect(validateControllerDecision(input, result.value)).toEqual(result);
  }
});

it('replays an identical action and refuses changed contents under the same action identity', () => {
  const input = makeWorkflowInput();
  input.binding.source_state = 'verifying';
  input.observation.valid_until = '2026-01-02T00:00:00.000Z';
  const original = selectWorkflowDecision(input);
  if (!original.ok || original.value.decision.outcome !== 'engineering_action_required') {
    throw new Error(JSON.stringify(original));
  }
  const request = original.value.decision.action_request;
  expect(request.request).toMatchObject({
    capability: 'run_local_gates',
    constraints: { valid_until: input.observation.valid_until },
  });
  input.existing_requests = [
    { idempotency_key: request.request.idempotency_key, request_digest: request.request_digest },
  ];
  expect(selectWorkflowDecision(input)).toMatchObject({
    ok: true,
    value: { decision: { outcome: 'engineering_action_required', action_request: request } },
  });
  input.observation.valid_until = '2026-01-03T00:00:00.000Z';
  const conflict = selectWorkflowDecision(input);
  expect(conflict).toMatchObject({
    ok: true,
    value: {
      decision: {
        outcome: 'blocked',
        reasons: [
          { code: 'IDEMPOTENCY_CONFLICT', request: { request: { idempotency_key: request.request.idempotency_key } } },
        ],
      },
    },
  });
  if (conflict.ok) expect(validateControllerDecision(input, conflict.value)).toEqual(conflict);
});

it('refuses a ready transition that lacks its graph-declared authority', () => {
  const input = makeWorkflowInput();
  input.policy.rules.authorities = input.policy.rules.authorities.filter((entry) => entry.type !== 'threadloop');
  input.policy.digest = workflowDigest(input.policy.rules);
  const result = selectWorkflowDecision(input);
  expect(result).toMatchObject({
    ok: true,
    value: { decision: { outcome: 'blocked', reasons: [{ code: 'AUTHORITY_UNAVAILABLE' }] } },
  });
  if (result.ok) expect(validateControllerDecision(input, result.value)).toEqual(result);
});

it('names the unavailable transition authority before proposing proof collection', () => {
  const input = makeWorkflowInput();
  input.binding.source_state = 'verifying';
  input.policy.rules.authorities = input.policy.rules.authorities.filter(({ type }) => type !== 'threadloop');
  input.policy.digest = workflowDigest(input.policy.rules);
  const result = selectWorkflowDecision(input);
  expect(result).toMatchObject({
    ok: true,
    value: {
      decision: {
        outcome: 'blocked',
        reasons: [{ code: 'AUTHORITY_UNAVAILABLE', transition_id: 'enter_pre_pr_review' }],
      },
    },
  });
  if (result.ok) expect(validateControllerDecision(input, result.value)).toEqual(result);
});

it('keeps a checkout restoration with its human when that identity is missing', () => {
  const input = makeWorkflowInput();
  input.binding.source_state = 'proof_ready';
  input.observation.repository!.branch = 'unrelated';
  input.policy.rules.authorities = input.policy.rules.authorities.filter(({ type }) => type !== 'human');
  input.policy.digest = workflowDigest(input.policy.rules);
  const result = selectWorkflowDecision(input);
  expect(result).toMatchObject({
    ok: true,
    value: {
      decision: {
        outcome: 'blocked',
        reasons: [{ code: 'NO_APPLICABLE_REMEDY' }],
      },
    },
  });
  if (result.ok && result.value.decision.outcome === 'blocked') {
    expect(result.value.decision.reasons[0]!.recovery).toMatch(/human/i);
  }
});

it('reconciles a conflicting active request before refreshing stale observation or history', () => {
  const input = withExecution();
  if (input.execution.status !== 'in_flight') throw new Error('Expected the existing Attempt.');
  input.existing_requests = [
    {
      idempotency_key: input.execution.request.request.idempotency_key,
      request_digest: 'f'.repeat(64),
    },
  ];
  input.observation.status = 'unavailable';
  const badHistory = structuredClone(input);
  badHistory.observation.status = 'verified';
  badHistory.history = { status: 'corrupt', reason: 'An event is missing.' };
  for (const snapshot of [input, badHistory]) {
    expect(selectWorkflowDecision(snapshot)).toMatchObject({
      ok: true,
      value: { decision: { outcome: 'blocked', reasons: [{ code: 'EXECUTION_RECONCILIATION_REQUIRED' }] } },
    });
  }
});
