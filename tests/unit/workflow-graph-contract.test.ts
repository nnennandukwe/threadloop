import { readFile, readdir } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parseWorkflowProfile } from '../../scripts/workflow-graph/parser.js';
import { publishedSchemas, type WorkflowProfile } from '../../scripts/workflow-graph/contracts.js';
import { compileWorkflowProfile, validateGraphBinding } from '../../scripts/workflow-graph/compiler.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { z } from 'zod';

const bundle = new URL('../../docs/contracts/workflow-graph-v0.1/', import.meta.url);

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
    const expectedSchema = z.array(z.strictObject({ file: z.string(), expected_code: z.string() }));
    const manifest: unknown = JSON.parse(await readFile(new URL('fixtures/invalid/expected.json', bundle), 'utf8'));
    const expected = expectedSchema.parse(manifest);
    const files = (await readdir(new URL('fixtures/invalid/', bundle))).filter((file) => file.endsWith('.yaml')).sort();
    expect(expected.map((item) => item.file).sort()).toEqual(files);
    for (const item of expected) {
      const source = await readFile(new URL(`fixtures/invalid/${item.file}`, bundle), 'utf8');
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
    { id: 'escape', kind: 'human_escape', state_refs: ['prepared'], exit_transition_refs: ['stop'] },
  ];
  return profile;
}

describe('Cycle control contracts', () => {
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
    profile.cycle_controls = [
      { id: 'finish_route', kind: 'terminal_route', state_refs: ['prepared'], exit_transition_refs: ['finish'] },
    ];
    expect(compile(profile).ok).toBe(true);
    profile.cycle_controls = [
      { id: 'stop_route', kind: 'guard_stop', guard: 'approval', exit_transition_refs: ['stop'] },
    ];
    expect(compile(profile).ok).toBe(false);
    profile.guards.push({ id: 'requested', capability: 'stop_requested', parameters: {} });
    profile.transitions.find((edge) => edge.id === 'stop')!.guard_refs.push('requested');
    profile.cycle_controls = [
      { id: 'stop_route', kind: 'guard_stop', guard: 'requested', exit_transition_refs: ['stop'] },
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
