import { describe, expect, it, vi } from 'vitest';
import { actionActorSchema, type ControllerInput } from '../../scripts/controller-contract/contracts.js';
import {
  currentReceipt,
  validateActionRequest,
  validateControllerInput,
} from '../../scripts/controller-contract/validation.js';
import { buildActionRequest } from '../../scripts/controller-contract/request.js';
import { controllerSnapshot, localProofIntent } from '../fixtures/controller-contract.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { validateControllerDecision } from '../../scripts/controller-contract/decision.js';
import { readFile, readdir } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { z } from 'zod';
import {
  actionIntentSchema,
  actionRequestSchema,
  controllerInputSchema,
  controllerDecisionSchema,
  publishedControllerSchemas,
} from '../../scripts/controller-contract/contracts.js';
import { compiledGraphSchema, compiledPayloadSchema } from '../../scripts/workflow-graph/contracts.js';

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
  it('publishes strict offline Draft 2020-12 schemas matching the typed definitions', async () => {
    for (const [name, schema] of Object.entries(publishedControllerSchemas())) {
      const document: unknown = JSON.parse(await readFile(new URL(`schemas/${name}.schema.json`, bundle), 'utf8'));
      expect(document).toEqual(schema);
      expect(JSON.stringify(schema)).not.toContain('__schema');
      expect(new Ajv2020({ strict: true, strictTypes: false, validateFormats: false }).validateSchema(schema)).toBe(
        true,
      );
    }
  });

  it('checks every positive example, exact canonical bytes, digests, and request construction', async () => {
    const manifest = z
      .array(z.string())
      .parse(JSON.parse(await readFile(new URL('fixtures/valid/manifest.json', bundle), 'utf8')));
    const files = (await readdir(new URL('fixtures/valid/', bundle)))
      .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
      .sort();
    expect(files).toEqual(manifest.map((id) => id + '.json').sort());
    const ajv = new Ajv2020({ strict: true, strictTypes: false, validateFormats: false });
    const schemas = publishedControllerSchemas();
    const checkInput = ajv.compile(schemas['controller-input']!);
    const checkDecision = ajv.compile(schemas['controller-decision']!);
    const checkRequest = ajv.compile(schemas['action-request']!);
    const outcomes = new Set<string>();
    for (const id of manifest) {
      const fixture = await readExample(id);
      expect(fixture.id).toBe(id);
      expect(checkInput(fixture.input), id + ': input schema').toBe(true);
      expect(checkDecision(fixture.expected), id + ': decision schema').toBe(true);
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
        expect(checkRequest(built.value), id + ': request schema').toBe(true);
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
    // Zod places some types behind $ref siblings. Disable Ajv's type-style lint, not schema type validation.
    const ajv = new Ajv2020({ strict: true, strictTypes: false, validateFormats: false });
    const inputSchema = ajv.compile(schemas['controller-input']!);
    const decisionSchema = ajv.compile(schemas['controller-decision']!);
    for (const name of names) {
      const negative = negativeSchema.parse(
        JSON.parse(await readFile(new URL(`fixtures/invalid/${name}.json`, bundle), 'utf8')),
      );
      expect(negative.id).toBe(name);
      const fixture = await readExample(negative.base);
      for (const mutation of negative.mutations) replaceFixtureValue(fixture, mutation.path, mutation.value);
      if (negative.reseal) {
        const decision = fixture.expected.decision;
        decision.input_digest = sha256(canonicalJson(fixture.input));
        if ('action_request' in decision)
          decision.action_request.request_digest = sha256(canonicalJson(decision.action_request.request));
        fixture.expected.decision_digest = sha256(canonicalJson(decision));
      }
      expect(inputSchema(fixture.input) && decisionSchema(fixture.expected), name + ': schema classification').toBe(
        negative.schema_valid,
      );
      const result = validateControllerDecision(fixture.input, fixture.expected);
      expect(result.ok, name).toBe(false);
      if (!result.ok)
        expect(
          result.diagnostics.map((item) => item.code),
          name,
        ).toContain(negative.expected_code);
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

describe('Controller contract actor boundary', () => {
  it('represents human approval explicitly and permits executor proof collection', () => {
    expect(actionActorSchema.safeParse({ capability: 'approve_change', actor: 'human' }).success).toBe(true);
    expect(actionActorSchema.safeParse({ capability: 'run_local_gates', actor: 'executor' }).success).toBe(true);
  });

  it('rejects human-only work disguised as executor work and unknown capabilities', () => {
    for (const capability of ['approve_change', 'merge_change', 'block_run', 'recover_run', 'provider_tool']) {
      expect(actionActorSchema.safeParse({ capability, actor: 'executor' }).success).toBe(false);
    }
  });
});

function decisionEnvelope(input: ControllerInput, outcome: object) {
  const decision = {
    ...outcome,
    schema_version: '0.1',
    input_digest: sha256(canonicalJson(input)),
    binding: input.binding,
  };
  return { decision, decision_digest: sha256(canonicalJson(decision)) };
}

describe('Controller Decision consistency', () => {
  it('binds a decision to the whole canonical input snapshot', async () => {
    const input = await controllerSnapshot();
    const request = buildActionRequest(input, localProofIntent(input));
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    const candidate = decisionEnvelope(input, {
      outcome: 'engineering_action_required',
      action_request: request.value,
    });
    expect(validateControllerDecision(input, candidate).ok).toBe(true);
    input.observation.id = 'later_observation';
    expect(validateControllerDecision(input, candidate).ok).toBe(false);
  });

  it('cannot call an active state terminal or invent healthy waiting', async () => {
    const input = await controllerSnapshot();
    expect(
      validateControllerDecision(input, decisionEnvelope(input, { outcome: 'terminal', terminal_state: 'reviewing' }))
        .ok,
    ).toBe(false);
    expect(
      validateControllerDecision(
        input,
        decisionEnvelope(input, {
          outcome: 'waiting',
          request: { idempotency_key: sha256('slot'), request_digest: sha256('request') },
          claim: { id: 'claim', version: 1 },
          attempt_id: 'attempt',
        }),
      ).ok,
    ).toBe(false);
  });
});

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
    payload_digest: sha256(canonicalJson(payload)),
  };
}

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

  it('permits refresh around old receipts but never uses them as authority', async () => {
    const input = await controllerSnapshot();
    input.receipts = [receipt(input, false)];
    expect(buildActionRequest(input, localProofIntent(input)).ok).toBe(true);
    const intent = { ...localProofIntent(input), evidence_ids: ['local_b'] };
    const result = buildActionRequest(input, intent);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toContain('STALE_OR_MISSING_EVIDENCE');
  });

  it('rejects stale observations, unavailable capabilities, and unrelated actions', async () => {
    const input = await controllerSnapshot();
    const intent = localProofIntent(input);
    const stale = structuredClone(input);
    stale.observation.state_version -= 1;
    expect(buildActionRequest(stale, intent).ok).toBe(false);
    expect(buildActionRequest({ ...input, available_capabilities: [] }, intent).ok).toBe(false);
    expect(buildActionRequest(input, { ...intent, action_id: 'merge' }).ok).toBe(false);
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
    const conflict = buildActionRequest(input, changed);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.diagnostics.map((item) => item.code)).toContain('IDEMPOTENCY_CONFLICT');
  });

  it('requires explicit time, caps validity, and expires at the exact deadline', async () => {
    const input = await controllerSnapshot();
    input.observation.valid_until = '2026-09-05T12:00:00.000Z';
    expect(buildActionRequest(input, localProofIntent(input)).ok).toBe(false);
    input.evaluation_time = '2026-09-05T11:59:59.999Z';
    const built = buildActionRequest(input, localProofIntent(input));
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.value.request.constraints.valid_until).toBe(input.observation.valid_until);
    input.evaluation_time = input.observation.valid_until;
    expect(buildActionRequest(input, localProofIntent(input)).ok).toBe(false);
  });

  it('preserves evidence from an earlier state but rejects superseded or fenced evidence', async () => {
    const input = await controllerSnapshot();
    const proof = receipt(input);
    input.receipts = [proof];
    const intent = { ...localProofIntent(input), evidence_ids: [proof.id] };
    expect(buildActionRequest(input, intent).ok).toBe(true);
    input.receipts.push({ ...proof, id: 'newer_proof', sequence: 2 });
    expect(buildActionRequest(input, intent).ok).toBe(false);
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
    expect(buildActionRequest(input, intent).ok).toBe(false);
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
    expect(validateControllerInput(input).ok).toBe(false);
    expect(input).toEqual(original);
  });

  it('rejects policy contents that changed without changing their digest', async () => {
    const input = await controllerSnapshot();
    input.policy.rules.local_gate_ids = [];
    expect(validateControllerInput(input).ok).toBe(false);
  });
});

describe('Preserved lifecycle and temporal boundaries', () => {
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

  it('cannot use setup failure as a code-repair basis or exceed the entry budget', async () => {
    const input = await controllerSnapshot();
    input.binding.source_state = 'verifying';
    if (input.history.status !== 'verified') throw new Error('Expected verified fixture');
    input.history.budget_counts[0]!.used = 2;
    const proof = receipt(input);
    proof.payload = { type: 'local_proof', gate_id: 'check', result: 'failed', clean: true };
    proof.payload_digest = sha256(canonicalJson(proof.payload));
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
    expect(validateControllerDecision(input, decisionEnvelope(input, outcome)).ok).toBe(false);
    input.history.budget_counts[0]!.used = 2;
    proof.payload.result = 'setup_failed';
    proof.payload_digest = sha256(canonicalJson(proof.payload));
    expect(validateControllerDecision(input, decisionEnvelope(input, outcome)).ok).toBe(false);
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
    const original = structuredClone(input);
    const candidate = decisionEnvelope(input, {
      outcome: 'transition_available',
      transition_id: 'verify_repair',
      target_state: 'verifying',
      checks: [
        { guard_id: 'plan', evidence_ids: [] },
        { guard_id: 'repair_committed', evidence_ids: [] },
      ],
    });
    expect(validateControllerDecision(input, candidate).ok).toBe(true);
    expect(input).toEqual(original);
  });

  it('waits for healthy work but will not issue another request or advance during it', async () => {
    const fixture = await readExample('waiting');
    expect(validateControllerDecision(fixture.input, fixture.expected).ok).toBe(true);
    expect(buildActionRequest(fixture.input, localProofIntent(fixture.input)).ok).toBe(false);
    const active = fixture.input.execution;
    if (active.status !== 'in_flight') throw new Error('Expected active fixture');
    active.claim.version = 2;
    expect(validateControllerDecision(fixture.input, fixture.expected).ok).toBe(false);
  });

  it('requires current human approval of the exact artifact and destination before publication', async () => {
    const fixture = await readExample('release_publication');
    const approval = fixture.input.receipts.find((item) => item.payload.type === 'human_approval')!;
    approval.subject = { ...approval.subject, content_digest: sha256('another_artifact') };
    expect(buildActionRequest(fixture.input, fixture.intent).ok).toBe(false);
    const wrongAuthority = await readExample('release_publication');
    const approvalPayload = wrongAuthority.input.receipts.find((item) => item.payload.type === 'human_approval')!;
    if (approvalPayload.payload.type !== 'human_approval') throw new Error('Expected approval');
    approvalPayload.payload.approver.id = 'other_human';
    approvalPayload.payload_digest = sha256(canonicalJson(approvalPayload.payload));
    expect(buildActionRequest(wrongAuthority.input, wrongAuthority.intent).ok).toBe(false);
  });
});

describe('Proof binding and repair admission', () => {
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
    expect(validateControllerDecision(input, decisionEnvelope(input, outcome)).ok).toBe(false);
    input.observation.repository.clean = true;
    input.observation.repository.branch = 'other_branch';
    expect(validateControllerDecision(input, decisionEnvelope(input, outcome)).ok).toBe(false);
  });

  it('does not construct repair work before a counted repair entry grants authority', async () => {
    const input = await controllerSnapshot();
    const proof = receipt(input);
    proof.payload = { type: 'review', outcome: 'changes_required', findings: [] };
    proof.payload_digest = sha256(canonicalJson(proof.payload));
    input.receipts = [proof];
    const intent = {
      ...localProofIntent(input),
      action_id: 'repair',
      guard_ids: ['review_clear'],
      evidence_ids: [proof.id],
      evidence_requirements: [{ family: 'review', guard_id: 'review_clear', subject: input.binding.subject }],
    };
    expect(buildActionRequest(input, intent).ok).toBe(false);
  });
});

describe('Qodo review regressions', () => {
  it('rejects a resealed blocked reason that is absent from a healthy snapshot', async () => {
    const input = await controllerSnapshot();
    const candidate = decisionEnvelope(input, {
      outcome: 'blocked',
      reasons: [{ code: 'CLAIM_EXPIRED', message: 'Claim expired', recovery: 'Reconcile claim' }],
    });
    expect(validateControllerDecision(input, candidate).ok).toBe(false);
  });

  it('rejects a resealed undeclared in-flight action before classifying waiting', async () => {
    const fixture = await readExample('waiting');
    const execution = fixture.input.execution;
    if (execution.status !== 'in_flight') throw new Error('Expected active fixture');
    const envelope = execution.request;
    envelope.request.action_id = 'undeclared_action';
    envelope.request.idempotency_key = sha256(
      canonicalJson({
        schema_version: '0.1',
        binding: envelope.request.binding,
        action_id: envelope.request.action_id,
      }),
    );
    envelope.request_digest = sha256(canonicalJson(envelope.request));
    expect(validateControllerInput(fixture.input).ok).toBe(false);
    expect(
      validateControllerDecision(
        fixture.input,
        decisionEnvelope(fixture.input, {
          outcome: 'waiting',
          request: { idempotency_key: envelope.request.idempotency_key, request_digest: envelope.request_digest },
          claim: { id: execution.claim.id, version: execution.claim.version },
          attempt_id: execution.attempt.id,
        }),
      ).ok,
    ).toBe(false);
  });

  it('does not satisfy an independent-proof guard with an empty requirement set', async () => {
    const input = await controllerSnapshot();
    input.binding.source_state = 'verifying';
    if (input.history.status !== 'verified') throw new Error('Expected verified history');
    input.policy.rules.independent_gate_ids = [];
    input.policy.digest = sha256(canonicalJson(input.policy.rules));
    const local = receipt(input);
    input.receipts = [local];
    const candidate = decisionEnvelope(input, {
      outcome: 'transition_available',
      transition_id: 'return_to_review',
      target_state: 'reviewing',
      checks: [
        { guard_id: 'plan', evidence_ids: [] },
        { guard_id: 'post', evidence_ids: [] },
        { guard_id: 'checkout', evidence_ids: [] },
        { guard_id: 'local_pass', evidence_ids: [local.id] },
        { guard_id: 'independent', evidence_ids: [] },
      ],
    });
    expect(validateControllerDecision(input, candidate).ok).toBe(false);
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
      const candidate = decisionEnvelope(fixture.input, {
        outcome: 'blocked',
        reasons: [{ ...reason, message: 'Claimed reason', recovery: 'Restore facts' }],
      });
      const result = validateControllerDecision(fixture.input, candidate);
      expect(result.ok, reason.code).toBe(false);
      if (!result.ok)
        expect(result.diagnostics.map((item) => item.code)).toContain(
          ['AMBIGUOUS_REMEDY', 'NO_APPLICABLE_REMEDY'].includes(reason.code)
            ? 'SELECTION_PROOF_REQUIRED'
            : 'BLOCKED_REASON_MISMATCH',
        );
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
    const conflict = () =>
      decisionEnvelope(input, {
        outcome: 'blocked',
        reasons: [
          { code: 'IDEMPOTENCY_CONFLICT', request: built.value, message: 'Conflict', recovery: 'Reconcile request' },
        ],
      });
    input.existing_requests = [request];
    expect(validateControllerDecision(input, conflict()).ok).toBe(false);
    input.existing_requests[0] = { ...request, request_digest: sha256('different content') };
    expect(validateControllerDecision(input, conflict()).ok).toBe(true);
    input.history = { status: 'unavailable', reason: 'History unavailable' };
    expect(
      validateControllerDecision(
        input,
        decisionEnvelope(input, {
          outcome: 'blocked',
          reasons: [{ code: 'INVALID_HISTORY', message: 'History unavailable', recovery: 'Restore verified history' }],
        }),
      ).ok,
    ).toBe(true);
  });

  it('reports terminal instead of blocking an already terminal idle run', async () => {
    const fixture = await readExample('terminal');
    fixture.input.observation.status = 'unavailable';
    const candidate = decisionEnvelope(fixture.input, {
      outcome: 'blocked',
      reasons: [{ code: 'STALE_OBSERVATION', message: 'Unavailable observation', recovery: 'Refresh observation' }],
    });
    const result = validateControllerDecision(fixture.input, candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toContain('TERMINAL_RUN');
  });

  it('validates graph references in immutable execution requests after rehashing', async () => {
    for (const [field, value, code] of [
      ['capability', 'obtain_review_evidence', 'ACTION_BINDING_MISMATCH'],
      ['transition_id', 'undeclared_transition', 'ACTION_TRANSITION_MISMATCH'],
      ['guard_ids', ['undeclared_guard'], 'ACTION_GUARD_MISMATCH'],
    ] as const) {
      const fixture = await readExample('waiting');
      if (fixture.input.execution.status !== 'in_flight') throw new Error('Expected active fixture');
      const envelope = fixture.input.execution.request;
      replaceFixtureValue(envelope.request, [field], value);
      envelope.request_digest = sha256(canonicalJson(envelope.request));
      const result = validateControllerInput(fixture.input);
      expect(result.ok, field).toBe(false);
      if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toContain(code);
    }
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
      const result = validateControllerDecision(
        fixture.input,
        decisionEnvelope(fixture.input, fixture.expected.decision),
      );
      expect(result.ok, drift).toBe(false);
      const blocked = decisionEnvelope(fixture.input, {
        outcome: 'blocked',
        reasons: [
          {
            code: 'EXECUTION_RECONCILIATION_REQUIRED',
            message: 'Active request lost its prerequisites',
            recovery: 'Reconcile existing work',
          },
        ],
      });
      expect(validateControllerDecision(fixture.input, blocked).ok, drift).toBe(true);
    }
  });

  it('requires a nonempty independent proof set for review advancement', async () => {
    const fixture = await readExample('transition_available');
    fixture.input.policy.rules.independent_gate_ids = [];
    fixture.input.policy.digest = sha256(canonicalJson(fixture.input.policy.rules));
    for (const item of fixture.input.receipts) item.workflow_policy.digest = fixture.input.policy.digest;
    const result = validateControllerDecision(
      fixture.input,
      decisionEnvelope(fixture.input, fixture.expected.decision),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toContain('INVALID_PROOF_POLICY');
  });
});

describe('Qodo blocked-reason follow-up', () => {
  it('does not accept an invented proposed digest as conflict evidence', async () => {
    const input = await controllerSnapshot();
    const built = buildActionRequest(input, localProofIntent(input));
    if (!built.ok) throw new Error('Expected request');
    const reference = {
      idempotency_key: built.value.request.idempotency_key,
      request_digest: built.value.request_digest,
    };
    input.existing_requests = [reference];
    const candidate = decisionEnvelope(input, {
      outcome: 'blocked',
      reasons: [
        {
          code: 'IDEMPOTENCY_CONFLICT',
          request: { ...reference, request_digest: sha256('invented proposal') },
          message: 'Conflict',
          recovery: 'Reconcile request',
        },
      ],
    });
    expect(validateControllerDecision(input, candidate).ok).toBe(false);
  });

  it('does not classify an inapplicable phase as unavailable evidence', async () => {
    const input = await controllerSnapshot();
    input.binding.source_state = 'verifying';
    const candidate = decisionEnvelope(input, {
      outcome: 'blocked',
      reasons: [
        { code: 'EVIDENCE_UNAVAILABLE', guard_id: 'pre', message: 'Evidence missing', recovery: 'Restore evidence' },
      ],
    });
    expect(validateControllerDecision(input, candidate).ok).toBe(false);
  });
});

describe('Verifiable blocked evidence', () => {
  it('requires valid proposed contents and a real content difference for conflict', async () => {
    const input = await controllerSnapshot();
    const built = buildActionRequest(input, localProofIntent(input));
    if (!built.ok) throw new Error('Expected request');
    const proposal = structuredClone(built.value);
    input.existing_requests = [
      { idempotency_key: built.value.request.idempotency_key, request_digest: built.value.request_digest },
    ];
    proposal.request.inputs.unshift({ role: 'change_context', artifact: { id: 'context', digest: sha256('context') } });
    proposal.request_digest = sha256(canonicalJson(proposal.request));
    const conflict = () =>
      decisionEnvelope(input, {
        outcome: 'blocked',
        reasons: [
          {
            code: 'IDEMPOTENCY_CONFLICT',
            request: proposal,
            message: 'Different contents for the same logical action',
            recovery: 'Reconcile the existing request',
          },
        ],
      });
    expect(validateControllerDecision(input, conflict()).ok).toBe(true);
    proposal.request_digest = sha256('invented proposal');
    expect(validateControllerDecision(input, conflict()).ok).toBe(false);
    proposal.request_digest = sha256(canonicalJson(proposal.request));
    input.observation.repository!.clean = false;
    expect(validateControllerDecision(input, conflict()).ok).toBe(false);
  });

  it('distinguishes missing proof from an observed failed result', async () => {
    const input = await controllerSnapshot();
    input.binding.source_state = 'verifying';
    const blocked = () =>
      decisionEnvelope(input, {
        outcome: 'blocked',
        reasons: [
          {
            code: 'EVIDENCE_UNAVAILABLE',
            guard_id: 'local_pass',
            message: 'Current gate receipt is absent',
            recovery: 'Collect the current proof',
          },
        ],
      });
    expect(validateControllerDecision(input, blocked()).ok).toBe(true);
    const failed = receipt(input);
    if (failed.payload.type !== 'local_proof') throw new Error('Expected local proof');
    failed.payload.result = 'failed';
    failed.payload_digest = sha256(canonicalJson(failed.payload));
    input.receipts = [failed];
    expect(validateControllerDecision(input, blocked()).ok).toBe(false);
  });
});

describe('Block evidence state identity', () => {
  it('requires block evidence for the current source state', async () => {
    const input = await controllerSnapshot();
    const evidence = receipt(input);
    evidence.payload = {
      type: 'block_evidence',
      prior_state: 'verifying',
      reason: 'Stop',
      recovery: 'Restore proof',
      stop_code: 'PROOF_UNAVAILABLE',
    };
    evidence.payload_digest = sha256(canonicalJson(evidence.payload));
    input.receipts = [evidence];
    const guard = input.compiled_graph.graph.guards.find((guard) => guard.capability === 'block_evidence')!;
    const candidate = () =>
      decisionEnvelope(input, {
        outcome: 'blocked',
        reasons: [
          {
            code: 'EVIDENCE_UNAVAILABLE',
            guard_id: guard.id,
            message: 'No block evidence for the current state',
            recovery: 'Collect block evidence for this state',
          },
        ],
      });
    expect(validateControllerDecision(input, candidate()).ok).toBe(true);
    evidence.payload.prior_state = input.binding.source_state;
    evidence.payload_digest = sha256(canonicalJson(evidence.payload));
    expect(validateControllerDecision(input, candidate()).ok).toBe(false);
  });
});

describe('Graph-declared actor parity', () => {
  it('preserves every catalog capability and actor pair in typed and offline request schemas', async () => {
    const input = await controllerSnapshot();
    const built = buildActionRequest(input, localProofIntent(input));
    if (!built.ok) throw new Error('Expected request');
    const check = new Ajv2020({ strict: true, strictTypes: false, validateFormats: false }).compile(
      publishedControllerSchemas()['action-request']!,
    );
    for (const catalog of compiledPayloadSchema.shape.required_actions.element.options) {
      for (const capability of catalog.shape.capability.options) {
        for (const actor of ['human', 'executor'] as const) {
          const expected = catalog.shape.authority.safeParse(actor).success;
          const request = { ...built.value.request, capability, actor };
          const envelope = { request, request_digest: sha256(canonicalJson(request)) };
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
    expect(
      validateActionRequest(input, { request: disguised, request_digest: sha256(canonicalJson(disguised)) }).ok,
    ).toBe(false);
    const graph = input.compiled_graph.graph;
    const action = graph.required_actions.find((action) => action.id === 'run_gates')!;
    action.authority = 'human';
    input.compiled_graph.graph_digest = sha256(canonicalJson(graph));
    input.binding.graph_digest = input.compiled_graph.graph_digest;
    input.available_capabilities = graph.required_actions.map((action) =>
      actionActorSchema.parse({ capability: action.capability, actor: action.authority }),
    );
    const handoff = buildActionRequest(input, localProofIntent(input));
    expect(handoff.ok).toBe(true);
    if (!handoff.ok) return;
    expect(handoff.value.request.actor).toBe('human');
    expect(
      validateControllerDecision(
        input,
        decisionEnvelope(input, { outcome: 'human_action_required', action_request: handoff.value }),
      ).ok,
    ).toBe(true);
    expect(validateActionRequest(input, executorRequest.value).ok).toBe(false);
  });
});

describe('Proof policy and receipt supersession', () => {
  it('rejects empty gate configuration required by the graph before validating blocked reasons', async () => {
    for (const key of ['local_gate_ids', 'independent_gate_ids'] as const) {
      const fixture = await readExample('transition_available');
      fixture.input.policy.rules[key] = [];
      fixture.input.policy.digest = sha256(canonicalJson(fixture.input.policy.rules));
      for (const item of fixture.input.receipts) item.workflow_policy.digest = fixture.input.policy.digest;
      const input = validateControllerInput(fixture.input);
      expect(input.ok, key).toBe(false);
      const candidate = decisionEnvelope(fixture.input, {
        outcome: 'blocked',
        reasons: [
          {
            code: 'EVIDENCE_UNAVAILABLE',
            guard_id: 'review_set',
            message: 'Proof unavailable',
            recovery: 'Restore proof policy',
          },
        ],
      });
      const result = validateControllerDecision(fixture.input, candidate);
      expect(result.ok, key).toBe(false);
      if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toContain('INVALID_PROOF_POLICY');
    }
    expect(validateControllerInput(await controllerSnapshot('release-to-publish')).ok).toBe(true);
  });

  it('preserves current-state block evidence when another state has a later receipt', async () => {
    const input = await controllerSnapshot();
    const current = receipt(input);
    current.payload = {
      type: 'block_evidence',
      prior_state: input.binding.source_state,
      reason: 'Stop',
      recovery: 'Restore proof',
      stop_code: 'PROOF_UNAVAILABLE',
    };
    current.payload_digest = sha256(canonicalJson(current.payload));
    const other = {
      ...structuredClone(current),
      id: 'other_state_block',
      sequence: 2,
      payload: { ...current.payload, prior_state: 'verifying' },
    };
    other.payload_digest = sha256(canonicalJson(other.payload));
    input.receipts = [current, other];
    const guard = input.compiled_graph.graph.guards.find((guard) => guard.capability === 'block_evidence')!;
    const candidate = decisionEnvelope(input, {
      outcome: 'blocked',
      reasons: [
        {
          code: 'EVIDENCE_UNAVAILABLE',
          guard_id: guard.id,
          message: 'No current block evidence',
          recovery: 'Collect block evidence',
        },
      ],
    });
    const result = validateControllerDecision(input, candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toContain('BLOCKED_REASON_MISMATCH');
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
    const pairs = [
      [
        { type: 'completion_observed', kind: 'publication', destination: 'channel_a' },
        { type: 'completion_observed', kind: 'publication', destination: 'channel_b' },
      ],
      [
        {
          type: 'human_approval',
          scope: 'current_subject',
          approver: { type: 'human', id: 'alice' },
          reason: 'Approved',
        },
        {
          type: 'human_approval',
          scope: 'current_subject',
          approver: { type: 'human', id: 'bob' },
          reason: 'Approved',
        },
      ],
    ] as const;
    for (const [firstPayload, secondPayload] of pairs) {
      const input = await controllerSnapshot();
      const first = { ...receipt(input), payload: firstPayload, payload_digest: sha256(canonicalJson(firstPayload)) };
      const second: ControllerInput['receipts'][number] = {
        ...receipt(input),
        id: 'later_receipt',
        sequence: 2,
        payload: secondPayload,
        payload_digest: sha256(canonicalJson(secondPayload)),
      };
      input.receipts = [first, second];
      expect(validateControllerInput(input).ok).toBe(true);
      expect(currentReceipt(first, input)).toBe(true);
      expect(currentReceipt(second, input)).toBe(true);
      second.payload = firstPayload;
      second.payload_digest = first.payload_digest;
      expect(currentReceipt(first, input)).toBe(false);
    }
  });
});
