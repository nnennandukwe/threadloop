import { describe, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { z } from 'zod';
import {
  actionActorSchema,
  actionIntentSchema,
  actionRequestSchema,
  controllerInputSchema,
  controllerDecisionSchema,
  publishedControllerSchemas,
  type ControllerInput,
} from '../../scripts/controller-contract/contracts.js';
import {
  currentReceipt,
  validateActionRequest,
  validateControllerInput,
} from '../../scripts/controller-contract/validation.js';
import { buildActionRequest } from '../../scripts/controller-contract/request.js';
import { validateControllerDecision } from '../../scripts/controller-contract/decision.js';
import { compiledGraphSchema, compiledPayloadSchema } from '../../scripts/workflow-graph/contracts.js';
import { digest } from '../../scripts/contract-kernel/kernel.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { controllerSnapshot, localProofIntent } from '../fixtures/controller-contract.js';
import { ajv, codes, publishedValidators } from '../fixtures/contracts.js';

const bundle = new URL('../../docs/contracts/controller-v0.1/', import.meta.url);
const exampleSchema = z.strictObject({
  id: z.string(),
  graph_fixture: z.enum(['governed-pr', 'release-to-publish']),
  input: controllerInputSchema.omit({ compiled_graph: true }),
  intent: actionIntentSchema.nullable(),
  expected: controllerDecisionSchema,
});

async function readExample(name: string) {
  const fixture = exampleSchema.parse(
    JSON.parse(await readFile(new URL(`fixtures/valid/${name}.json`, bundle), 'utf8')),
  );
  const compiled = compiledGraphSchema.parse(
    JSON.parse(
      await readFile(
        new URL(`../workflow-graph-v0.1/fixtures/valid/${fixture.graph_fixture}.compiled.json`, bundle),
        'utf8',
      ),
    ),
  );
  return { ...fixture, input: { ...fixture.input, compiled_graph: compiled } };
}

describe('Published controller specification', () => {
  it('publishes its schemas and checks every positive example, canonical byte, digest, and request', async () => {
    const validators = await publishedValidators('controller', publishedControllerSchemas());
    const manifest = z
      .array(z.string())
      .parse(JSON.parse(await readFile(new URL('fixtures/valid/manifest.json', bundle), 'utf8')));
    const files = (await readdir(new URL('fixtures/valid/', bundle)))
      .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
      .sort();
    expect(files).toEqual(manifest.map((id) => id + '.json').sort());
    const outcomes = new Set<string>();
    for (const id of manifest) {
      const fixture = await readExample(id);
      expect(fixture.id).toBe(id);
      expect(validators['controller-input']!(fixture.input), id + ': input schema').toBe(true);
      expect(validators['controller-decision']!(fixture.expected), id + ': decision schema').toBe(true);
      const validated = validateControllerDecision(fixture.input, fixture.expected);
      expect(validated.ok, id + ': ' + JSON.stringify(validated)).toBe(true);
      const bytes = await readFile(new URL(`fixtures/valid/${id}.decision.canonical`, bundle), 'utf8');
      expect(canonicalJson(fixture.expected.decision), id).toBe(bytes);
      expect(sha256(bytes), id).toBe(fixture.expected.decision_digest);
      outcomes.add(fixture.expected.decision.outcome);
      if (fixture.intent) {
        const built = buildActionRequest(fixture.input, fixture.intent);
        expect(built.ok, id + ': ' + JSON.stringify(built)).toBe(true);
        const decision = fixture.expected.decision;
        expect('action_request' in decision, id).toBe(true);
        if (!built.ok || !('action_request' in decision)) continue;
        expect(built.value, id).toEqual(decision.action_request);
        expect(validators['action-request']!(built.value), id + ': request schema').toBe(true);
        expect(canonicalJson(built.value.request), id).toBe(
          await readFile(new URL(`fixtures/valid/${id}.request.canonical`, bundle), 'utf8'),
        );
      }
    }
    expect([...outcomes].sort()).toEqual([
      'blocked',
      'engineering_action_required',
      'human_action_required',
      'terminal',
      'transition_available',
      'waiting',
    ]);
  });

  it('schema-checks every negative fixture and rejects semantically invalid candidates even after rehashing', async () => {
    const names = z
      .array(z.string())
      .parse(JSON.parse(await readFile(new URL('fixtures/invalid/manifest.json', bundle), 'utf8')));
    expect(
      (await readdir(new URL('fixtures/invalid/', bundle)))
        .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
        .sort(),
    ).toEqual(names.map((name) => name + '.json').sort());
    const negativeSchema = z.strictObject({
      id: z.string(),
      base: z.string(),
      mutations: z.array(
        z.strictObject({ path: z.array(z.union([z.string(), z.number().int().nonnegative()])), value: z.unknown() }),
      ),
      schema_valid: z.boolean(),
      reseal: z.boolean(),
      expected_code: z.string(),
    });
    const schemas = publishedControllerSchemas();
    const inputSchema = ajv().compile(schemas['controller-input']!);
    const decisionSchema = ajv().compile(schemas['controller-decision']!);
    for (const name of names) {
      const negative = negativeSchema.parse(
        JSON.parse(await readFile(new URL(`fixtures/invalid/${name}.json`, bundle), 'utf8')),
      );
      expect(negative.id).toBe(name);
      const fixture = await readExample(negative.base);
      for (const mutation of negative.mutations) replaceFixtureValue(fixture, mutation.path, mutation.value);
      if (negative.reseal) {
        const decision = fixture.expected.decision;
        decision.input_digest = digest(fixture.input);
        if ('action_request' in decision)
          decision.action_request.request_digest = digest(decision.action_request.request);
        fixture.expected.decision_digest = digest(decision);
      }
      expect(inputSchema(fixture.input) && decisionSchema(fixture.expected), name + ': schema classification').toBe(
        negative.schema_valid,
      );
      expect(codes(validateControllerDecision(fixture.input, fixture.expected)), name).toContain(
        negative.expected_code,
      );
    }
  });
});

function replaceFixtureValue(root: unknown, path: (string | number)[], value: unknown): void {
  let parent = root as Record<string | number, unknown>;
  for (const part of path.slice(0, -1)) {
    if (['__proto__', 'prototype', 'constructor'].includes(String(part)) || !(part in parent))
      throw new Error('Invalid fixture mutation path');
    parent = parent[part] as Record<string | number, unknown>;
  }
  const key = path.at(-1);
  if (key === undefined || ['__proto__', 'prototype', 'constructor'].includes(String(key)))
    throw new Error('Invalid fixture mutation key');
  parent[key] = value;
}

function decisionEnvelope(input: ControllerInput, outcome: object) {
  const decision = { ...outcome, schema_version: '0.1', input_digest: digest(input), binding: input.binding };
  return { decision, decision_digest: digest(decision) };
}

/** A blocked candidate asserting one reason; the prose is informational. */
function blocked(input: ControllerInput, reason: object) {
  return decisionEnvelope(input, {
    outcome: 'blocked',
    reasons: [{ ...reason, message: 'Claimed reason', recovery: 'Restore the facts' }],
  });
}

function receipt(input: ControllerInput, current = true): ControllerInput['receipts'][number] {
  const payload = { type: 'local_proof', gate_id: 'check', result: 'passed', clean: true } as const;
  return {
    id: 'local_b',
    workflow_run_id: input.binding.workflow_run_id,
    graph_digest: input.binding.graph_digest,
    source_state_version: 3,
    subject: current ? input.binding.subject : { ...input.binding.subject, content_digest: sha256('old_tree') },
    sequence: 1,
    policy: input.policy.rules.evidence_policies[0]!,
    acceptance: { id: 'acceptance_1', digest: sha256('acceptance_1') },
    workflow_policy: { id: input.policy.id, digest: input.policy.digest },
    valid_until: null,
    origin: { kind: 'observation' },
    payload,
    payload_digest: digest(payload),
  };
}

function withPayload(
  item: ControllerInput['receipts'][number],
  payload: ControllerInput['receipts'][number]['payload'],
): ControllerInput['receipts'][number] {
  item.payload = payload;
  item.payload_digest = digest(payload);
  return item;
}

function resealPolicy(input: ControllerInput) {
  input.policy.digest = digest(input.policy.rules);
  for (const item of input.receipts) item.workflow_policy.digest = input.policy.digest;
}

describe('Controller Decision consistency', () => {
  it('cannot call an active state terminal or invent healthy waiting', async () => {
    const input = await controllerSnapshot();
    expect(
      codes(
        validateControllerDecision(
          input,
          decisionEnvelope(input, { outcome: 'terminal', terminal_state: 'reviewing' }),
        ),
      ),
    ).toContain('NOT_TERMINAL');
    const waiting = decisionEnvelope(input, {
      outcome: 'waiting',
      request: { idempotency_key: sha256('slot'), request_digest: sha256('request') },
      claim: { id: 'claim', version: 1 },
      attempt_id: 'attempt',
    });
    expect(codes(validateControllerDecision(input, waiting))).toContain('INVALID_WAIT');
  });

  it('reports terminal instead of blocking an already terminal idle run', async () => {
    const fixture = await readExample('terminal');
    fixture.input.observation.status = 'unavailable';
    const candidate = blocked(fixture.input, { code: 'STALE_OBSERVATION' });
    expect(codes(validateControllerDecision(fixture.input, candidate))).toContain('TERMINAL_RUN');
  });
});

describe('Bound Action Requests', () => {
  it('builds identical bytes without mutating either argument', async () => {
    const input = await controllerSnapshot();
    const intent = localProofIntent(input);
    const original = structuredClone({ input, intent });
    const first = buildActionRequest(input, intent);
    expect(first.ok).toBe(true);
    expect(buildActionRequest(input, intent)).toEqual(first);
    expect({ input, intent }).toEqual(original);
    if (first.ok) expect(validateActionRequest(input, first.value).ok).toBe(true);
  });

  it('does not use the machine clock when explicit input stays unchanged', async () => {
    const input = await controllerSnapshot();
    const intent = localProofIntent(input);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
      const first = buildActionRequest(input, intent);
      vi.setSystemTime(new Date('2040-01-01T00:00:00.000Z'));
      expect(buildActionRequest(input, intent)).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an action unrelated to the selected transition', async () => {
    const input = await controllerSnapshot();
    expect(codes(buildActionRequest(input, { ...localProofIntent(input), action_id: 'merge' }))).toContain(
      'ACTION_GUARD_MISMATCH',
    );
  });

  it('permits refresh around old receipts but never uses them as authority', async () => {
    const input = await controllerSnapshot();
    input.receipts = [receipt(input, false)];
    expect(buildActionRequest(input, localProofIntent(input)).ok).toBe(true);
    const intent = { ...localProofIntent(input), evidence_ids: ['local_b'] };
    expect(codes(buildActionRequest(input, intent))).toContain('STALE_OR_MISSING_EVIDENCE');
  });

  it('keeps logical identity stable and rejects changed content under it', async () => {
    const input = await controllerSnapshot();
    const intent = localProofIntent(input);
    const first = buildActionRequest(input, intent);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    input.existing_requests = [
      { idempotency_key: first.value.request.idempotency_key, request_digest: first.value.request_digest },
    ];
    expect(buildActionRequest(input, intent)).toEqual(first);
    const changed = {
      ...intent,
      inputs: [...intent.inputs, { role: 'change_context', artifact: { id: 'scope', digest: sha256('scope') } }],
    };
    expect(codes(buildActionRequest(input, changed))).toContain('IDEMPOTENCY_CONFLICT');
  });

  it('caps validity at the observation and expires at the exact deadline', async () => {
    const input = await controllerSnapshot();
    input.observation.valid_until = '2026-09-05T12:00:00.000Z';
    input.evaluation_time = '2026-09-05T11:59:59.999Z';
    const built = buildActionRequest(input, localProofIntent(input));
    expect(built.ok && built.value.request.constraints.valid_until).toBe(input.observation.valid_until);
    input.evaluation_time = input.observation.valid_until;
    expect(codes(buildActionRequest(input, localProofIntent(input)))).toContain('STALE_OBSERVATION');
  });

  it('preserves evidence from an earlier state but rejects superseded or fenced evidence', async () => {
    const input = await controllerSnapshot();
    const proof = receipt(input);
    input.receipts = [proof];
    const intent = { ...localProofIntent(input), evidence_ids: [proof.id] };
    expect(buildActionRequest(input, intent).ok).toBe(true);
    input.receipts.push({ ...proof, id: 'newer_proof', sequence: 2 });
    expect(codes(buildActionRequest(input, intent))).toContain('STALE_OR_MISSING_EVIDENCE');
    input.receipts = [
      {
        ...proof,
        origin: {
          kind: 'attempt',
          request: { idempotency_key: sha256('slot'), request_digest: sha256('request') },
          claim: { id: 'claim_1', version: 1 },
          attempt_id: 'attempt_1',
        },
      },
    ];
    input.invalidated_claims = [{ id: 'claim_1', version: 1 }];
    expect(codes(buildActionRequest(input, intent))).toContain('STALE_OR_MISSING_EVIDENCE');
  });

  it('will not issue another request while healthy work is in flight', async () => {
    const fixture = await readExample('waiting');
    expect(codes(buildActionRequest(fixture.input, localProofIntent(fixture.input)))).toContain('EXECUTION_NOT_IDLE');
  });

  it('requires current human approval of the exact artifact and approver before publication', async () => {
    const fixture = await readExample('release_publication');
    const approval = fixture.input.receipts.find((item) => item.payload.type === 'human_approval')!;
    approval.subject = { ...approval.subject, content_digest: sha256('another_artifact') };
    expect(codes(buildActionRequest(fixture.input, fixture.intent))).toContain('STALE_OR_MISSING_EVIDENCE');
    const wrongAuthority = await readExample('release_publication');
    const other = wrongAuthority.input.receipts.find((item) => item.payload.type === 'human_approval')!;
    if (other.payload.type !== 'human_approval') throw new Error('Expected approval');
    withPayload(other, { ...other.payload, approver: { type: 'human', id: 'other_human' } });
    expect(codes(buildActionRequest(wrongAuthority.input, wrongAuthority.intent))).toContain(
      'ACTION_PREREQUISITE_MISSING',
    );
  });
});

describe('Controller snapshot binding', () => {
  it('accepts both graph profiles as explicit normalized snapshots', async () => {
    for (const profile of ['governed-pr', 'release-to-publish'] as const) {
      expect(validateControllerInput(await controllerSnapshot(profile)).ok).toBe(true);
    }
  });

  it('rejects a run bound to a different graph without changing the input', async () => {
    const input = await controllerSnapshot();
    input.binding.graph_digest = '0'.repeat(64);
    const original = structuredClone(input);
    expect(codes(validateControllerInput(input))).toEqual(['BINDING_MISMATCH']);
    expect(input).toEqual(original);
  });

  it('validates graph references in immutable execution requests after rehashing', async () => {
    for (const [field, value, code] of [
      ['capability', 'obtain_review_evidence', 'ACTION_BINDING_MISMATCH'],
      ['transition_id', 'undeclared_transition', 'ACTION_TRANSITION_MISMATCH'],
      ['guard_ids', ['undeclared_guard'], 'ACTION_GUARD_MISMATCH'],
      ['action_id', 'undeclared_action', 'ACTION_BINDING_MISMATCH'],
    ] as const) {
      const fixture = await readExample('waiting');
      if (fixture.input.execution.status !== 'in_flight') throw new Error('Expected active fixture');
      const envelope = fixture.input.execution.request;
      replaceFixtureValue(envelope.request, [field], value);
      envelope.request.idempotency_key = digest({
        schema_version: '0.1',
        binding: envelope.request.binding,
        action_id: envelope.request.action_id,
      });
      envelope.request_digest = digest(envelope.request);
      expect(codes(validateControllerInput(fixture.input)), field).toContain(code);
    }
  });
});

describe('Guard evidence and repair budgets', () => {
  it('cannot use setup failure as a code-repair basis or exceed the entry budget', async () => {
    const input = await controllerSnapshot();
    input.binding.source_state = 'verifying';
    if (input.history.status !== 'verified') throw new Error('Expected verified fixture');
    input.history.budget_counts[0]!.used = 2;
    const proof = withPayload(receipt(input), { type: 'local_proof', gate_id: 'check', result: 'failed', clean: true });
    input.receipts = [proof];
    const outcome = {
      outcome: 'transition_available',
      transition_id: 'repair_failed_proof',
      target_state: 'repairing',
      checks: [
        { guard_id: 'plan', evidence_ids: [] },
        { guard_id: 'post', evidence_ids: [] },
        { guard_id: 'local_fail', evidence_ids: [proof.id] },
        { guard_id: 'repair_available', evidence_ids: [] },
      ],
    };
    expect(validateControllerDecision(input, decisionEnvelope(input, outcome)).ok).toBe(true);
    input.history.budget_counts[0]!.used = 3;
    expect(codes(validateControllerDecision(input, decisionEnvelope(input, outcome)))).toEqual([
      'GUARD_EVIDENCE_MISMATCH',
    ]);
    input.history.budget_counts[0]!.used = 2;
    withPayload(proof, { type: 'local_proof', gate_id: 'check', result: 'setup_failed', clean: true });
    expect(codes(validateControllerDecision(input, decisionEnvelope(input, outcome)))).toEqual([
      'GUARD_EVIDENCE_MISMATCH',
    ]);
  });

  it('allows the last admitted repair to finish without consuming another entry', async () => {
    const input = await controllerSnapshot();
    input.binding.source_state = 'repairing';
    if (input.history.status !== 'verified' || !input.observation.repository)
      throw new Error('Expected repository fixture');
    input.history.budget_counts[0]!.used = 3;
    input.history.implementation_basis = { ...input.binding.subject, content_digest: sha256('failed_basis') };
    input.observation.repository.basis = input.history.implementation_basis as NonNullable<
      typeof input.observation.repository.basis
    >;
    input.observation.repository.relationship = 'descendant';
    const outcome = {
      outcome: 'transition_available',
      transition_id: 'verify_repair',
      target_state: 'verifying',
      checks: [
        { guard_id: 'plan', evidence_ids: [] },
        { guard_id: 'repair_committed', evidence_ids: [] },
      ],
    };
    expect(codes(validateControllerDecision(input, decisionEnvelope(input, outcome)))).toEqual([
      'GUARD_EVIDENCE_MISMATCH',
    ]);
    input.history.repair_admission = {
      action_id: 'repair',
      transition_id: 'repair_failed_proof',
      entry_state_version: 5,
      bound_state_version: 5,
      budget_id: 'repair_entries',
      consumed: 3,
    };
    const original = structuredClone(input);
    expect(validateControllerDecision(input, decisionEnvelope(input, outcome)).ok).toBe(true);
    expect(input).toEqual(original);
  });

  it('checks the clean named baseline before first proof-plan binding', async () => {
    const input = await controllerSnapshot();
    input.binding.source_state = 'framed';
    if (input.history.status !== 'verified' || !input.observation.repository)
      throw new Error('Expected repository fixture');
    input.history.proof_plan_bound = false;
    const outcome = {
      outcome: 'transition_available',
      transition_id: 'bind_plan',
      target_state: 'proof_ready',
      checks: [{ guard_id: 'plan', evidence_ids: [] }],
    };
    expect(validateControllerDecision(input, decisionEnvelope(input, outcome)).ok).toBe(true);
    input.observation.repository.clean = false;
    expect(codes(validateControllerDecision(input, decisionEnvelope(input, outcome)))).toEqual([
      'GUARD_EVIDENCE_MISMATCH',
    ]);
    input.observation.repository.clean = true;
    input.observation.repository.branch = 'other_branch';
    expect(codes(validateControllerDecision(input, decisionEnvelope(input, outcome)))).toEqual([
      'GUARD_EVIDENCE_MISMATCH',
    ]);
  });

  it('limits clean-baseline bootstrap to the declared binding transition', async () => {
    const fixture = await readExample('transition_available');
    if (fixture.input.history.status !== 'verified') throw new Error('Expected history');
    fixture.input.binding.source_state = 'verifying';
    fixture.input.history.proof_plan_bound = false;
    const edge = fixture.input.compiled_graph.graph.transitions.find((edge) => edge.id === 'return_to_review')!;
    const checks = edge.guard_refs.map((guard_id) => ({
      guard_id,
      evidence_ids: guard_id === 'local_pass' ? ['local_b'] : guard_id === 'independent' ? ['independent_b'] : [],
    }));
    const candidate = decisionEnvelope(fixture.input, {
      outcome: 'transition_available',
      transition_id: edge.id,
      target_state: edge.to,
      checks,
    });
    expect(codes(validateControllerDecision(fixture.input, candidate))).toContain('GUARD_EVIDENCE_MISMATCH');
    fixture.input.policy.rules.proof_binding_transition_id = 'unknown_transition';
    fixture.input.policy.digest = digest(fixture.input.policy.rules);
    expect(codes(validateControllerInput(fixture.input))).toContain('INVALID_PROOF_BINDING_ENTRY');
  });

  it('requires retained proof-plan binding for local proof work and later review advancement', async () => {
    const input = await controllerSnapshot();
    if (input.history.status !== 'verified') throw new Error('Expected history');
    input.history.proof_plan_bound = false;
    expect(codes(buildActionRequest(input, localProofIntent(input)))).toContain('ACTION_PREREQUISITE_MISSING');
    const fixture = await readExample('transition_available');
    if (fixture.input.history.status !== 'verified') throw new Error('Expected history');
    fixture.input.history.proof_plan_bound = false;
    expect(
      codes(validateControllerDecision(fixture.input, decisionEnvelope(fixture.input, fixture.expected.decision))),
    ).toContain('GUARD_EVIDENCE_MISMATCH');
  });
});

describe('Blocked facts and active request obligations', () => {
  it('rejects unsupported blocked assertions and identifies selector-only proof gaps', async () => {
    const fixture = await readExample('transition_available');
    const proposed = buildActionRequest(fixture.input, localProofIntent(fixture.input));
    if (!proposed.ok) throw new Error('Expected request');
    const reasons = [
      { code: 'STALE_OBSERVATION' },
      { code: 'INVALID_HISTORY' },
      { code: 'EXECUTION_RECONCILIATION_REQUIRED' },
      { code: 'CLAIM_EXPIRED' },
      { code: 'UNSUPPORTED_CAPABILITY', action_id: 'run_gates' },
      { code: 'AUTHORITY_UNAVAILABLE', transition_id: 'human_handoff' },
      { code: 'EVIDENCE_UNAVAILABLE', guard_id: 'review_set' },
      { code: 'IDEMPOTENCY_CONFLICT', request: proposed.value },
      { code: 'AMBIGUOUS_REMEDY' },
      { code: 'NO_APPLICABLE_REMEDY' },
    ];
    for (const reason of reasons) {
      const result = validateControllerDecision(fixture.input, blocked(fixture.input, reason));
      expect(codes(result), reason.code).toEqual([
        ['AMBIGUOUS_REMEDY', 'NO_APPLICABLE_REMEDY'].includes(reason.code)
          ? 'SELECTION_PROOF_REQUIRED'
          : 'BLOCKED_REASON_MISMATCH',
      ]);
    }
  });

  it('requires real registry conflicts and accepts explicit unavailable history', async () => {
    const input = await controllerSnapshot();
    const built = buildActionRequest(input, localProofIntent(input));
    if (!built.ok) throw new Error('Expected request');
    const request = {
      idempotency_key: built.value.request.idempotency_key,
      request_digest: built.value.request_digest,
    };
    input.existing_requests = [request];
    expect(
      codes(validateControllerDecision(input, blocked(input, { code: 'IDEMPOTENCY_CONFLICT', request: built.value }))),
    ).toEqual(['BLOCKED_REASON_MISMATCH']);
    input.existing_requests[0] = { ...request, request_digest: sha256('different content') };
    expect(
      validateControllerDecision(input, blocked(input, { code: 'IDEMPOTENCY_CONFLICT', request: built.value })).ok,
    ).toBe(true);
    input.history = { status: 'unavailable', reason: 'History unavailable' };
    expect(validateControllerDecision(input, blocked(input, { code: 'INVALID_HISTORY' })).ok).toBe(true);
  });

  it('requires valid proposed contents and a real content difference for conflict', async () => {
    const input = await controllerSnapshot();
    const built = buildActionRequest(input, localProofIntent(input));
    if (!built.ok) throw new Error('Expected request');
    const proposal = structuredClone(built.value);
    input.existing_requests = [
      { idempotency_key: built.value.request.idempotency_key, request_digest: built.value.request_digest },
    ];
    proposal.request.inputs.unshift({ role: 'change_context', artifact: { id: 'context', digest: sha256('context') } });
    proposal.request_digest = digest(proposal.request);
    const conflict = () => blocked(input, { code: 'IDEMPOTENCY_CONFLICT', request: proposal });
    expect(validateControllerDecision(input, conflict()).ok).toBe(true);
    proposal.request_digest = sha256('invented proposal');
    expect(codes(validateControllerDecision(input, conflict()))).toEqual(['BLOCKED_REASON_MISMATCH']);
    proposal.request_digest = digest(proposal.request);
    input.observation.repository!.clean = false;
    expect(codes(validateControllerDecision(input, conflict()))).toEqual(['BLOCKED_REASON_MISMATCH']);
  });

  it('requires reconciliation when active work loses current prerequisites or binding', async () => {
    for (const drift of ['repository', 'state', 'capability'] as const) {
      const fixture = await readExample('waiting');
      if (fixture.input.execution.status !== 'in_flight') throw new Error('Expected active fixture');
      if (drift === 'repository') fixture.input.observation.repository!.clean = false;
      if (drift === 'state') {
        fixture.input.binding.state_version += 1;
        fixture.input.observation.state_version += 1;
      }
      if (drift === 'capability') fixture.input.available_capabilities = [];
      expect(validateControllerInput(fixture.input).ok, drift).toBe(true);
      const waiting = decisionEnvelope(fixture.input, fixture.expected.decision);
      expect(codes(validateControllerDecision(fixture.input, waiting)).length, drift).toBeGreaterThan(0);
      const reconcile = blocked(fixture.input, { code: 'EXECUTION_RECONCILIATION_REQUIRED' });
      expect(validateControllerDecision(fixture.input, reconcile).ok, drift).toBe(true);
    }
  });

  it('does not classify an inapplicable phase as unavailable evidence', async () => {
    const input = await controllerSnapshot();
    input.binding.source_state = 'verifying';
    expect(
      codes(validateControllerDecision(input, blocked(input, { code: 'EVIDENCE_UNAVAILABLE', guard_id: 'pre' }))),
    ).toEqual(['BLOCKED_REASON_MISMATCH']);
  });

  it('distinguishes missing proof from an observed failed result', async () => {
    const input = await controllerSnapshot();
    input.binding.source_state = 'verifying';
    const candidate = () => blocked(input, { code: 'EVIDENCE_UNAVAILABLE', guard_id: 'local_pass' });
    expect(validateControllerDecision(input, candidate()).ok).toBe(true);
    input.receipts = [
      withPayload(receipt(input), { type: 'local_proof', gate_id: 'check', result: 'failed', clean: true }),
    ];
    expect(codes(validateControllerDecision(input, candidate()))).toEqual(['BLOCKED_REASON_MISMATCH']);
  });

  it('requires block evidence for the current source state, even when another state has a later receipt', async () => {
    const input = await controllerSnapshot();
    const payload = {
      type: 'block_evidence',
      prior_state: 'verifying',
      reason: 'Stop',
      recovery: 'Restore proof',
      stop_code: 'PROOF_UNAVAILABLE',
    } as const;
    const evidence = withPayload(receipt(input), payload);
    input.receipts = [evidence];
    const guard = input.compiled_graph.graph.guards.find((guard) => guard.capability === 'block_evidence')!;
    const candidate = () => blocked(input, { code: 'EVIDENCE_UNAVAILABLE', guard_id: guard.id });
    expect(validateControllerDecision(input, candidate()).ok).toBe(true);
    withPayload(evidence, { ...payload, prior_state: input.binding.source_state });
    const other = withPayload({ ...structuredClone(evidence), id: 'other_state_block', sequence: 2 }, payload);
    input.receipts.push(other);
    expect(codes(validateControllerDecision(input, candidate()))).toEqual(['BLOCKED_REASON_MISMATCH']);
  });

  it('rejects empty gate configuration required by the graph before validating blocked reasons', async () => {
    for (const key of ['local_gate_ids', 'independent_gate_ids'] as const) {
      const fixture = await readExample('transition_available');
      fixture.input.policy.rules[key] = [];
      resealPolicy(fixture.input);
      expect(codes(validateControllerInput(fixture.input)), key).toEqual(['INVALID_PROOF_POLICY']);
      const candidate = blocked(fixture.input, { code: 'EVIDENCE_UNAVAILABLE', guard_id: 'review_set' });
      expect(codes(validateControllerDecision(fixture.input, candidate)), key).toEqual(['INVALID_PROOF_POLICY']);
    }
    expect(validateControllerInput(await controllerSnapshot('release-to-publish')).ok).toBe(true);
  });
});

describe('Graph-declared actor parity', () => {
  it('preserves every catalog capability and actor pair in typed and offline request schemas', async () => {
    const input = await controllerSnapshot();
    const built = buildActionRequest(input, localProofIntent(input));
    if (!built.ok) throw new Error('Expected request');
    const check = ajv().compile(publishedControllerSchemas()['action-request']!);
    for (const catalog of compiledPayloadSchema.shape.required_actions.element.options) {
      for (const capability of catalog.shape.capability.options) {
        for (const actor of ['human', 'executor'] as const) {
          const expected = catalog.shape.authority.safeParse(actor).success;
          const request = { ...built.value.request, capability, actor };
          const envelope = { request, request_digest: digest(request) };
          expect(actionActorSchema.safeParse({ capability, actor }).success, capability + ':' + actor).toBe(expected);
          expect(actionRequestSchema.safeParse(envelope).success, capability + ':' + actor).toBe(expected);
          expect(check(envelope), capability + ':' + actor).toBe(expected);
        }
      }
    }
  });

  it('permits human local gates only when the bound graph assigns them to a human', async () => {
    const input = await controllerSnapshot();
    const executorRequest = buildActionRequest(input, localProofIntent(input));
    if (!executorRequest.ok) throw new Error('Expected executor request');
    const disguised = { ...executorRequest.value.request, actor: 'human' };
    expect(codes(validateActionRequest(input, { request: disguised, request_digest: digest(disguised) }))).toContain(
      'ACTION_BINDING_MISMATCH',
    );
    const graph = input.compiled_graph.graph;
    graph.required_actions.find((action) => action.id === 'run_gates')!.authority = 'human';
    input.compiled_graph.graph_digest = digest(graph);
    input.binding.graph_digest = input.compiled_graph.graph_digest;
    input.available_capabilities = graph.required_actions.map((action) =>
      actionActorSchema.parse({ capability: action.capability, actor: action.authority }),
    );
    const handoff = buildActionRequest(input, localProofIntent(input));
    expect(handoff.ok && handoff.value.request.actor).toBe('human');
    if (!handoff.ok) return;
    expect(
      validateControllerDecision(
        input,
        decisionEnvelope(input, { outcome: 'human_action_required', action_request: handoff.value }),
      ).ok,
    ).toBe(true);
    expect(codes(validateActionRequest(input, executorRequest.value))).toContain('REQUEST_BINDING_MISMATCH');
  });

  it('keeps human handoffs out of both executor claim variants in typed and offline schemas', async () => {
    const fixture = await readExample('human_approval');
    const decision = fixture.expected.decision;
    if (!('action_request' in decision)) throw new Error('Expected human request');
    const request = decision.action_request;
    const check = ajv().compile(publishedControllerSchemas()['controller-input']!);
    for (const execution of [
      {
        status: 'in_flight',
        request,
        claim: { id: 'human_claim', version: 1, valid_until: '2026-09-05T12:00:00.000Z' },
        attempt: { id: 'human_attempt', status: 'pending' },
      },
      { status: 'reconciliation_required', request, claim: null, attempt_id: null, reason: 'unknown_outcome' },
    ]) {
      const input = { ...fixture.input, execution, evaluation_time: '2026-09-05T11:00:00.000Z' };
      expect(controllerInputSchema.safeParse(input).success).toBe(false);
      expect(check(input)).toBe(false);
      expect(codes(validateControllerInput(input))).toContain('SCHEMA_INVALID');
    }
  });
});

describe('Receipt stream identities', () => {
  it('does not let a different workflow policy supersede current evidence', async () => {
    const input = await controllerSnapshot();
    const proof = receipt(input);
    const other = {
      ...structuredClone(proof),
      id: 'other_policy_proof',
      sequence: 2,
      workflow_policy: { id: 'other_policy', digest: sha256('other_policy') },
    };
    input.receipts = [proof, other];
    expect(validateControllerInput(input).ok).toBe(true);
    expect(currentReceipt(proof, input)).toBe(true);
    expect(currentReceipt(other, input)).toBe(false);
  });

  it('keeps different publication destinations and human approvers in separate streams', async () => {
    const approval = (id: string) =>
      ({
        type: 'human_approval',
        scope: 'current_subject',
        approver: { type: 'human', id },
        reason: 'Approved',
      }) as const;
    const publication = (destination: string) =>
      ({ type: 'completion_observed', kind: 'publication', destination }) as const;
    for (const [firstPayload, secondPayload] of [
      [publication('channel_a'), publication('channel_b')],
      [approval('alice'), approval('bob')],
    ] as const) {
      const input = await controllerSnapshot();
      const first = withPayload(receipt(input), firstPayload);
      const second = withPayload({ ...receipt(input), id: 'later_receipt', sequence: 2 }, secondPayload);
      input.receipts = [first, second];
      expect(validateControllerInput(input).ok).toBe(true);
      expect(currentReceipt(first, input)).toBe(true);
      expect(currentReceipt(second, input)).toBe(true);
      withPayload(second, firstPayload);
      expect(currentReceipt(first, input)).toBe(false);
    }
  });
});

describe('Repair admission and engineering prerequisites', () => {
  it('does not construct repair work before a counted repair entry grants authority', async () => {
    const input = await controllerSnapshot();
    const proof = withPayload(receipt(input), { type: 'review', outcome: 'changes_required', findings: [] });
    input.receipts = [proof];
    const intent = {
      ...localProofIntent(input),
      action_id: 'repair',
      guard_ids: ['review_clear'],
      evidence_ids: [proof.id],
      evidence_requirements: [{ family: 'review', guard_id: 'review_clear', subject: input.binding.subject }],
    };
    expect(codes(buildActionRequest(input, intent))).toContain('ACTION_PREREQUISITE_MISSING');
  });

  it('does not infer an active repair admission from an aggregate budget count', async () => {
    const input = await controllerSnapshot();
    input.binding.source_state = 'repairing';
    if (input.history.status !== 'verified') throw new Error('Expected history');
    input.history.budget_counts[0]!.used = 1;
    const failure = withPayload(receipt(input), { type: 'review', outcome: 'changes_required', findings: [] });
    input.receipts = [failure];
    const guard = input.compiled_graph.graph.guards.find(
      (guard) => guard.required_actions.includes('repair') && guard.capability === 'repository',
    )!;
    const edge = input.compiled_graph.graph.transitions.find(
      (edge) => edge.from === 'repairing' && edge.guard_refs.includes(guard.id),
    )!;
    const intent = {
      ...localProofIntent(input),
      action_id: 'repair',
      transition_id: edge.id,
      guard_ids: [guard.id],
      evidence_ids: [failure.id],
      evidence_requirements: [{ family: 'repository_observation', guard_id: guard.id, subject: input.binding.subject }],
    };
    expect(codes(buildActionRequest(input, intent))).toContain('ACTION_PREREQUISITE_MISSING');
  });

  it('retains the final admitted repair through verified suspension and recovery without resetting counts', async () => {
    const fixture = await readExample('admitted_repair');
    const input = fixture.input;
    if (input.history.status !== 'verified' || input.history.repair_admission === null)
      throw new Error('Expected repair admission');
    const history = input.history;
    expect(buildActionRequest(input, fixture.intent).ok).toBe(true);
    input.binding.source_state = 'blocked';
    input.binding.state_version = 6;
    input.observation.state_version = 6;
    history.prior_state = 'repairing';
    history.repair_admission!.bound_state_version = 6;
    expect(validateControllerInput(input).ok).toBe(true);
    expect(codes(buildActionRequest(input, fixture.intent))).toContain('ACTION_TRANSITION_MISMATCH');
    input.binding.source_state = 'repairing';
    input.binding.state_version = 7;
    input.observation.state_version = 7;
    history.prior_state = null;
    history.repair_admission!.bound_state_version = 7;
    expect(buildActionRequest(input, fixture.intent).ok).toBe(true);
    expect(history.repair_admission!.entry_state_version).toBe(5);
    expect(history.budget_counts[0]!.used).toBe(3);
    history.repair_admission!.action_id = 'run_gates';
    expect(codes(validateControllerInput(input))).toEqual(['INVALID_REPAIR_ADMISSION']);
  });

  it('requires the active repair admission for commit work on the committed-repair guard', async () => {
    const fixture = await readExample('commit_admitted_repair');
    if (fixture.input.history.status !== 'verified' || fixture.intent === null)
      throw new Error('Expected repair fixture');
    const admission = fixture.input.history.repair_admission;
    const intent = { ...fixture.intent, action_id: 'commit' };
    fixture.input.history.repair_admission = null;
    expect(codes(buildActionRequest(fixture.input, intent))).toContain('ACTION_PREREQUISITE_MISSING');
    fixture.input.history.repair_admission = admission;
    expect(buildActionRequest(fixture.input, intent).ok).toBe(true);
  });

  it('rejects repair and setup interventions justified only by an unconfigured gate', async () => {
    for (const name of ['admitted_repair', 'setup_failure_handoff']) {
      const fixture = await readExample(name);
      const local = fixture.input.receipts.find((receipt) => receipt.payload.type === 'local_proof')!;
      if (local.payload.type !== 'local_proof') throw new Error('Expected local proof');
      withPayload(local, { ...local.payload, gate_id: 'unconfigured_gate' });
      expect(codes(buildActionRequest(fixture.input, fixture.intent)), name).toContain('ACTION_PREREQUISITE_MISSING');
    }
  });

  it('does not let an unconfigured setup failure veto an admitted repair', async () => {
    const fixture = await readExample('admitted_repair');
    if (!fixture.intent) throw new Error('Expected repair fixture');
    const unrelated = withPayload(
      { ...structuredClone(fixture.input.receipts[0]!), id: 'unrelated_setup', sequence: 2 },
      { type: 'local_proof', gate_id: 'unconfigured_gate', result: 'setup_failed', clean: true },
    );
    fixture.input.receipts.push(unrelated);
    fixture.intent.evidence_ids.push(unrelated.id);
    expect(buildActionRequest(fixture.input, fixture.intent).ok).toBe(true);
  });

  it('does not offer commit work on a clean unchanged admitted repair', async () => {
    const fixture = await readExample('admitted_repair');
    if (fixture.intent === null) throw new Error('Expected repair intent');
    expect(codes(buildActionRequest(fixture.input, { ...fixture.intent, action_id: 'commit' }))).toContain(
      'ACTION_PREREQUISITE_MISSING',
    );
  });

  it('requires commit scope, ancestry, changed content, and the declared basis input', async () => {
    for (const drift of ['scope', 'basis', 'ancestry', 'content', 'input'] as const) {
      const fixture = await readExample('commit_admitted_repair');
      if (fixture.input.history.status !== 'verified' || !fixture.input.observation.repository || !fixture.intent)
        throw new Error('Expected commit fixture');
      if (drift === 'scope') fixture.input.observation.repository.change_scope = 'outside_plan';
      if (drift === 'basis') fixture.input.history.implementation_basis = null;
      if (drift === 'ancestry') fixture.input.observation.repository.relationship = 'unknown';
      if (drift === 'content') {
        fixture.input.binding.subject = fixture.input.history.implementation_basis!;
        fixture.input.observation.subject = fixture.input.binding.subject;
      }
      if (drift === 'input')
        fixture.intent.inputs = fixture.intent.inputs.filter((item) => item.role !== 'implementation_basis');
      expect(codes(buildActionRequest(fixture.input, fixture.intent)), drift).toContain('ACTION_PREREQUISITE_MISSING');
    }
  });
});
