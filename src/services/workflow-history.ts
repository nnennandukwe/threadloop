import { ThreadloopError } from '../contracts/errors.js';
import type { History, PhysicalObservation, RunSnapshot, Transition, WorkflowGenesis } from '../domain/workflow-run.js';

export function initialWorkflowHistory(genesis: WorkflowGenesis): Omit<History, 'digest'> {
  const graph = genesis.compiled.graph;
  const policy = graph.phase_policy;
  return {
    status: 'verified',
    proof_plan_bound: false,
    phase: policy
      ? policy.include_audit_genesis && policy.state_refs.includes(graph.initial_state)
        ? policy.advanced
        : policy.initial
      : null,
    budget_counts: graph.budgets.map((budget) => ({ budget_id: budget.id, used: 0 })),
    prior_state: null,
    implementation_basis: null,
    repair_admission: null,
  };
}

export function nextWorkflowHistory(snapshot: RunSnapshot, selected: Transition, observed: PhysicalObservation) {
  const { genesis, view } = snapshot,
    graph = genesis.compiled.graph;
  const edge = graph.transitions.find(
    (item) => item.id === selected.transition_id && item.from === view.state && item.to === selected.target_state,
  );
  const current = graph.states.find((state) => state.id === view.state);
  const target = graph.states.find((state) => state.id === selected.target_state);
  if (!edge || !current || !target)
    throw new ThreadloopError('STATE_CORRUPTED', 'The transition disagrees with the bound graph.');
  const previous = snapshot.history;
  const recovering = current.kind === 'suspended';
  const suspending = target.kind === 'suspended';
  if (recovering && target.id !== previous.prior_state)
    throw new ThreadloopError('TRANSITION_GUARD_FAILED', 'Recovery must return to the recorded prior state.');
  const version = view.state_version + 1;
  const phase = graph.phase_policy;
  const budgetCounts = graph.budgets.map((budget) => {
    const count = previous.budget_counts.find((item) => item.budget_id === budget.id);
    if (!count) throw new ThreadloopError('STATE_CORRUPTED', 'The workflow budget count is missing.');
    const used = count.used + Number(!recovering && budget.transition_refs.includes(edge.id));
    if (used > budget.limit)
      throw new ThreadloopError('TRANSITION_GUARD_FAILED', 'The transition exceeds its workflow budget.');
    return { budget_id: budget.id, used };
  });
  const exits = graph.transitions.filter((item) => item.from === target.id);
  const exitGuards = graph.guards.filter((guard) => exits.some((item) => item.guard_refs.includes(guard.id)));
  const hasBasisGuard = exitGuards.some(
    (guard) =>
      guard.capability === 'repository' &&
      (guard.parameters.condition === 'clean_descendant' || guard.parameters.condition === 'committed_repair'),
  );

  const retained = previous.repair_admission;
  let admission: History['repair_admission'] =
    (recovering || suspending) && retained ? { ...retained, bound_state_version: version } : null;
  if (!recovering && !suspending) {
    const repairActions = graph.required_actions.filter(
      (action) =>
        action.capability === 'repair_change' && exitGuards.some((guard) => guard.required_actions.includes(action.id)),
    );
    const counted = graph.budgets.filter(
      (budget) =>
        budget.transition_refs.includes(edge.id) &&
        graph.guards.some(
          (guard) =>
            guard.capability === 'budget_available' &&
            guard.parameters.budget === budget.id &&
            edge.guard_refs.includes(guard.id),
        ),
    );
    if (repairActions.length && counted.length) {
      if (repairActions.length !== 1 || counted.length !== 1)
        throw new ThreadloopError('TRANSITION_GUARD_FAILED', 'The graph must identify one counted repair admission.');
      const budget = counted[0]!;
      admission = {
        action_id: repairActions[0]!.id,
        transition_id: edge.id,
        entry_state_version: version,
        bound_state_version: version,
        budget_id: budget.id,
        consumed: budgetCounts.find((count) => count.budget_id === budget.id)!.used,
      };
    }
  }
  const newBasis = !recovering && !suspending && (hasBasisGuard || admission !== null);
  const history: Omit<History, 'digest'> = {
    status: 'verified',
    proof_plan_bound: previous.proof_plan_bound || edge.id === genesis.policy.rules.proof_binding_transition_id,
    phase: phase && phase.state_refs.includes(target.id) ? phase.advanced : previous.phase,
    prior_state: suspending ? current.id : null,
    implementation_basis: newBasis ? observed.subject : previous.implementation_basis,
    budget_counts: budgetCounts,
    repair_admission: admission,
  };
  return {
    history,
    implementation_manifest: newBasis ? (observed.physical?.manifest ?? null) : snapshot.implementation_manifest,
  };
}
