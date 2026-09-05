import { canonicalJson } from '../../src/domain/canonical-json.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import {
  compiledGraphSchema,
  graphBindingSchema,
  diagnostic,
  validateShape,
  type CompiledGraph,
  type CompiledPayload,
  type ValidationResult,
  type WorkflowProfile,
} from './contracts.js';
import { parseWorkflowProfile } from './parser.js';
import { validateTopology } from './validation.js';

export function compileWorkflowProfile(source: string): ValidationResult<CompiledGraph> {
  const parsed = parseWorkflowProfile(source);
  if (!parsed.ok) return parsed;
  const diagnostics = validateTopology(parsed.value);
  if (diagnostics.length) return { ok: false, diagnostics };
  const graph = normalize(parsed.value);
  return { ok: true, value: { graph, graph_digest: sha256(canonicalJson(graph)) } };
}

export function validateGraphBinding(binding: unknown, compiled: unknown): ValidationResult<CompiledGraph> {
  const bound = validateShape(graphBindingSchema, binding);
  if (!bound.ok) return bound;
  const parsed = validateShape(compiledGraphSchema, compiled);
  if (!parsed.ok) return parsed;
  const { graph, graph_digest } = parsed.value;
  const profile: WorkflowProfile = {
    schema_version: graph.schema_version,
    profile: graph.profile,
    initial_state: graph.initial_state,
    states: graph.states,
    transitions: graph.transitions,
    guards: graph.guards,
    required_actions: graph.required_actions,
    budgets: graph.budgets,
    cycle_controls: graph.cycle_controls,
    ...(graph.phase_policy ? { phase_policy: graph.phase_policy } : {}),
  };
  const diagnostics = validateTopology(profile);
  if (diagnostics.length)
    return {
      ok: false,
      diagnostics: diagnostics.map((item) => ({ ...item, path: item.path.replace('$', '$.graph') })),
    };
  const bytes = canonicalJson(graph);
  if (canonicalJson(normalize(profile)) !== bytes)
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          'NON_CANONICAL_GRAPH',
          '$.graph',
          graph.profile.id,
          'Compiled declarations are not normalized.',
          'Recompile the authoring profile; do not normalize or replace an active run binding.',
        ),
      ],
    };
  if (sha256(bytes) !== graph_digest)
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          'GRAPH_DIGEST_MISMATCH',
          '$.graph_digest',
          graph.profile.id,
          'Graph payload does not match its claimed digest.',
          'Restore the intact graph artifact or compile a new artifact for a new run.',
        ),
      ],
    };
  if (bound.value.graph_digest !== graph_digest || bound.value.graph_schema_version !== graph.schema_version)
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          'BINDING_MISMATCH',
          '$.graph_digest',
          graph.profile.id,
          'Graph identity differs from the immutable run binding.',
          'Supply the originally bound graph; a changed profile requires a separately bound run.',
        ),
      ],
    };
  return parsed;
}

function byId<T extends { id: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => compare(left.id, right.id));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalize(profile: WorkflowProfile): CompiledPayload {
  return {
    schema_version: '0.1',
    capability_catalog: 'threadloop.sdlc/0.1',
    profile: { ...profile.profile },
    initial_state: profile.initial_state,
    states: byId(profile.states),
    transitions: byId(profile.transitions).map((edge) => ({
      ...edge,
      priority: edge.priority ?? 0,
      guard_refs: [...edge.guard_refs].sort(),
      authority: [...edge.authority].sort(),
    })),
    guards: byId(profile.guards).map((guard) => ({
      ...guard,
      required_actions: [...(guard.required_actions ?? [])].sort(),
    })),
    required_actions: byId(profile.required_actions),
    budgets: byId(profile.budgets ?? []).map((budget) => ({
      ...budget,
      transition_refs: [...budget.transition_refs].sort(),
    })),
    cycle_controls: byId(profile.cycle_controls ?? []).map((control) => ({
      ...control,
      exit_transition_refs: [...control.exit_transition_refs].sort(),
      ...('transition_refs' in control ? { transition_refs: [...control.transition_refs].sort() } : {}),
    })),
    phase_policy: profile.phase_policy
      ? { ...profile.phase_policy, state_refs: [...profile.phase_policy.state_refs].sort() }
      : null,
  };
}
