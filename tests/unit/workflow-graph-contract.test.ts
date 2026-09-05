import { readFile, readdir } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { parseWorkflowProfile } from '../../scripts/workflow-graph/parser.js';
import { publishedSchemas, type WorkflowProfile } from '../../scripts/workflow-graph/contracts.js';
import { compileWorkflowProfile, validateGraphBinding } from '../../scripts/workflow-graph/compiler.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { z } from 'zod';
import { TASK_STATUS_VALUES } from '../../src/domain/types.js';
import { isForwardLifecycleTransition, REPAIR_ENTRY_STATES } from '../../src/domain/lifecycle.js';

const bundle = new URL('../../docs/contracts/workflow-graph-v0.1/', import.meta.url);

async function readProfile(name: string) {
  const result = parseWorkflowProfile(await readFile(new URL(`fixtures/valid/${name}.yaml`, bundle), 'utf8'));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.value;
}

describe('Governed PR preservation', () => {
  it('keeps proof, phase, review, and human boundaries on every ordinary edge', async () => {
    const profile = await readProfile('governed-pr');
    const requirements: Record<string, string[]> = {
      frame: [],
      bind_plan: ['plan'],
      begin_implementation: ['plan', 'baseline'],
      verify_implementation: ['plan', 'work_committed'],
      retry_failed_proof: ['plan', 'pre', 'checkout', 'local_fail'],
      retry_review_changes: ['plan', 'pre', 'checkout', 'review_changes'],
      enter_pre_pr_review: ['plan', 'pre', 'checkout', 'local_pass', 'independent'],
      return_to_review: ['plan', 'post', 'checkout', 'local_pass', 'independent'],
      repair_failed_proof: ['plan', 'post', 'local_fail', 'repair_available'],
      address_pre_pr_review: ['plan', 'pre', 'checkout', 'review_changes'],
      enter_review: ['plan', 'pre', 'checkout', 'review_clean', 'local_pass', 'independent'],
      repair_review: ['review_current', 'review_blocking', 'repair_available'],
      human_handoff: ['review_current', 'review_clear', 'review_set'],
      verify_repair: ['plan', 'repair_committed'],
      repair_late_review: ['review_current', 'review_blocking', 'repair_available'],
      complete: ['review_current', 'review_clear', 'review_set', 'approval', 'merged'],
    };
    const ordinary = profile.transitions.filter((edge) => edge.from !== 'blocked' && edge.to !== 'blocked');
    expect(ordinary.map((edge) => edge.id).sort()).toEqual(Object.keys(requirements).sort());
    for (const edge of ordinary)
      expect([...edge.guard_refs].sort(), edge.id).toEqual([...requirements[edge.id]!].sort());
    const expectedParameters: Record<string, { capability: string; parameters: object }> = {
      plan: { capability: 'proof_plan_bound', parameters: {} },
      baseline: { capability: 'repository', parameters: { condition: 'baseline_matches' } },
      work_committed: { capability: 'repository', parameters: { condition: 'clean_descendant' } },
      checkout: { capability: 'repository', parameters: { condition: 'clean_plan_branch' } },
      repair_committed: { capability: 'repository', parameters: { condition: 'committed_repair' } },
      pre: { capability: 'phase', parameters: { value: 'pre_pr' } },
      post: { capability: 'phase', parameters: { value: 'post_pr' } },
      local_pass: { capability: 'local_proof', parameters: { result: 'passed' } },
      local_fail: { capability: 'local_proof', parameters: { result: 'failed' } },
      independent: { capability: 'independent_proof', parameters: {} },
      review_changes: { capability: 'pre_pr_review', parameters: { outcome: 'changes_required' } },
      review_clean: { capability: 'pre_pr_review', parameters: { outcome: 'clean' } },
      review_current: { capability: 'review', parameters: { condition: 'current' } },
      review_blocking: { capability: 'review', parameters: { condition: 'blocking' } },
      review_clear: { capability: 'review', parameters: { condition: 'clear' } },
      review_set: { capability: 'review', parameters: { condition: 'proof_set_current' } },
      repair_available: { capability: 'budget_available', parameters: { budget: 'repair_entries' } },
      approval: { capability: 'human_approval', parameters: { scope: 'current_subject' } },
      merged: { capability: 'completion_observed', parameters: { kind: 'merge' } },
    };
    for (const [id, expected] of Object.entries(expectedParameters))
      expect(
        profile.guards.find((guard) => guard.id === id),
        id,
      ).toMatchObject(expected);
  });

  it('retains blocking and recorded-prior-state recovery for every active state', async () => {
    const profile = await readProfile('governed-pr');
    for (const state of profile.states.filter((candidate) => candidate.kind === 'active')) {
      expect(profile.transitions.find((edge) => edge.from === state.id && edge.to === 'blocked')).toMatchObject({
        guard_refs: ['block'],
      });
      expect(profile.transitions.find((edge) => edge.from === 'blocked' && edge.to === state.id)).toMatchObject({
        guard_refs: ['recovery', `prior_${state.id}`],
        authority: ['threadloop', 'human'],
      });
      expect(profile.guards.find((guard) => guard.id === `prior_${state.id}`)).toMatchObject({
        capability: 'recorded_prior_state',
        parameters: { state: state.id },
      });
    }
    expect(profile.transitions.filter((edge) => edge.from === 'completed')).toEqual([]);
    expect(profile.cycle_controls).toContainEqual({
      id: 'pre_pr_escape',
      kind: 'human_escape',
      transition_refs: ['verify_implementation', 'retry_failed_proof', 'retry_review_changes', 'address_pre_pr_review'],
      exit_transition_refs: ['block_implementing', 'block_verifying', 'block_pre_pr_reviewing'],
    });
  });

  it('maps every preservation requirement, required-work code, and receipt family to an explicit contract', async () => {
    const profile = await readProfile('governed-pr');
    const manifestSchema = z.strictObject({
      inspected_commit: z.string().regex(/^[a-f0-9]{40}$/),
      requirements: z.array(
        z.strictObject({
          id: z.string(),
          guard_refs: z.array(z.string()),
          transition_refs: z.array(z.string()),
          budget_refs: z.array(z.string()),
          runtime_obligation: z.string().min(1),
          future_conformance_issue: z.literal(108),
        }),
      ),
      required_work: z.array(z.strictObject({ code: z.string(), action: z.string() })),
      receipt_families: z.array(z.strictObject({ family: z.string(), guard_refs: z.array(z.string()) })),
    });
    const raw: unknown = JSON.parse(await readFile(new URL('preservation.json', bundle), 'utf8'));
    const manifest = manifestSchema.parse(raw);
    expect(manifest.requirements.map((item) => item.id)).toEqual([
      'all_states',
      'monotonic_phase',
      'pre_pr_review_boundary',
      'post_pr_implementation_boundary',
      'current_subject_evidence',
      'provider_boundary',
      'setup_failure',
      'repair_budget',
      'blocked_recovery',
      'completion_terminal',
      'audit_idempotency',
      'existing_sessions',
    ]);
    for (const item of manifest.requirements) {
      for (const ref of item.guard_refs)
        expect(
          profile.guards.some((guard) => guard.id === ref),
          item.id,
        ).toBe(true);
      for (const ref of item.transition_refs)
        expect(
          profile.transitions.some((edge) => edge.id === ref),
          item.id,
        ).toBe(true);
      for (const ref of item.budget_refs)
        expect(
          profile.budgets?.some((budget) => budget.id === ref),
          item.id,
        ).toBe(true);
    }
    const mapping = await readFile(new URL('../../docs/current-lifecycle-graph-mapping.md', import.meta.url), 'utf8');
    const table =
      mapping.split('## Guard And Required Work Mapping')[1]?.split('## Receipt And Observation Mapping')[0] ?? '';
    const mappedCodes = [
      ...new Set(
        table
          .split('\n')
          .filter((line) => line.startsWith('|'))
          .flatMap((line) => [...(line.split('|')[3] ?? '').matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((match) => match[1])),
      ),
    ].sort();
    expect(mappedCodes.length).toBeGreaterThan(20);
    expect(manifest.required_work.map((item) => item.code).sort()).toEqual(mappedCodes);
    for (const item of manifest.required_work)
      expect(
        profile.required_actions.some((action) => action.id === item.action),
        item.code,
      ).toBe(true);
    expect(manifest.receipt_families.map((item) => item.family)).toEqual([
      'proof_plan',
      'local_gate',
      'independent_proof',
      'pre_pr_review',
      'signed_review',
      'repository_observation',
      'audit_event',
    ]);
    for (const item of manifest.receipt_families)
      for (const ref of item.guard_refs)
        expect(
          profile.guards.some((guard) => guard.id === ref),
          item.family,
        ).toBe(true);
  });
  it('maps all current states and structural forward transitions', async () => {
    const profile = await readProfile('governed-pr');
    expect(profile.states.map((state) => state.id).sort()).toEqual([...TASK_STATUS_VALUES].sort());
    const expected = TASK_STATUS_VALUES.flatMap((from) =>
      TASK_STATUS_VALUES.filter((to) => isForwardLifecycleTransition(from, to)).map((to) => `${from}:${to}`),
    ).sort();
    const mapped = [
      ...new Set(
        profile.transitions
          .filter((edge) => edge.from !== 'blocked' && edge.to !== 'blocked')
          .map((edge) => `${edge.from}:${edge.to}`),
      ),
    ].sort();
    expect(mapped).toEqual(expected);
  });

  it('retains monotonic history phases and the exact counted repair entries', async () => {
    const profile = await readProfile('governed-pr');
    expect(profile.phase_policy).toEqual({
      kind: 'entered_state',
      initial: 'pre_pr',
      advanced: 'post_pr',
      monotonic: true,
      include_audit_genesis: true,
      state_refs: ['reviewing', 'ready_for_human', 'completed'],
    });
    expect(profile.budgets).toHaveLength(1);
    const budget = profile.budgets?.[0];
    expect(budget?.limit).toBe(3);
    expect(
      profile.transitions
        .filter((edge) => budget?.transition_refs.includes(edge.id))
        .map((edge) => `${edge.from}:${edge.to}`)
        .sort(),
    ).toEqual(REPAIR_ENTRY_STATES.map((state) => `${state}:repairing`).sort());
  });

  it('represents a distinct release and publication lifecycle without PR-specific capabilities', async () => {
    const profile = await readProfile('release-to-publish');
    expect(profile.states.map((state) => state.id)).toEqual([
      'preparing',
      'verifying',
      'awaiting_approval',
      'publishing',
      'publication_check',
      'blocked',
      'completed',
    ]);
    expect(profile.phase_policy).toBeUndefined();
    expect(
      profile.guards.some(
        (guard) =>
          guard.capability === 'pre_pr_review' || guard.capability === 'phase' || guard.capability === 'review',
      ),
    ).toBe(false);
    expect(profile.required_actions.map((action) => action.capability)).toEqual(
      expect.arrayContaining(['prepare_release', 'verify_release', 'publish_release', 'verify_publication']),
    );
  });
});

describe('Published fixture corpus', () => {
  it('checks every valid YAML profile against fixed canonical bytes, schemas, digests, and binding', async () => {
    const entries = await readdir(new URL('fixtures/valid/', bundle));
    const profiles = entries.filter((name) => name.endsWith('.yaml')).sort();
    expect(profiles.length).toBeGreaterThan(0);
    const schemas = publishedSchemas();
    const ajv = new Ajv2020({ strict: true });
    const graphValidator = ajv.compile(schemas['compiled-graph']!);
    const profileValidator = ajv.compile(schemas['workflow-profile']!);
    const bindingValidator = ajv.compile(schemas['graph-binding']!);
    for (const file of profiles) {
      const stem = file.slice(0, -5);
      const read = (suffix: string) => readFile(new URL(`fixtures/valid/${stem}${suffix}`, bundle), 'utf8');
      const source = await read('.yaml');
      const parsed = parseWorkflowProfile(source);
      expect(parsed.ok, file).toBe(true);
      if (parsed.ok) expect(profileValidator(parsed.value), file).toBe(true);
      const result = compileWorkflowProfile(source);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) continue;
      const expected: unknown = JSON.parse(await read('.compiled.json'));
      expect(result.value, file).toEqual(expected);
      expect(canonicalJson(result.value.graph), file).toBe(await read('.canonical'));
      expect(graphValidator(expected), JSON.stringify(graphValidator.errors)).toBe(true);
      const binding: unknown = JSON.parse(await read('.binding.json'));
      expect(bindingValidator(binding)).toBe(true);
      expect(validateGraphBinding(binding, expected)).toEqual(result);
    }
  });

  it('checks every invalid YAML file for its specified rejection, without returning a graph', async () => {
    const validator = new Ajv2020({ strict: true }).compile(publishedSchemas()['workflow-profile']!);
    const expectedSchema = z.array(z.strictObject({ file: z.string(), expected_code: z.string() }));
    const manifest: unknown = JSON.parse(await readFile(new URL('fixtures/invalid/expected.json', bundle), 'utf8'));
    const expected = expectedSchema.parse(manifest);
    const files = (await readdir(new URL('fixtures/invalid/', bundle))).filter((file) => file.endsWith('.yaml')).sort();
    expect(expected.map((item) => item.file).sort()).toEqual(files);
    for (const item of expected) {
      const source = await readFile(new URL(`fixtures/invalid/${item.file}`, bundle), 'utf8');
      if (item.expected_code !== 'YAML_INVALID') {
        const raw: unknown = parse(source);
        const structurallyInvalid =
          item.expected_code === 'SCHEMA_INVALID' || item.expected_code === 'UNSUPPORTED_VERSION';
        expect(validator(raw), item.file).toBe(!structurallyInvalid);
      }
      const result = compileWorkflowProfile(source);
      expect(result.ok, item.file).toBe(false);
      expect(result).not.toHaveProperty('value');
      if (!result.ok) {
        expect(
          result.diagnostics.map((entry) => entry.code),
          item.file,
        ).toContain(item.expected_code);
        for (const error of result.diagnostics) {
          expect(error.path).toMatch(/^\$/);
          expect(error.message.length).toBeGreaterThan(0);
          expect(error.recovery.length).toBeGreaterThan(0);
        }
      }
      expect(compileWorkflowProfile(source)).toEqual(result);
    }
  });
});

function minimalProfile(): WorkflowProfile {
  return {
    schema_version: '0.1',
    profile: { id: 'release_example', revision: 1 },
    initial_state: 'prepared',
    states: [
      { id: 'prepared', kind: 'active' },
      { id: 'completed', kind: 'terminal' },
    ],
    transitions: [
      {
        id: 'finish',
        from: 'prepared',
        to: 'completed',
        guard_refs: ['approval', 'published'],
        authority: ['threadloop', 'human'],
      },
    ],
    guards: [
      {
        id: 'approval',
        capability: 'human_approval',
        parameters: { scope: 'current_subject' },
        required_actions: ['approve'],
      },
      { id: 'published', capability: 'completion_observed', parameters: { kind: 'publication' } },
    ],
    required_actions: [{ id: 'approve', capability: 'approve_change', authority: 'human', parameters: {} }],
  };
}

describe('Workflow Profile authoring', () => {
  it('publishes reproducible Draft 2020-12 schemas usable by an independent validator', async () => {
    const ajv = new Ajv2020({ strict: true });
    for (const [name, generated] of Object.entries(publishedSchemas())) {
      const published: unknown = JSON.parse(await readFile(new URL(`schemas/${name}.schema.json`, bundle), 'utf8'));
      expect(published).toEqual(generated);
      expect(ajv.validateSchema(generated)).toBe(true);
      const validate = ajv.compile(generated);
      if (name === 'workflow-profile') {
        expect(validate(minimalProfile()), JSON.stringify(validate.errors)).toBe(true);
        expect(validate({ ...minimalProfile(), command: 'echo unauthorized' })).toBe(false);
      }
    }
  });
  it('accepts a provider-neutral release profile', () => {
    expect(parseWorkflowProfile(stringify(minimalProfile())).ok).toBe(true);
  });

  it.each([
    ['unknown schema', stringify({ ...minimalProfile(), schema_version: '0.2' })],
    ['numeric schema', stringify({ ...minimalProfile(), schema_version: 0.1 })],
    ['unknown field', stringify({ ...minimalProfile(), command: 'echo unauthorized' })],
    ['duplicate keys', 'schema_version: "0.1"\nschema_version: "0.1"'],
    ['multiple documents', '---\na: 1\n---\na: 2'],
    ['alias', 'a: &shared [1]\nb: *shared'],
    ['custom tag', 'a: !execute command'],
    ['merge key', 'a: { <<: { b: 1 } }'],
    ['non-string key', '1: value'],
    ['non-finite scalar', 'a: .inf'],
  ])('rejects %s without returning a profile', (_label, source) => {
    const result = parseWorkflowProfile(source);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('value');
  });
});

function compile(profile: WorkflowProfile) {
  return compileWorkflowProfile(stringify(profile, { aliasDuplicateObjects: false }));
}

function compiled(profile = minimalProfile()) {
  const result = compile(profile);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.value;
}

function cyclicProfile(): WorkflowProfile {
  const profile = minimalProfile();
  profile.states.push({ id: 'blocked', kind: 'suspended', handoff: 'recover' });
  profile.required_actions.push({ id: 'recover', capability: 'recover_run', authority: 'human', parameters: {} });
  profile.guards.push(
    { id: 'block', capability: 'block_evidence', parameters: {} },
    { id: 'recovery', capability: 'human_approval', parameters: { scope: 'recovery' }, required_actions: ['recover'] },
    { id: 'prior', capability: 'recorded_prior_state', parameters: { state: 'prepared' } },
  );
  profile.transitions[0]!.priority = 10;
  profile.transitions.push(
    { id: 'repeat', from: 'prepared', to: 'prepared', priority: 1, guard_refs: [], authority: ['threadloop'] },
    { id: 'stop', from: 'prepared', to: 'blocked', priority: 0, guard_refs: ['block'], authority: ['threadloop'] },
    {
      id: 'resume',
      from: 'blocked',
      to: 'prepared',
      guard_refs: ['recovery', 'prior'],
      authority: ['threadloop', 'human'],
    },
  );
  profile.cycle_controls = [
    { id: 'escape', kind: 'human_escape', transition_refs: ['repeat'], exit_transition_refs: ['stop'] },
  ];
  return profile;
}

describe('Cycle control contracts', () => {
  it.each(['blocked', 'completed'])('rejects an unused recorded prior-state guard naming %s', (state) => {
    const profile = cyclicProfile();
    profile.guards.push({ id: 'invalid_prior', capability: 'recorded_prior_state', parameters: { state } });
    expect(compile(profile)).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'INVALID_PRIOR_STATE', identifier: 'invalid_prior' }],
    });
  });
  it('requires a run to begin in an active state', () => {
    const profile = minimalProfile();
    profile.initial_state = 'completed';
    profile.states = [{ id: 'completed', kind: 'terminal' }];
    profile.transitions = [];
    expect(compile(profile).ok).toBe(false);
  });

  it('rejects recovery to another suspension rather than an active prior state', () => {
    const profile = cyclicProfile();
    profile.guards.push({ id: 'prior_block', capability: 'recorded_prior_state', parameters: { state: 'blocked' } });
    profile.transitions.find((edge) => edge.id === 'resume')!.priority = 0;
    profile.transitions.push({
      id: 'resume_block',
      from: 'blocked',
      to: 'blocked',
      priority: 1,
      authority: ['threadloop', 'human'],
      guard_refs: ['recovery', 'prior_block', 'block'],
    });
    expect(compile(profile).ok).toBe(false);
  });
  it('allows repeated engineering work with an explicit human escape and guarded recovery', () => {
    expect(compile(cyclicProfile()).ok).toBe(true);
  });

  it("rejects a subcycle bypassing another cycle's escape", () => {
    const profile = cyclicProfile();
    profile.states.push({ id: 'inner', kind: 'active' });
    profile.transitions.push(
      { id: 'enter_inner', from: 'prepared', to: 'inner', priority: 2, guard_refs: [], authority: ['threadloop'] },
      { id: 'leave_inner', from: 'inner', to: 'prepared', priority: 0, guard_refs: [], authority: ['threadloop'] },
      { id: 'inner_loop', from: 'inner', to: 'inner', priority: 1, guard_refs: [], authority: ['threadloop'] },
    );
    expect(compile(profile)).toMatchObject({ ok: false, diagnostics: [{ code: 'UNCONTROLLED_CYCLE' }] });
  });

  it.each(['human_escape', 'terminal_route', 'guard_stop'] as const)(
    'does not let a %s control certify an unlisted self-loop at the same source',
    (kind) => {
      const profile = cyclicProfile();
      if (kind === 'terminal_route') {
        profile.transitions.find((edge) => edge.id === 'finish')!.priority = 0;
        profile.transitions.find((edge) => edge.id === 'stop')!.priority = 10;
        profile.cycle_controls = [
          { id: 'escape', kind, transition_refs: ['repeat'], exit_transition_refs: ['finish'] },
        ];
      } else if (kind === 'guard_stop') {
        profile.guards.push({ id: 'requested', capability: 'stop_requested', parameters: {} });
        profile.transitions.find((edge) => edge.id === 'stop')!.guard_refs.push('requested');
        profile.cycle_controls = [
          { id: 'escape', kind, guard: 'requested', transition_refs: ['repeat'], exit_transition_refs: ['stop'] },
        ];
      }
      profile.transitions.push({
        id: 'uncontrolled_repeat',
        from: 'prepared',
        to: 'prepared',
        priority: 2,
        guard_refs: [],
        authority: ['threadloop'],
      });
      expect(compile(profile)).toMatchObject({ ok: false, diagnostics: [{ code: 'UNCONTROLLED_CYCLE' }] });
    },
  );

  it('rejects an overlapping cycle that bypasses a listed repeat at its source', () => {
    const profile = cyclicProfile();
    profile.states.push({ id: 'inner', kind: 'active' });
    profile.transitions.push(
      { id: 'enter_inner', from: 'prepared', to: 'inner', priority: 2, guard_refs: [], authority: ['threadloop'] },
      { id: 'leave_inner', from: 'inner', to: 'prepared', guard_refs: [], authority: ['threadloop'] },
    );
    expect(compile(profile)).toMatchObject({ ok: false, diagnostics: [{ code: 'UNCONTROLLED_CYCLE' }] });
  });

  it('rejects a stop route that loses priority to the controlled repeat', () => {
    const profile = cyclicProfile();
    profile.transitions.find((edge) => edge.id === 'stop')!.priority = 2;
    const result = compile(profile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toContain('INVALID_CYCLE_CONTROL');
  });

  it('accepts a finite entry budget and rejects an exit requiring the exhausted budget', () => {
    const profile = cyclicProfile();
    profile.budgets = [{ id: 'repairs', limit: 3, transition_refs: ['repeat'] }];
    profile.guards.push({ id: 'remaining', capability: 'budget_available', parameters: { budget: 'repairs' } });
    profile.transitions.find((edge) => edge.id === 'repeat')!.guard_refs = ['remaining'];
    profile.cycle_controls = [{ id: 'bounded', kind: 'budget', budget: 'repairs', exit_transition_refs: ['stop'] }];
    expect(compile(profile).ok).toBe(true);
    profile.budgets[0]!.transition_refs.push('stop');
    profile.transitions.find((edge) => edge.id === 'stop')!.guard_refs.push('remaining');
    const result = compile(profile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toContain('INVALID_CYCLE_CONTROL');
  });

  it('rejects an unguarded counted entry', () => {
    const profile = cyclicProfile();
    profile.budgets = [{ id: 'repairs', limit: 3, transition_refs: ['repeat'] }];
    expect(compile(profile)).toMatchObject({ ok: false, diagnostics: [{ code: 'INVALID_BUDGET' }] });
  });

  it('requires actual guard-stop and terminal routes', () => {
    const profile = cyclicProfile();
    profile.transitions.find((edge) => edge.id === 'finish')!.priority = 0;
    profile.transitions.find((edge) => edge.id === 'stop')!.priority = 10;
    profile.cycle_controls = [
      { id: 'finish_route', kind: 'terminal_route', transition_refs: ['repeat'], exit_transition_refs: ['finish'] },
    ];
    expect(compile(profile).ok).toBe(true);
    profile.cycle_controls = [
      {
        id: 'stop_route',
        kind: 'guard_stop',
        guard: 'approval',
        transition_refs: ['repeat'],
        exit_transition_refs: ['stop'],
      },
    ];
    expect(compile(profile).ok).toBe(false);
    profile.guards.push({ id: 'requested', capability: 'stop_requested', parameters: {} });
    profile.transitions.find((edge) => edge.id === 'finish')!.priority = 10;
    profile.transitions.find((edge) => edge.id === 'stop')!.priority = 0;
    profile.transitions.find((edge) => edge.id === 'stop')!.guard_refs.push('requested');
    profile.cycle_controls = [
      {
        id: 'stop_route',
        kind: 'guard_stop',
        guard: 'requested',
        transition_refs: ['repeat'],
        exit_transition_refs: ['stop'],
      },
    ];
    expect(compile(profile).ok).toBe(true);
  });

  it('rejects human recovery to an unrecorded target', () => {
    const profile = cyclicProfile();
    profile.transitions.find((edge) => edge.id === 'resume')!.guard_refs = ['recovery'];
    expect(compile(profile)).toMatchObject({ ok: false, diagnostics: [{ code: 'RECOVERY_AUTHORITY_REQUIRED' }] });
  });
});

describe('Graph identity', () => {
  it('normalizes the order of explicit cycle and budget transition references', async () => {
    const profile = await readProfile('governed-pr');
    const original = compiled(profile);
    profile.cycle_controls?.reverse();
    for (const control of profile.cycle_controls ?? []) {
      control.exit_transition_refs.reverse();
      if ('transition_refs' in control) control.transition_refs.reverse();
    }
    for (const budget of profile.budgets ?? []) budget.transition_refs.reverse();
    expect(compiled(profile)).toEqual(original);
  });

  it('ignores YAML presentation, description, and unordered declaration order', () => {
    const profile = cyclicProfile();
    const original = compiled(profile);
    profile.description = 'Only an author note, including GitHub as ordinary prose.';
    profile.states.reverse();
    profile.transitions.reverse();
    profile.guards.reverse();
    profile.required_actions.reverse();
    for (const edge of profile.transitions) {
      edge.guard_refs.reverse();
      edge.authority.reverse();
    }
    expect(compiled(profile)).toEqual(original);
    expect(compileWorkflowProfile('# A comment\n' + stringify(profile, { aliasDuplicateObjects: false }))).toEqual({
      ok: true,
      value: original,
    });
  });

  it('makes semantic changes observable', () => {
    const profile = cyclicProfile();
    const original = compiled(profile);
    profile.transitions.find((edge) => edge.id === 'repeat')!.priority = 5;
    expect(compiled(profile).graph_digest).not.toBe(original.graph_digest);
  });

  it('accepts an exact binding and never mutates it', () => {
    const graph = compiled();
    const binding = Object.freeze({ graph_schema_version: '0.1', graph_digest: graph.graph_digest });
    expect(validateGraphBinding(binding, graph)).toEqual({ ok: true, value: graph });
  });

  it.each(['digest', 'version', 'payload', 'normalization'])('rejects changed %s against a binding', (change) => {
    const graph = compiled();
    const binding = { graph_schema_version: '0.1', graph_digest: graph.graph_digest };
    const candidate = structuredClone(graph);
    if (change === 'digest') binding.graph_digest = '0'.repeat(64);
    if (change === 'version') binding.graph_schema_version = '0.2';
    if (change === 'payload') candidate.graph.profile.revision++;
    if (change === 'normalization') candidate.graph.states.reverse();
    const before = canonicalJson(binding);
    expect(validateGraphBinding(binding, candidate).ok).toBe(false);
    expect(canonicalJson(binding)).toBe(before);
  });
});

describe('Workflow graph static validation', () => {
  it('locates a broken scalar reference at its actual document path', () => {
    const profile = minimalProfile();
    profile.transitions[0]!.to = 'absent';
    expect(compile(profile)).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'UNKNOWN_REFERENCE', path: '$.transitions[0].to', identifier: 'absent' }],
    });
  });
  it('compiles a complete profile without executing its capabilities', () => {
    expect(compileWorkflowProfile(stringify(minimalProfile())).ok).toBe(true);
  });

  const invalidCases: [string, (profile: WorkflowProfile) => void][] = [
    [
      'duplicate state',
      (profile) => {
        profile.states.push({ id: 'prepared', kind: 'active' });
      },
    ],
    [
      'missing initial state',
      (profile) => {
        profile.initial_state = 'absent';
      },
    ],
    [
      'unknown target',
      (profile) => {
        profile.transitions[0]!.to = 'absent';
      },
    ],
    [
      'unknown guard',
      (profile) => {
        profile.transitions[0]!.guard_refs.push('absent');
      },
    ],
    [
      'unknown action',
      (profile) => {
        profile.guards[0]!.required_actions = ['absent'];
      },
    ],
    [
      'unreachable state',
      (profile) => {
        profile.states.push({ id: 'isolated', kind: 'active' });
      },
    ],
    [
      'no terminal path',
      (profile) => {
        profile.transitions = [];
      },
    ],
    [
      'terminal outgoing edge',
      (profile) => {
        profile.transitions.push({
          id: 'reopen',
          from: 'completed',
          to: 'prepared',
          guard_refs: [],
          authority: ['threadloop'],
        });
      },
    ],
    [
      'missing human authority',
      (profile) => {
        profile.transitions[0]!.authority = ['threadloop'];
      },
    ],
    [
      'missing ThreadLoop authority',
      (profile) => {
        profile.transitions[0]!.authority = ['human'];
      },
    ],
    [
      'missing completion observation',
      (profile) => {
        profile.transitions[0]!.guard_refs = ['approval'];
      },
    ],
    [
      'duplicate guard reference',
      (profile) => {
        profile.transitions[0]!.guard_refs.push('approval');
      },
    ],
    [
      'ambiguous edges',
      (profile) => {
        profile.transitions.push({ ...profile.transitions[0]!, id: 'other_finish' });
      },
    ],
    [
      'priority tie',
      (profile) => {
        profile.transitions[0]!.priority = 0;
        profile.transitions.push({ ...profile.transitions[0]!, id: 'other_finish' });
      },
    ],
    [
      'uncontrolled self-loop',
      (profile) => {
        profile.transitions[0]!.priority = 1;
        profile.transitions.push({
          id: 'repeat',
          from: 'prepared',
          to: 'prepared',
          priority: 0,
          guard_refs: [],
          authority: ['threadloop'],
        });
      },
    ],
    [
      'phase without history policy',
      (profile) => {
        profile.guards.push({ id: 'pre', capability: 'phase', parameters: { value: 'pre_pr' } });
      },
    ],
  ];
  it.each(invalidCases)('rejects %s before producing a digest', (_label, mutate) => {
    const profile = minimalProfile();
    mutate(profile);
    const source = stringify(profile, { aliasDuplicateObjects: false });
    expect(parseWorkflowProfile(source).ok).toBe(true);
    const result = compileWorkflowProfile(source);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('value');
  });
});
