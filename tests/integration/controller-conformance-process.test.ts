import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';

const root = import.meta.dirname + '/../..';
const versions = {
  protocol: 'threadloop.controller-conformance/0.1',
  fixture_schema: 'threadloop.conformance-fixture/0.1',
  canonicalization: 'threadloop.conformance-json/0.1',
  digest_profile: 'threadloop.conformance-sha256/0.1',
};
const profile = {
  schema_version: '0.1',
  profile: { id: 'folio', revision: 1 },
  initial_state: 'drafted',
  states: [
    { id: 'drafted', kind: 'active' },
    { id: 'checked', kind: 'active' },
    { id: 'issued', kind: 'terminal' },
  ],
  transitions: [
    { id: 'check_folio', from: 'drafted', to: 'checked', priority: 0, guard_refs: [], authority: ['threadloop'] },
    {
      id: 'issue_folio',
      from: 'checked',
      to: 'issued',
      guard_refs: ['approval', 'publication'],
      authority: ['threadloop', 'human'],
    },
  ],
  guards: [
    {
      id: 'approval',
      capability: 'human_approval',
      parameters: { scope: 'current_subject' },
      required_actions: ['authorize'],
    },
    { id: 'publication', capability: 'completion_observed', parameters: { kind: 'publication' } },
  ],
  required_actions: [{ id: 'authorize', capability: 'approve_change', authority: 'human', parameters: {} }],
};
const graphDigest = '24c18e7fb1b5dbaa0ffb1e2d7fe9e68c32dff2660effe54dff3b72f68c66799a';
const identitySchema = z.strictObject({
  name: z.string(),
  version: z.string(),
  revision: z.string(),
  artifact_digest: z.string(),
});
const envelopeSchema = z.strictObject({
  response: z.strictObject({
    protocol: z.literal(versions.protocol),
    fixture_schema: z.literal(versions.fixture_schema),
    canonicalization: z.literal(versions.canonicalization),
    digest_profile: z.literal(versions.digest_profile),
    schema: z.literal('threadloop.conformance-response/0.1'),
    request_digest: z.string(),
    subject: identitySchema,
    result: z.record(z.string(), z.unknown()),
  }),
  response_digest: z.string(),
});

function request(
  operation: string,
  input: unknown,
  case_id = 'case_900',
  corpus_digest = sha256('independent graph examples'),
) {
  const payload = {
    ...versions,
    schema: 'threadloop.conformance-request/0.1',
    operation,
    case_id,
    corpus_digest,
    input,
    input_digest: sha256(canonicalJson(input)),
  };
  return { request: payload, request_digest: sha256(canonicalJson(payload)) };
}

function snapshot(compiled: unknown, digest = graphDigest) {
  const subject = { kind: 'repository', repository_id: 'folio', revision: 'r1', content_digest: sha256('folio r1') };
  const rules = {
    selection: 'threadloop.remedies/0.1',
    proof_plan: null,
    proof_binding_transition_id: null,
    repository_binding: { branch: 'folio', baseline: subject },
    publication_destination: null,
    local_gate_ids: [],
    independent_gate_ids: [],
    evidence_policies: [],
    authorities: ['threadloop', 'human'].map((type) => ({ type, identity: { id: type, digest: sha256(type) } })),
  };
  return {
    schema_version: '0.1',
    compiled_graph: compiled,
    binding: {
      workflow_run_id: 'folio-run',
      graph_schema_version: '0.1',
      graph_digest: digest,
      source_state: 'drafted',
      state_version: 1,
      subject,
    },
    observation: {
      id: 'workspace',
      subject,
      state_version: 1,
      status: 'verified',
      valid_until: null,
      repository: { branch: 'folio', clean: true, change_scope: 'within_plan', basis: subject, relationship: 'equal' },
    },
    history: {
      status: 'verified',
      digest: sha256('history'),
      proof_plan_bound: false,
      phase: null,
      budget_counts: [],
      prior_state: null,
      implementation_basis: subject,
      repair_admission: null,
    },
    policy: { id: 'folio', rules, digest: sha256(canonicalJson(rules)) },
    available_capabilities: [{ actor: 'human', capability: 'approve_change' }],
    receipts: [],
    invalidated_claims: [],
    execution: { status: 'idle' },
    existing_requests: [],
    evaluation_time: '2026-01-01T00:00:00.000Z',
  };
}

describe('external controller process', () => {
  let scratch: string;
  let output: string;
  let bundle: string;
  let identity: z.infer<typeof identitySchema>;
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'threadloop-controller-'));
    output = join(scratch, 'build');
    execFileSync(process.execPath, ['scripts/controller-conformance/build.mjs', '--output', output], {
      cwd: root,
      timeout: 25000,
    });
    bundle = join(output, 'runtime/scripts/executor-contract/subject.mjs');
    identity = identitySchema.parse(JSON.parse(readFileSync(join(output, 'identity.json'), 'utf8')));
    renameSync(join(output, 'identity.json'), join(scratch, 'operator-identity.json'));
  });
  afterAll(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });
  function invoke(input: string, verb = 'conformance') {
    return spawnSync(process.execPath, [bundle, verb], {
      input,
      cwd: scratch,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 17 * 1024 * 1024,
    });
  }
  function exchange(message: ReturnType<typeof request>, framing = '') {
    const processResult = invoke(canonicalJson(message) + framing);
    expect(processResult.status, processResult.stderr).toBe(0);
    const body = envelopeSchema.parse(JSON.parse(processResult.stdout));
    expect(processResult.stdout).toBe(canonicalJson(body) + '\n');
    expect(body.response_digest).toBe(sha256(canonicalJson(body.response)));
    expect(body.response.subject).toEqual(identity);
    expect(body.response.request_digest).toBe(message.request_digest);
    return body.response.result;
  }
  it('compiles the supplied graph and binds the response to independently measured runtime bytes', () => {
    const result = exchange(request('compile_graph', profile), '\n');
    expect(result).toMatchObject({
      status: 'compiled',
      compiled_graph: { graph_digest: graphDigest, graph: { initial_state: 'drafted', profile: { id: 'folio' } } },
    });
    const relabeled = request('compile_graph', profile, 'case_901');
    expect(relabeled.request_digest).not.toBe(request('compile_graph', profile).request_digest);
    expect(exchange(relabeled)).toEqual(result);
    const reordered = exchange(
      request(
        'compile_graph',
        { ...profile, states: [...profile.states].reverse(), transitions: [...profile.transitions].reverse() },
        'case_901',
        sha256('another graph corpus'),
      ),
    );
    expect(reordered).toEqual(result);
    const files = [
      'docs/contracts/executor-v0.1/upstream/gaap/agent-run-request.schema.json',
      'docs/contracts/executor-v0.1/upstream/gaap/terminal-run-receipt.schema.json',
      'scripts/executor-contract/subject.mjs',
    ];
    const manifest = files.map((path) => {
      const bytes = readFileSync(join(output, 'runtime', path));
      return { bytes: bytes.length, path, sha256: sha256(bytes) };
    });
    expect(JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'))).toEqual(manifest);
    expect(identity.artifact_digest).toBe(sha256(canonicalJson(manifest)));
    expect(identity.name).toBe('threadloop-controller');
    const commit = identity.revision.replace(/-dirty$/, '');
    expect(commit).toMatch(/^[a-f0-9]+$/);
    expect([40, 64]).toContain(commit.length);
    execFileSync('git', ['cat-file', '-e', commit + '^{commit}'], { cwd: root });
  });
  it('preserves the ordered machine diagnostics of a domain-invalid graph', () => {
    const graph = { ...profile, initial_state: 'issued' };
    expect(exchange(request('compile_graph', graph))).toEqual({
      status: 'invalid',
      diagnostics: [
        { code: 'INVALID_INITIAL_STATE', path: '$.initial_state', identifier: 'issued' },
        { code: 'UNREACHABLE_STATE', path: '$.states[0]', identifier: 'drafted' },
        { code: 'UNREACHABLE_STATE', path: '$.states[1]', identifier: 'checked' },
      ],
    });
  });
  it('selects from the supplied run, including a terminal state and a mismatched binding', () => {
    const compiled = exchange(request('compile_graph', profile)).compiled_graph;
    const input = snapshot(compiled);
    const decision = exchange(request('decide', input));
    expect(decision).toMatchObject({
      status: 'decision',
      decision: { decision: { outcome: 'transition_available', transition_id: 'check_folio' } },
    });
    expect(
      exchange(request('decide', { ...input, binding: { ...input.binding, source_state: 'issued' } })),
    ).toMatchObject({ status: 'decision', decision: { decision: { outcome: 'terminal', terminal_state: 'issued' } } });
    expect(
      exchange(request('decide', { ...input, binding: { ...input.binding, graph_digest: '0'.repeat(64) } })),
    ).toEqual({
      status: 'invalid',
      diagnostics: [{ code: 'BINDING_MISMATCH', path: '$.graph_digest', identifier: 'folio' }],
    });
  });
  it('requests a human handoff for one applicable restoration and blocks equivalent restorations', () => {
    for (const actions of [['restore_folio'], ['restore_folio', 'restore_checked_folio']]) {
      const profileWithRestoration = {
        ...profile,
        guards: [
          ...profile.guards,
          {
            id: 'on_branch',
            capability: 'repository',
            parameters: { condition: 'clean_plan_branch' },
            required_actions: actions,
          },
        ],
        transitions: profile.transitions.map((edge) =>
          edge.id === 'check_folio' ? { ...edge, guard_refs: ['on_branch'], authority: ['threadloop', 'human'] } : edge,
        ),
        required_actions: [
          ...profile.required_actions,
          ...actions.map((id) => ({ id, capability: 'restore_repository', authority: 'human', parameters: {} })),
        ],
      };
      const compiled = exchange(request('compile_graph', profileWithRestoration)).compiled_graph;
      const { graph_digest } = z.object({ graph_digest: z.string() }).parse(compiled);
      const input = snapshot(compiled, graph_digest);
      input.observation.repository.branch = 'different-branch';
      input.available_capabilities.push({ actor: 'human', capability: 'restore_repository' });
      const decision = exchange(request('decide', input));
      const expected =
        actions.length === 1
          ? {
              outcome: 'human_action_required',
              action_request: { request: { action_id: 'restore_folio', capability: 'restore_repository' } },
            }
          : { outcome: 'blocked', reasons: [{ code: 'AMBIGUOUS_REMEDY' }] };
      expect(decision).toMatchObject({ status: 'decision', decision: { decision: expected } });
    }
  });
  it('uses lexical ordering for integer-looking object keys in wire digests', () => {
    const message = request('compile_graph', { '10': true, '2': false });
    const literal = '{"10":true,"2":false}';
    const payload = { ...message.request, input_digest: sha256(literal) };
    const content = canonicalJson(payload).replace('{"2":false,"10":true}', literal);
    const requestDigest = sha256(content);
    const result = invoke('{"request":' + content + ',"request_digest":' + JSON.stringify(requestDigest) + '}');
    expect(result.status, result.stderr).toBe(0);
    const response = envelopeSchema.parse(JSON.parse(result.stdout));
    expect(response.response.request_digest).toBe(requestDigest);
    expect(response.response.result.status).toBe('invalid');
  });
  it('rejects malformed framing and mismatched digests before emitting a response', () => {
    const message = request('compile_graph', profile);
    const invalidInput = { ...message.request, input_digest: '0'.repeat(64) };
    const unknownVersion = { ...message.request, protocol: 'threadloop.controller-conformance/2' };
    const wire = canonicalJson(message);
    for (const [input, reason] of [
      [wire + '\n\n', 'request framing'],
      [wire.replace('"case_id":', '"case_id":"case_900","case_id":'), 'request framing'],
      [canonicalJson({ ...message, request_digest: '0'.repeat(64) }), 'request digest'],
      [
        canonicalJson({ request: invalidInput, request_digest: sha256(canonicalJson(invalidInput)) }),
        'input or request digest',
      ],
      [
        canonicalJson({ request: unknownVersion, request_digest: sha256(canonicalJson(unknownVersion)) }),
        'request envelope',
      ],
      [canonicalJson({ ...message, extra: 1 }), 'request envelope'],
      ['x'.repeat(16 * 1024 * 1024 + 2), 'message byte limit'],
    ] as const) {
      const refused = invoke(input);
      expect(refused.status, refused.stderr).toBe(1);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).toContain(reason);
    }
  });
});
