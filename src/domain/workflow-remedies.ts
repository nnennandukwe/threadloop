import type { ControllerInput } from 'threadloop-contracts/controller';
import { canonicalJson } from './canonical-json.js';
import { workflowGuardEvidence, type WorkflowRoute } from './workflow-guard-facts.js';
import type { WorkflowAction, WorkflowEdge, WorkflowGuard, WorkflowReason } from './workflow-selection-types.js';

type SelectedAction = {
  kind: 'action';
  edge: WorkflowEdge;
  action: WorkflowAction;
  guardIds: string[];
  supportingEvidenceIds?: string[];
};
export type WorkflowRemedy = SelectedAction | { kind: 'blocked'; reasons: WorkflowReason[] };
type Capability = WorkflowAction['capability'];
// Equal priorities preserve competing interventions and alternative graph actions for the same missing fact.
const remedyPriority: Record<Capability, number> = {
  recover_run: 0,
  block_run: 0,
  correct_gate_setup: 0,
  restore_repository: 1,
  bind_proof_plan: 2,
  restore_proof_authority: 2,
  implement_change: 3,
  repair_change: 3,
  prepare_release: 3,
  commit_change: 4,
  verify_release: 4,
  run_local_gates: 5,
  obtain_independent_proof: 6,
  record_pre_pr_review: 7,
  obtain_review_evidence: 7,
  approve_change: 8,
  merge_change: 9,
  publish_release: 9,
  verify_publication: 10,
  // v0.1 has no unguarded framing action or integrity-loss projection.
  frame_change: 11,
  restore_evidence: 11,
};
type GuardCondition<T = WorkflowGuard> = T extends WorkflowGuard ? Omit<T, 'id' | 'required_actions'> : never;

function remedyFacts(input: ControllerInput, receipts: ControllerInput['receipts']) {
  const rules = input.policy.rules;
  const evaluated = new Map<string, boolean>();
  const holds = (condition: GuardCondition) => {
    const key = canonicalJson(condition);
    const prior = evaluated.get(key);
    if (prior !== undefined) return prior;
    const satisfied =
      workflowGuardEvidence(input, receipts, { ...condition, id: 'prerequisite', required_actions: [] }) !== null;
    evaluated.set(key, satisfied);
    return satisfied;
  };
  const localGates = new Set(rules.local_gate_ids);
  const independentGates = new Set(rules.independent_gate_ids);
  return {
    holds,
    phase: input.history.status === 'verified' ? input.history.phase : null,
    hasPrePrReview: receipts.some(({ payload }) => payload.type === 'pre_pr_review'),
    boundPlan:
      input.history.status === 'verified' &&
      input.history.proof_plan_bound &&
      rules.proof_plan !== null &&
      rules.repository_binding !== null,
    cleanBoundBranch: holds({ capability: 'repository', parameters: { condition: 'clean_plan_branch' } }),
    setupFailures: receipts
      .filter(
        ({ payload }) =>
          payload.type === 'local_proof' && localGates.has(payload.gate_id) && payload.result === 'setup_failed',
      )
      .map(({ id }) => id)
      .sort(),
    repairEvidence: receipts
      .filter(
        ({ payload }) =>
          (payload.type === 'local_proof' && localGates.has(payload.gate_id) && payload.result === 'failed') ||
          (payload.type === 'review' &&
            (payload.outcome === 'changes_required' ||
              payload.findings.some((finding) => finding.blocking && !finding.outdated))),
      )
      .map(({ id }) => id)
      .sort(),
    localFailed: holds({ capability: 'local_proof', parameters: { result: 'failed' } }),
    localPassed: holds({ capability: 'local_proof', parameters: { result: 'passed' } }),
    independentPassed: holds({ capability: 'independent_proof', parameters: {} }),
    independentFailed: receipts.some(
      ({ payload }) =>
        payload.type === 'independent_proof' && independentGates.has(payload.gate_id) && payload.result === 'failed',
    ),
    clearReview: holds({ capability: 'review', parameters: { condition: 'clear' } }),
    approved: holds({ capability: 'human_approval', parameters: { scope: 'current_subject' } }),
    releaseVerified: holds({ capability: 'artifact', parameters: { stage: 'release_verified', result: 'passed' } }),
    currentReview: holds({ capability: 'review', parameters: { condition: 'current' } }),
  };
}
type Facts = ReturnType<typeof remedyFacts>;

function isFailureGuard(guard: WorkflowGuard): boolean {
  switch (guard.capability) {
    case 'local_proof':
    case 'artifact':
      return guard.parameters.result === 'failed';
    case 'review':
      return guard.parameters.condition === 'blocking';
    case 'pre_pr_review':
      return guard.parameters.outcome === 'changes_required';
    default:
      return false;
  }
}

function proofRemedy(guard: WorkflowGuard, facts: Facts): Capability | null {
  if (!facts.boundPlan) return null;
  const composite = guard.capability === 'review' && guard.parameters.condition === 'proof_set_current';
  if (guard.capability === 'local_proof' || (composite && !facts.localPassed)) {
    if (facts.setupFailures.length) return 'correct_gate_setup';
    if (facts.localFailed) return null;
    return facts.cleanBoundBranch ? 'run_local_gates' : null;
  }
  if (guard.capability === 'independent_proof' || (composite && !facts.independentPassed)) {
    return facts.localPassed && !facts.independentFailed ? 'obtain_independent_proof' : null;
  }
  if (
    guard.capability === 'pre_pr_review' &&
    facts.phase !== 'post_pr' &&
    !facts.hasPrePrReview &&
    facts.localPassed &&
    facts.independentPassed
  )
    return 'record_pre_pr_review';
  if (
    guard.capability === 'review' &&
    facts.phase !== 'pre_pr' &&
    !facts.currentReview &&
    facts.localPassed &&
    facts.independentPassed
  ) {
    return 'obtain_review_evidence';
  }
  return null;
}

function planRemedy(input: ControllerInput, edge: WorkflowEdge, facts: Facts): Capability | null {
  const rules = input.policy.rules;
  if (input.binding.subject.kind !== 'repository' || input.history.status !== 'verified') return null;
  if (input.history.proof_plan_bound) return 'restore_proof_authority';
  if (rules.proof_binding_transition_id !== edge.id)
    return rules.proof_plan && rules.repository_binding ? 'restore_proof_authority' : null;
  const checkout = input.observation.repository;
  const canBind =
    rules.repository_binding === null
      ? checkout?.clean && checkout.branch !== null
      : facts.holds({ capability: 'repository', parameters: { condition: 'baseline_matches' } });
  return canBind ? 'bind_proof_plan' : null;
}

function repositoryRemedy(
  input: ControllerInput,
  guard: Extract<WorkflowGuard, { capability: 'repository' }>,
  facts: Facts,
): Capability | null {
  if (input.history.status !== 'verified') return null;
  const subject = input.binding.subject;
  const bound = input.policy.rules.repository_binding;
  const checkout = input.observation.repository;
  if (!bound || !checkout || subject.kind !== 'repository') return null;
  const condition = guard.parameters.condition;
  if (condition === 'baseline_matches' || condition === 'clean_plan_branch') return 'restore_repository';
  if (bound.baseline.repository_id !== subject.repository_id || checkout.branch !== bound.branch)
    return 'restore_repository';
  if (!input.history.proof_plan_bound || !input.policy.rules.proof_plan) return null;
  const admission = input.history.repair_admission;
  if (condition === 'committed_repair' && (!admission || !guard.required_actions.includes(admission.action_id)))
    return null;
  if (checkout.clean && condition === 'committed_repair') {
    return facts.repairEvidence.length && !facts.setupFailures.length ? 'repair_change' : null;
  }
  const basis = input.history.implementation_basis;
  if (
    basis?.kind !== 'repository' ||
    basis.repository_id !== subject.repository_id ||
    canonicalJson(checkout.basis) !== canonicalJson(basis)
  )
    return null;
  if (checkout.clean)
    return checkout.relationship === 'equal' && canonicalJson(subject) === canonicalJson(basis)
      ? 'implement_change'
      : null;
  if (
    checkout.change_scope === 'within_plan' &&
    (checkout.relationship === 'equal' || checkout.relationship === 'descendant') &&
    subject.content_digest !== basis.content_digest
  )
    return 'commit_change';
  return null;
}

function artifactRemedy(
  input: ControllerInput,
  guard: Extract<WorkflowGuard, { capability: 'artifact' }>,
  facts: Facts,
): Capability | null {
  if (input.binding.subject.kind !== 'artifact' || guard.parameters.result !== 'passed') return null;
  const stage = guard.parameters.stage;
  if (facts.holds({ capability: 'artifact', parameters: { stage, result: 'failed' } })) return null;
  switch (stage) {
    case 'release_prepared':
      return 'prepare_release';
    case 'release_verified':
      return 'verify_release';
    case 'publication_verified':
      return facts.approved && facts.holds({ capability: 'completion_observed', parameters: { kind: 'publication' } })
        ? 'verify_publication'
        : null;
  }
}

function handoffRemedy(input: ControllerInput, guard: WorkflowGuard, facts: Facts): Capability | null {
  const repositoryReady =
    input.binding.subject.kind === 'repository' && facts.localPassed && facts.independentPassed && facts.clearReview;
  const artifactReady = input.binding.subject.kind === 'artifact' && facts.releaseVerified;
  if (
    guard.capability === 'human_approval' &&
    guard.parameters.scope === 'current_subject' &&
    (repositoryReady || artifactReady)
  )
    return 'approve_change';
  if (guard.capability === 'completion_observed' && facts.approved) {
    if (guard.parameters.kind === 'merge' && repositoryReady) return 'merge_change';
    if (guard.parameters.kind === 'publication' && artifactReady && input.policy.rules.publication_destination !== null)
      return 'publish_release';
  }
  return null;
}

function exhaustedEntryExits(input: ControllerInput, routes: WorkflowRoute[]): Map<string, string[]> {
  const graph = input.compiled_graph.graph;
  const exits = new Map<string, string[]>();
  for (const { edge, checks } of routes) {
    if (checks.some(({ guard, evidenceIds }) => evidenceIds === null && guard.capability !== 'budget_available'))
      continue;
    const failures = checks
      .filter(({ guard }) => isFailureGuard(guard))
      .flatMap(({ evidenceIds }) => evidenceIds ?? []);
    if (!failures.length) continue;
    for (const { guard, evidenceIds } of checks) {
      if (guard.capability !== 'budget_available' || evidenceIds !== null) continue;
      if (
        !graph.budgets.some(
          (budget) => budget.id === guard.parameters.budget && budget.transition_refs.includes(edge.id),
        )
      )
        continue;
      for (const control of graph.cycle_controls) {
        if (control.kind !== 'budget' || control.budget !== guard.parameters.budget) continue;
        for (const exitId of control.exit_transition_refs) {
          const witnesses = new Set([...(exits.get(exitId) ?? []), ...failures]);
          exits.set(exitId, [...witnesses].sort());
        }
      }
    }
  }
  return exits;
}

function applicableRoute(
  route: WorkflowRoute,
  facts: Facts,
  needsBlock: boolean,
  admittedAction: string | undefined,
): boolean {
  return route.checks.every(({ guard, evidenceIds }) => {
    if (evidenceIds !== null) return true;
    if (isFailureGuard(guard)) return false;
    switch (guard.capability) {
      case 'phase':
      case 'recorded_prior_state':
      case 'stop_requested':
      case 'budget_available':
        return false;
      case 'block_evidence':
        return needsBlock;
      case 'artifact':
        return !facts.holds({
          capability: 'artifact',
          parameters: { stage: guard.parameters.stage, result: 'failed' },
        });
      case 'local_proof':
        return !facts.localFailed;
      case 'pre_pr_review':
        return !facts.hasPrePrReview;
      case 'review':
        return (
          guard.parameters.condition !== 'clear' ||
          !facts.currentReview ||
          facts.clearReview ||
          (admittedAction !== undefined && guard.required_actions.includes(admittedAction))
        );
      default:
        return true;
    }
  });
}

function neededCapability(
  input: ControllerInput,
  edge: WorkflowEdge,
  guard: WorkflowGuard,
  facts: Facts,
  needsBlock: boolean,
): Capability | null {
  switch (guard.capability) {
    case 'block_evidence':
      return needsBlock ? 'block_run' : null;
    case 'proof_plan_bound':
      return planRemedy(input, edge, facts);
    case 'review':
      if (
        guard.parameters.condition === 'clear' &&
        facts.currentReview &&
        !facts.clearReview &&
        facts.cleanBoundBranch &&
        !facts.setupFailures.length &&
        input.history.status === 'verified' &&
        input.history.repair_admission &&
        guard.required_actions.includes(input.history.repair_admission.action_id)
      )
        return 'repair_change';
      return proofRemedy(guard, facts);
    case 'local_proof':
    case 'independent_proof':
    case 'pre_pr_review':
      return proofRemedy(guard, facts);
    case 'human_approval':
    case 'completion_observed':
      return handoffRemedy(input, guard, facts);
    case 'repository':
      return repositoryRemedy(input, guard, facts);
    case 'artifact':
      return artifactRemedy(input, guard, facts);
    case 'phase':
    case 'recorded_prior_state':
    case 'stop_requested':
    case 'budget_available':
      return null;
  }
}

export function chooseWorkflowRemedy(
  input: ControllerInput,
  receipts: ControllerInput['receipts'],
  routes: WorkflowRoute[],
): WorkflowRemedy {
  const graph = input.compiled_graph.graph;
  const actions = new Map(graph.required_actions.map((action) => [action.id, action]));
  const source = graph.states.find((state) => state.id === input.binding.source_state);
  const facts = remedyFacts(input, receipts);
  const exhausted = exhaustedEntryExits(input, routes);
  const stop = receipts.find(({ payload }) => payload.type === 'stop_requested');
  const admittedAction = input.history.status === 'verified' ? input.history.repair_admission?.action_id : undefined;
  const candidates: SelectedAction[] = [];
  let nextPriority = stop || exhausted.size ? 0 : Infinity;
  for (const route of routes) {
    const { edge, checks } = route;
    if (source?.kind === 'suspended' && (input.history.status !== 'verified' || edge.to !== input.history.prior_state))
      continue;
    const blockWitness = exhausted.get(edge.id) ?? (stop ? [stop.id] : null);
    if (!applicableRoute(route, facts, blockWitness !== null, admittedAction)) continue;
    const compositeActions = new Set(
      checks
        .filter(
          ({ guard, evidenceIds }) =>
            evidenceIds === null && guard.capability === 'review' && guard.parameters.condition === 'proof_set_current',
        )
        .flatMap(({ guard }) => guard.required_actions),
    );
    for (const { guard, evidenceIds } of checks) {
      if (evidenceIds !== null) continue;
      let capability = neededCapability(input, edge, guard, facts, blockWitness !== null);
      if (source?.kind === 'suspended') {
        capability =
          guard.capability === 'human_approval' && guard.parameters.scope === 'recovery' ? 'recover_run' : null;
      }
      if (!capability) continue;
      for (const actionId of guard.required_actions) {
        const action = actions.get(actionId);
        if (!action || action.capability !== capability) continue;
        if (capability === 'recover_run' && (source?.kind !== 'suspended' || source.handoff !== actionId)) continue;
        if (capability === 'repair_change' && admittedAction !== actionId) continue;
        // The composite collection already requests the review that the individual predicates will inspect.
        if (
          capability === 'obtain_review_evidence' &&
          guard.capability === 'review' &&
          guard.parameters.condition !== 'proof_set_current' &&
          compositeActions.has(actionId)
        )
          continue;
        const priority = remedyPriority[capability];
        if (priority > nextPriority) continue;
        if (priority < nextPriority) candidates.length = 0;
        nextPriority = priority;
        const prior = candidates.find((entry) => entry.edge.id === edge.id && entry.action.id === actionId);
        if (prior) {
          prior.guardIds.push(guard.id);
          continue;
        }
        const selected: SelectedAction = { kind: 'action', edge, action, guardIds: [guard.id] };
        if (capability === 'repair_change') selected.supportingEvidenceIds = facts.repairEvidence;
        if (capability === 'correct_gate_setup') selected.supportingEvidenceIds = facts.setupFailures;
        if (capability === 'block_run' && blockWitness) selected.supportingEvidenceIds = blockWitness;
        candidates.push(selected);
      }
    }
  }
  return resolveCandidates(input, candidates);
}

function resolveCandidates(input: ControllerInput, candidates: SelectedAction[]): WorkflowRemedy {
  const authorities = new Set(input.policy.rules.authorities.map((authority) => authority.type));
  const edgeAuthorized = candidates.filter(({ edge }) => edge.authority.every((type) => authorities.has(type)));
  const authorized = edgeAuthorized.filter(({ action }) => action.authority !== 'human' || authorities.has('human'));
  if (authorized.length === 1) {
    const candidate = authorized[0]!;
    if (
      !input.available_capabilities.some(
        (item) => item.actor === candidate.action.authority && item.capability === candidate.action.capability,
      )
    )
      return {
        kind: 'blocked',
        reasons: [
          {
            code: 'UNSUPPORTED_CAPABILITY',
            action_id: candidate.action.id,
            message: 'The selected capability is unavailable for the declared actor.',
            recovery: 'Supply that actor capability and reevaluate the workflow.',
          },
        ],
      };
    return candidate;
  }
  if (candidates.length && !edgeAuthorized.length) {
    const transitions = [...new Set(candidates.map(({ edge }) => edge.id))].sort();
    return {
      kind: 'blocked',
      reasons: transitions.map((transition_id) => ({
        code: 'AUTHORITY_UNAVAILABLE',
        transition_id,
        message: 'The policy lacks an authority required by this transition.',
        recovery: 'Restore the required policy authority and reevaluate the workflow.',
      })),
    };
  }
  if (edgeAuthorized.length && !authorized.length)
    return {
      kind: 'blocked',
      reasons: [
        {
          code: 'NO_APPLICABLE_REMEDY',
          message: 'The otherwise applicable handoff requires a human policy identity.',
          recovery: 'Supply the required human policy identity and reevaluate the workflow.',
        },
      ],
    };
  if (authorized.length > 1)
    return {
      kind: 'blocked',
      reasons: [
        {
          code: 'AMBIGUOUS_REMEDY',
          message: 'Several declared remedies meet the same prerequisite.',
          recovery: 'Supply the facts or graph choice that resolves the competing remedies.',
        },
      ],
    };
  return {
    kind: 'blocked',
    reasons: [
      {
        code: 'NO_APPLICABLE_REMEDY',
        message: 'The graph has no applicable declared remedy for these facts.',
        recovery: 'Inspect the missing prerequisites and supply current evidence or authority.',
      },
    ],
  };
}
