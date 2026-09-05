import { z } from 'zod';

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const references = z.array(identifier);
const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const emptyParameters = z.strictObject({});
const profileIdentity = z.strictObject({ id: identifier, revision: safeInteger.min(1) });
const authority = z.enum(['threadloop', 'human']);

const guardCapabilities = z.discriminatedUnion('capability', [
  z.strictObject({ capability: z.literal('proof_plan_bound'), parameters: emptyParameters }),
  z.strictObject({
    capability: z.literal('repository'),
    parameters: z.strictObject({
      condition: z.enum(['baseline_matches', 'clean_descendant', 'clean_plan_branch', 'committed_repair']),
    }),
  }),
  z.strictObject({
    capability: z.literal('phase'),
    parameters: z.strictObject({ value: z.enum(['pre_pr', 'post_pr']) }),
  }),
  z.strictObject({
    capability: z.literal('local_proof'),
    parameters: z.strictObject({ result: z.enum(['passed', 'failed']) }),
  }),
  z.strictObject({ capability: z.literal('independent_proof'), parameters: emptyParameters }),
  z.strictObject({
    capability: z.literal('pre_pr_review'),
    parameters: z.strictObject({ outcome: z.enum(['clean', 'changes_required']) }),
  }),
  z.strictObject({
    capability: z.literal('review'),
    parameters: z.strictObject({ condition: z.enum(['current', 'blocking', 'clear', 'proof_set_current']) }),
  }),
  z.strictObject({
    capability: z.literal('human_approval'),
    parameters: z.strictObject({ scope: z.enum(['current_subject', 'recovery']) }),
  }),
  z.strictObject({
    capability: z.literal('completion_observed'),
    parameters: z.strictObject({ kind: z.enum(['merge', 'publication']) }),
  }),
  z.strictObject({ capability: z.literal('block_evidence'), parameters: emptyParameters }),
  z.strictObject({ capability: z.literal('recorded_prior_state'), parameters: z.strictObject({ state: identifier }) }),
  z.strictObject({ capability: z.literal('budget_available'), parameters: z.strictObject({ budget: identifier }) }),
  z.strictObject({ capability: z.literal('stop_requested'), parameters: emptyParameters }),
  z.strictObject({
    capability: z.literal('artifact'),
    parameters: z.strictObject({
      stage: z.enum(['release_prepared', 'release_verified', 'publication_verified']),
      result: z.enum(['passed', 'failed']),
    }),
  }),
]);

const [firstGuardCapability, ...otherGuardCapabilities] = guardCapabilities.options;
const authorGuardFields = { id: identifier, required_actions: references.optional() };
const compiledGuardFields = { id: identifier, required_actions: references };
const guardSchema = z.discriminatedUnion('capability', [
  firstGuardCapability.extend(authorGuardFields),
  ...otherGuardCapabilities.map((option) => option.extend(authorGuardFields)),
]);
const compiledGuardSchema = z.discriminatedUnion('capability', [
  firstGuardCapability.extend(compiledGuardFields),
  ...otherGuardCapabilities.map((option) => option.extend(compiledGuardFields)),
]);

const actionSchema = z.discriminatedUnion('capability', [
  z.strictObject({
    capability: z.enum([
      'frame_change',
      'bind_proof_plan',
      'implement_change',
      'commit_change',
      'run_local_gates',
      'obtain_independent_proof',
      'record_pre_pr_review',
      'obtain_review_evidence',
      'repair_change',
      'correct_gate_setup',
      'restore_proof_authority',
      'restore_repository',
      'restore_evidence',
      'prepare_release',
      'verify_release',
      'publish_release',
      'verify_publication',
    ]),
    authority: z.enum(['human', 'executor']),
    parameters: emptyParameters,
    id: identifier,
  }),
  z.strictObject({
    capability: z.enum(['block_run', 'recover_run', 'approve_change', 'merge_change']),
    authority: z.literal('human'),
    parameters: emptyParameters,
    id: identifier,
  }),
]);

const stateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: identifier, kind: z.literal('active') }),
  z.strictObject({ id: identifier, kind: z.literal('suspended'), handoff: identifier }),
  z.strictObject({ id: identifier, kind: z.literal('terminal') }),
]);
const transitionFields = {
  id: identifier,
  from: identifier,
  to: identifier,
  guard_refs: references,
  authority: z.array(authority).min(1),
};
const transitionSchema = z.strictObject({ ...transitionFields, priority: safeInteger.optional() });
const compiledTransitionSchema = z.strictObject({ ...transitionFields, priority: safeInteger });
const budgetSchema = z.strictObject({ id: identifier, limit: safeInteger.min(1), transition_refs: references.min(1) });
const phasePolicySchema = z.strictObject({
  kind: z.literal('entered_state'),
  state_refs: references.min(1),
  initial: z.literal('pre_pr'),
  advanced: z.literal('post_pr'),
  monotonic: z.literal(true),
  include_audit_genesis: z.literal(true),
});
const cycleControlSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    id: identifier,
    kind: z.literal('budget'),
    budget: identifier,
    exit_transition_refs: references.min(1),
  }),
  z.strictObject({
    id: identifier,
    kind: z.literal('human_escape'),
    transition_refs: references.min(1),
    exit_transition_refs: references.min(1),
  }),
  z.strictObject({
    id: identifier,
    kind: z.literal('terminal_route'),
    transition_refs: references.min(1),
    exit_transition_refs: references.min(1),
  }),
  z.strictObject({
    id: identifier,
    kind: z.literal('guard_stop'),
    guard: identifier,
    transition_refs: references.min(1),
    exit_transition_refs: references.min(1),
  }),
]);

export const workflowProfileSchema = z.strictObject({
  schema_version: z.literal('0.1'),
  description: z.string().optional(),
  profile: profileIdentity,
  initial_state: identifier,
  states: z.array(stateSchema).min(1),
  transitions: z.array(transitionSchema),
  guards: z.array(guardSchema),
  required_actions: z.array(actionSchema),
  budgets: z.array(budgetSchema).optional(),
  cycle_controls: z.array(cycleControlSchema).optional(),
  phase_policy: phasePolicySchema.optional(),
});

export const compiledPayloadSchema = z.strictObject({
  schema_version: z.literal('0.1'),
  capability_catalog: z.literal('threadloop.sdlc/0.1'),
  profile: profileIdentity,
  initial_state: identifier,
  states: z.array(stateSchema).min(1),
  transitions: z.array(compiledTransitionSchema),
  guards: z.array(compiledGuardSchema),
  required_actions: z.array(actionSchema),
  budgets: z.array(budgetSchema),
  cycle_controls: z.array(cycleControlSchema),
  phase_policy: phasePolicySchema.nullable(),
});
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const compiledGraphSchema = z.strictObject({ graph: compiledPayloadSchema, graph_digest: digestSchema });
export const graphBindingSchema = z.strictObject({
  graph_schema_version: z.literal('0.1'),
  graph_digest: digestSchema,
});

export type WorkflowProfile = z.infer<typeof workflowProfileSchema>;
export type CompiledPayload = z.infer<typeof compiledPayloadSchema>;
export type CompiledGraph = z.infer<typeof compiledGraphSchema>;

export interface Diagnostic {
  code: string;
  path: string;
  identifier: string | null;
  message: string;
  recovery: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; diagnostics: Diagnostic[] };

export function diagnostic(
  code: string,
  path: string,
  identifier: string | null,
  message: string,
  recovery: string,
): Diagnostic {
  return { code, path, identifier, message, recovery };
}

export function validateShape<T>(schema: z.ZodType<T>, value: unknown): ValidationResult<T> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    diagnostics: result.error.issues.map((issue) =>
      diagnostic(
        issue.path.at(-1) === 'schema_version' || issue.path.at(-1) === 'graph_schema_version'
          ? 'UNSUPPORTED_VERSION'
          : 'SCHEMA_INVALID',
        '$' + issue.path.map((part) => (typeof part === 'number' ? `[${part}]` : `.${String(part)}`)).join(''),
        null,
        issue.message,
        'Use the published v0.1 schema and registered capability parameters; unknown fields are not ignored.',
      ),
    ),
  };
}

export function publishedSchemas() {
  const schemas = {
    'workflow-profile': workflowProfileSchema,
    'compiled-graph': compiledGraphSchema,
    'graph-binding': graphBindingSchema,
  };
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [
      name,
      {
        ...z.toJSONSchema(schema, { target: 'draft-2020-12' }),
        $id: `https://github.com/nnennandukwe/threadloop/contracts/workflow-graph/0.1/${name}`,
      },
    ]),
  );
}
