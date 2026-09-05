import { diagnostic, type Diagnostic, type WorkflowProfile } from './contracts.js';

type Edge = WorkflowProfile['transitions'][number];

export function validateTopology(profile: WorkflowProfile): Diagnostic[] {
  const errors: Diagnostic[] = [];
  const report = (code: string, path: string, id: string | null, message: string, recovery: string) => {
    errors.push(diagnostic(code, path, id, message, recovery));
  };
  const tables = [
    ['states', profile.states],
    ['transitions', profile.transitions],
    ['guards', profile.guards],
    ['required_actions', profile.required_actions],
    ['budgets', profile.budgets ?? []],
    ['cycle_controls', profile.cycle_controls ?? []],
  ] as const;
  for (const [name, records] of tables) {
    const seen = new Set<string>();
    records.forEach((record, index) => {
      if (seen.has(record.id))
        report(
          'DUPLICATE_ID',
          `$.${name}[${index}].id`,
          record.id,
          'Identifier is duplicated within its namespace.',
          'Assign a distinct identifier and update its references.',
        );
      seen.add(record.id);
    });
  }
  const states = new Map(profile.states.map((state) => [state.id, state]));
  const edges = new Map(profile.transitions.map((edge) => [edge.id, edge]));
  const guards = new Map(profile.guards.map((guard) => [guard.id, guard]));
  const actions = new Map(profile.required_actions.map((action) => [action.id, action]));
  const budgets = new Map((profile.budgets ?? []).map((budget) => [budget.id, budget]));
  function ref(value: string, known: ReadonlyMap<string, unknown>, path: string) {
    if (!known.has(value))
      report(
        'UNKNOWN_REFERENCE',
        path,
        value,
        'Reference has no declaration.',
        'Declare the referenced identifier or correct this reference.',
      );
  }
  function refs(values: readonly string[], known: ReadonlyMap<string, unknown>, path: string) {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      ref(value, known, `${path}[${index}]`);
      if (seen.has(value))
        report(
          'DUPLICATE_REFERENCE',
          `${path}[${index}]`,
          value,
          'Reference appears more than once.',
          'Remove the duplicate reference.',
        );
      seen.add(value);
    });
  }
  ref(profile.initial_state, states, '$.initial_state');
  profile.states.forEach((state, index) => {
    if (state.kind === 'suspended') ref(state.handoff, actions, `$.states[${index}].handoff`);
  });
  profile.transitions.forEach((edge, index) => {
    ref(edge.from, states, `$.transitions[${index}].from`);
    ref(edge.to, states, `$.transitions[${index}].to`);
    refs(edge.guard_refs, guards, `$.transitions[${index}].guard_refs`);
    if (new Set(edge.authority).size !== edge.authority.length)
      report(
        'DUPLICATE_REFERENCE',
        `$.transitions[${index}].authority`,
        edge.id,
        'Authority appears more than once.',
        'List each required authority once.',
      );
  });
  profile.guards.forEach((guard, index) => {
    refs(guard.required_actions ?? [], actions, `$.guards[${index}].required_actions`);
    if (guard.capability === 'budget_available')
      ref(guard.parameters.budget, budgets, `$.guards[${index}].parameters.budget`);
    if (guard.capability === 'recorded_prior_state') {
      ref(guard.parameters.state, states, `$.guards[${index}].parameters.state`);
      const prior = states.get(guard.parameters.state);
      if (prior && prior.kind !== 'active') {
        report(
          'INVALID_PRIOR_STATE',
          `$.guards[${index}].parameters.state`,
          guard.id,
          'A recorded prior-state guard must reference an active state, even when unused.',
          'Reference the active state recorded before suspension; suspended and terminal states cannot be recovery bases.',
        );
      }
    }
    if (guard.capability === 'phase' && !profile.phase_policy)
      report(
        'PHASE_POLICY_REQUIRED',
        `$.guards[${index}]`,
        guard.id,
        'Phase guards require a monotonic history policy.',
        'Declare phase_policy with its history entry states and audit-genesis rule.',
      );
  });
  if (profile.phase_policy) refs(profile.phase_policy.state_refs, states, '$.phase_policy.state_refs');
  (profile.budgets ?? []).forEach((budget, index) =>
    refs(budget.transition_refs, edges, `$.budgets[${index}].transition_refs`),
  );
  (profile.cycle_controls ?? []).forEach((control, index) => {
    const path = `$.cycle_controls[${index}]`;
    refs(control.exit_transition_refs, edges, `${path}.exit_transition_refs`);
    if ('transition_refs' in control) refs(control.transition_refs, edges, `${path}.transition_refs`);
    if (control.kind === 'budget') ref(control.budget, budgets, `${path}.budget`);
    if (control.kind === 'guard_stop') ref(control.guard, guards, `${path}.guard`);
  });
  if (errors.length) return errors;

  if (states.get(profile.initial_state)?.kind !== 'active') {
    report(
      'INVALID_INITIAL_STATE',
      '$.initial_state',
      profile.initial_state,
      'A run must start in an active state.',
      'Require a guarded transition before suspension or completion.',
    );
  }
  const reachable = reach([profile.initial_state], profile.transitions);
  const terminals = profile.states.filter((state) => state.kind === 'terminal').map((state) => state.id);
  const canFinish = reach(
    terminals,
    profile.transitions.map((edge) => ({ from: edge.to, to: edge.from })),
  );
  profile.states.forEach((state, index) => {
    const path = `$.states[${index}]`;
    if (!reachable.has(state.id))
      report(
        'UNREACHABLE_STATE',
        path,
        state.id,
        'State cannot be reached from the initial state.',
        'Connect the state or remove the unused declaration.',
      );
    if (!canFinish.has(state.id))
      report(
        'NO_TERMINAL_PATH',
        path,
        state.id,
        'State has no structural path to a terminal state.',
        'Provide a guarded terminal route, including explicit recovery from suspension.',
      );
    const outgoing = profile.transitions.filter((edge) => edge.from === state.id);
    if (state.kind === 'terminal' && outgoing.length)
      report(
        'TERMINAL_OUTGOING',
        path,
        state.id,
        'Terminal states have no outgoing transitions.',
        'Use a suspended state for recovery, or start a new run after completion.',
      );
    if (state.kind === 'suspended') {
      const handoff = actions.get(state.handoff);
      if (handoff?.authority !== 'human' || handoff.capability !== 'recover_run')
        report(
          'INVALID_HANDOFF',
          path,
          state.id,
          'Suspension requires a human recover_run action.',
          'Bind handoff to a human recovery action.',
        );
    }
    if (
      outgoing.length > 1 &&
      (outgoing.some((edge) => edge.priority === undefined) ||
        new Set(outgoing.map((edge) => edge.priority)).size !== outgoing.length)
    ) {
      report(
        'AMBIGUOUS_TRANSITIONS',
        path,
        state.id,
        'Multiple outgoing transitions require distinct explicit priorities.',
        'Assign unique nonnegative integer priorities; the lowest eligible priority wins.',
      );
    }
  });

  profile.transitions.forEach((edge, index) => {
    const path = `$.transitions[${index}]`;
    const conditions = edge.guard_refs.flatMap((id) => {
      const guard = guards.get(id);
      return guard ? [guard] : [];
    });
    const humanGuard = conditions.some((guard) => guard.capability === 'human_approval');
    if (!edge.authority.includes('threadloop') || (humanGuard && !edge.authority.includes('human')))
      report(
        'INVALID_AUTHORITY',
        path,
        edge.id,
        'ThreadLoop owns every transition; human approvals require human authority.',
        'Retain ThreadLoop authority and every human boundary required by the guards.',
      );
    if (
      states.get(edge.to)?.kind === 'terminal' &&
      (!edge.authority.includes('human') ||
        !conditions.some(
          (guard) => guard.capability === 'human_approval' && guard.parameters.scope === 'current_subject',
        ) ||
        !conditions.some((guard) => guard.capability === 'completion_observed'))
    ) {
      report(
        'COMPLETION_AUTHORITY_REQUIRED',
        path,
        edge.id,
        'Completion requires current-subject human approval and an observed delivery result.',
        'Add both guards and human authority; observations alone cannot complete a run.',
      );
    }
    if (states.get(edge.to)?.kind === 'suspended' && !conditions.some((guard) => guard.capability === 'block_evidence'))
      report(
        'BLOCK_EVIDENCE_REQUIRED',
        path,
        edge.id,
        'Suspension must retain explicit block evidence.',
        'Require the registered block_evidence guard.',
      );
    if (
      states.get(edge.from)?.kind === 'suspended' &&
      (states.get(edge.to)?.kind !== 'active' ||
        !edge.authority.includes('human') ||
        !conditions.some((guard) => guard.capability === 'human_approval' && guard.parameters.scope === 'recovery') ||
        !conditions.some((guard) => guard.capability === 'recorded_prior_state' && guard.parameters.state === edge.to))
    ) {
      report(
        'RECOVERY_AUTHORITY_REQUIRED',
        path,
        edge.id,
        'Recovery requires human approval and an active recorded prior target.',
        'Target an active state and require recovery approval plus a matching recorded_prior_state guard.',
      );
    }
    for (const condition of conditions) {
      if (
        condition.capability === 'budget_available' &&
        !budgets.get(condition.parameters.budget)?.transition_refs.includes(edge.id)
      )
        report(
          'INVALID_BUDGET',
          path,
          edge.id,
          'Budget availability must guard a transition counted by that budget.',
          'Include this transition in the referenced budget counter.',
        );
    }
  });
  (profile.budgets ?? []).forEach((budget, index) => {
    for (const id of budget.transition_refs) {
      const edge = edges.get(id);
      if (
        !edge?.guard_refs.some((ref) => {
          const guard = guards.get(ref);
          return guard?.capability === 'budget_available' && guard.parameters.budget === budget.id;
        })
      ) {
        report(
          'INVALID_BUDGET',
          `$.budgets[${index}]`,
          budget.id,
          'Every counted entry must check this budget before entry.',
          'Attach a budget_available guard for this budget to every counted transition.',
        );
      }
    }
  });
  if (errors.length) return errors;
  return validateCycles(profile);
}

function reach(starts: readonly string[], edges: readonly { from: string; to: string }[]): Set<string> {
  const visited = new Set(starts);
  const pending = [...starts];
  for (let index = 0; index < pending.length; index++) {
    for (const edge of edges) {
      if (edge.from === pending[index] && !visited.has(edge.to)) {
        visited.add(edge.to);
        pending.push(edge.to);
      }
    }
  }
  return visited;
}

function hasCycle(states: readonly string[], edges: readonly Edge[]): boolean {
  const indegree = new Map(states.map((state) => [state, 0]));
  for (const edge of edges) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  const pending = states.filter((state) => indegree.get(state) === 0);
  for (let index = 0; index < pending.length; index++) {
    for (const edge of edges.filter((candidate) => candidate.from === pending[index])) {
      const remaining = (indegree.get(edge.to) ?? 0) - 1;
      indegree.set(edge.to, remaining);
      if (remaining === 0) pending.push(edge.to);
    }
  }
  return pending.length !== states.length;
}

function validateCycles(profile: WorkflowProfile): Diagnostic[] {
  const errors: Diagnostic[] = [];
  const states = new Map(profile.states.map((state) => [state.id, state]));
  // A required human authorization interrupts autonomous cycling on every traversal.
  const guardedEdges = new Set(
    profile.transitions.filter((edge) => edge.authority.includes('human')).map((edge) => edge.id),
  );
  (profile.cycle_controls ?? []).forEach((control, index) => {
    const exits = profile.transitions.filter((edge) => control.exit_transition_refs.includes(edge.id));
    const entries = profile.transitions.filter(
      (edge) => 'transition_refs' in control && control.transition_refs.includes(edge.id),
    );
    const toHandoff = (edge: Edge) => states.get(edge.to)?.kind === 'suspended';
    const toStop = (edge: Edge) => toHandoff(edge) || states.get(edge.to)?.kind === 'terminal';
    // When an exit is eligible, branch precedence must select it before the controlled continuation.
    const exitPrecedes = (entry: Edge) =>
      exits.some((exit) => exit.from === entry.from && (exit.priority ?? 0) < (entry.priority ?? 0));
    let valid = false;
    switch (control.kind) {
      case 'human_escape':
        valid = exits.every(toHandoff) && entries.every(exitPrecedes);
        break;
      case 'terminal_route':
        valid =
          !hasCycle([...states.keys()], exits) &&
          entries.every((entry) =>
            exits.some(
              (exit) =>
                exit.from === entry.from &&
                (exit.priority ?? 0) < (entry.priority ?? 0) &&
                [...reach([exit.to], exits)].some((target) => states.get(target)?.kind === 'terminal'),
            ),
          );
        break;
      case 'guard_stop': {
        const guard = profile.guards.find((candidate) => candidate.id === control.guard);
        valid =
          guard?.capability === 'stop_requested' &&
          exits.every((edge) => toStop(edge) && edge.guard_refs.includes(control.guard)) &&
          entries.every(exitPrecedes);
        break;
      }
      case 'budget': {
        const budget = profile.budgets?.find((candidate) => candidate.id === control.budget);
        const countedEntries = profile.transitions.filter((edge) => budget?.transition_refs.includes(edge.id));
        // Exhaustion must not require the exhausted budget again, even on the escape edge.
        valid =
          countedEntries.length > 0 &&
          exits.every(
            (edge) =>
              toStop(edge) &&
              !edge.guard_refs.some((ref) =>
                profile.guards.some((guard) => guard.id === ref && guard.capability === 'budget_available'),
              ),
          ) &&
          countedEntries.every((entry) => exits.some((edge) => edge.from === entry.from));
        if (valid) for (const edge of countedEntries) guardedEdges.add(edge.id);
        break;
      }
    }
    if (valid && control.kind !== 'budget') for (const edge of entries) guardedEdges.add(edge.id);
    if (!valid)
      errors.push(
        diagnostic(
          'INVALID_CYCLE_CONTROL',
          `$.cycle_controls[${index}]`,
          control.id,
          'Cycle control does not provide its declared stop, budget exit, or human escape.',
          'Name the controlled transitions and higher-priority stop routes; an exhausted budget cannot gate its own exit.',
        ),
      );
  });
  const residualStates = profile.states.map((state) => state.id);
  const residualEdges = profile.transitions.filter((edge) => !guardedEdges.has(edge.id));
  if (hasCycle(residualStates, residualEdges))
    errors.push(
      diagnostic(
        'UNCONTROLLED_CYCLE',
        '$.cycle_controls',
        null,
        'A cycle bypasses every declared control and required human authorization.',
        'Add a valid stop condition, counted budget, terminal route, or human escape covering that cycle.',
      ),
    );
  return errors;
}
