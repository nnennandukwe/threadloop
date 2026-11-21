import type { ControllerInput } from 'threadloop-contracts/controller';
import { canonicalJson } from './canonical-json.js';
import type { WorkflowEdge, WorkflowGuard } from './workflow-selection-types.js';

type Receipt = ControllerInput['receipts'][number];
type Payload = Receipt['payload'];

function evidenceStream(payload: Payload): string {
  switch (payload.type) {
    case 'local_proof':
    case 'independent_proof':
      return canonicalJson([payload.type, payload.gate_id]);
    case 'artifact':
      return canonicalJson([payload.type, payload.stage]);
    case 'human_approval':
      return canonicalJson([payload.type, payload.scope, payload.approver]);
    case 'completion_observed':
      return canonicalJson([payload.type, payload.kind, payload.destination]);
    case 'block_evidence':
      return canonicalJson([payload.type, payload.prior_state]);
    case 'proof_plan':
    case 'pre_pr_review':
    case 'review':
    case 'stop_requested':
      return payload.type;
  }
}

export function currentWorkflowReceipts(input: ControllerInput): Receipt[] {
  const subject = canonicalJson(input.binding.subject);
  const latest = new Map<string, Receipt>();
  for (const receipt of input.receipts) {
    if (
      receipt.workflow_policy.id !== input.policy.id ||
      receipt.workflow_policy.digest !== input.policy.digest ||
      canonicalJson(receipt.subject) !== subject
    )
      continue;
    const stream = evidenceStream(receipt.payload);
    const previous = latest.get(stream);
    if (!previous || receipt.sequence > previous.sequence) latest.set(stream, receipt);
  }
  const invalidated = new Set(input.invalidated_claims.map((claim) => canonicalJson(claim)));
  return [...latest.values()].filter((receipt) => {
    if (
      receipt.valid_until !== null &&
      (input.evaluation_time === null || input.evaluation_time >= receipt.valid_until)
    ) {
      return false;
    }
    return receipt.origin.kind !== 'attempt' || !invalidated.has(canonicalJson(receipt.origin.claim));
  });
}

function cleanBoundBranch(input: ControllerInput): boolean {
  const binding = input.policy.rules.repository_binding;
  const observation = input.observation.repository;
  return (
    binding !== null &&
    observation?.clean === true &&
    observation.branch === binding.branch &&
    input.binding.subject.kind === 'repository' &&
    input.binding.subject.repository_id === binding.baseline.repository_id
  );
}

function matchesBaseline(input: ControllerInput): boolean {
  return (
    cleanBoundBranch(input) &&
    canonicalJson(input.binding.subject) === canonicalJson(input.policy.rules.repository_binding?.baseline)
  );
}

function boundProofPlan(input: ControllerInput): boolean {
  return (
    input.history.status === 'verified' &&
    input.history.proof_plan_bound &&
    input.policy.rules.proof_plan !== null &&
    input.policy.rules.repository_binding !== null
  );
}

function localProof(input: ControllerInput, receipts: Receipt[], result: 'passed' | 'failed'): string[] | null {
  if (!boundProofPlan(input)) return null;
  const required = new Set(input.policy.rules.local_gate_ids);
  const ids: string[] = [];
  let hasFailure = false;
  for (const { id, payload } of receipts) {
    if (payload.type !== 'local_proof' || !required.has(payload.gate_id)) continue;
    if (payload.result === 'setup_failed' || (result === 'passed' && (payload.result !== 'passed' || !payload.clean))) {
      return null;
    }
    if (payload.result === 'failed') hasFailure = true;
    ids.push(id);
  }
  return ids.length > 0 && ids.length === required.size && (result === 'passed' || hasFailure) ? ids.sort() : null;
}

function independentProof(input: ControllerInput, receipts: Receipt[]): string[] | null {
  if (!boundProofPlan(input)) return null;
  const required = new Set(input.policy.rules.independent_gate_ids);
  const ids = receipts
    .filter(
      ({ payload }) =>
        payload.type === 'independent_proof' && required.has(payload.gate_id) && payload.result === 'passed',
    )
    .map(({ id }) => id);
  return ids.length > 0 && ids.length === required.size ? ids.sort() : null;
}

function latestWitness(receipts: Receipt[], matches: (payload: Payload) => boolean): string[] | null {
  let latest: Receipt | undefined;
  for (const receipt of receipts) {
    if (matches(receipt.payload) && (!latest || receipt.sequence > latest.sequence)) latest = receipt;
  }
  return latest ? [latest.id] : null;
}

export function workflowGuardEvidence(
  input: ControllerInput,
  receipts: Receipt[],
  guard: WorkflowGuard,
  edge?: WorkflowEdge,
): string[] | null {
  switch (guard.capability) {
    case 'proof_plan_bound': {
      if (boundProofPlan(input)) return [];
      const rules = input.policy.rules;
      return input.history.status === 'verified' &&
        rules.proof_plan !== null &&
        edge !== undefined &&
        edge.id === rules.proof_binding_transition_id &&
        matchesBaseline(input)
        ? []
        : null;
    }
    case 'repository': {
      if (!cleanBoundBranch(input)) return null;
      const condition = guard.parameters.condition;
      if (condition === 'clean_plan_branch') return [];
      if (condition === 'baseline_matches') return matchesBaseline(input) ? [] : null;
      const history = input.history;
      if (history.status !== 'verified') return null;
      const current = input.binding.subject;
      const basis = history.implementation_basis;
      const observation = input.observation.repository;
      if (
        observation?.relationship !== 'descendant' ||
        current.kind !== 'repository' ||
        basis?.kind !== 'repository' ||
        current.repository_id !== basis.repository_id ||
        current.revision === basis.revision ||
        canonicalJson(observation.basis) !== canonicalJson(basis)
      )
        return null;
      if (condition === 'clean_descendant') return [];
      const admission = history.repair_admission;
      return admission !== null &&
        guard.required_actions.includes(admission.action_id) &&
        admission.bound_state_version === input.binding.state_version &&
        input.compiled_graph.graph.transitions.some(
          (entry) => entry.id === admission.transition_id && entry.to === input.binding.source_state,
        )
        ? []
        : null;
    }
    case 'stop_requested':
      return latestWitness(receipts, (payload) => payload.type === 'stop_requested');
    case 'block_evidence':
      return latestWitness(
        receipts,
        (payload) => payload.type === 'block_evidence' && payload.prior_state === input.binding.source_state,
      );
    case 'phase':
      return input.history.status === 'verified' && input.history.phase === guard.parameters.value ? [] : null;
    case 'recorded_prior_state':
      return input.history.status === 'verified' && input.history.prior_state === guard.parameters.state ? [] : null;
    case 'budget_available': {
      if (input.history.status !== 'verified') return null;
      const budget = input.compiled_graph.graph.budgets.find((item) => item.id === guard.parameters.budget);
      const count = input.history.budget_counts.find((item) => item.budget_id === guard.parameters.budget);
      return budget && count && count.used < budget.limit ? [] : null;
    }
    case 'artifact':
      return latestWitness(
        receipts,
        (payload) =>
          payload.type === 'artifact' &&
          payload.stage === guard.parameters.stage &&
          payload.result === guard.parameters.result,
      );
    case 'human_approval':
      return latestWitness(
        receipts,
        (payload) =>
          payload.type === 'human_approval' &&
          payload.scope === guard.parameters.scope &&
          input.policy.rules.authorities.some(
            (authority) => authority.type === 'human' && authority.identity.id === payload.approver.id,
          ),
      );
    case 'completion_observed':
      return latestWitness(
        receipts,
        (payload) =>
          payload.type === 'completion_observed' &&
          payload.kind === guard.parameters.kind &&
          (payload.kind !== 'publication' || payload.destination === input.policy.rules.publication_destination),
      );
    case 'local_proof':
      return localProof(input, receipts, guard.parameters.result);
    case 'independent_proof':
      return independentProof(input, receipts);
    case 'pre_pr_review':
      if (!boundProofPlan(input)) return null;
      return latestWitness(
        receipts,
        (payload) =>
          payload.type === 'pre_pr_review' &&
          payload.outcome === guard.parameters.outcome &&
          (payload.outcome !== 'clean' || payload.findings.every((finding) => !finding.blocking)),
      );
    case 'review': {
      if (!boundProofPlan(input)) return null;
      const review = receipts.find(({ payload }) => payload.type === 'review');
      if (review?.payload.type !== 'review') return null;
      const blocking =
        review.payload.outcome === 'changes_required' ||
        review.payload.findings.some((finding) => finding.blocking && !finding.outdated);
      switch (guard.parameters.condition) {
        case 'current':
          return [review.id];
        case 'blocking':
          return blocking ? [review.id] : null;
        case 'clear':
          return blocking ? null : [review.id];
        case 'proof_set_current': {
          const local = localProof(input, receipts, 'passed');
          const independent = independentProof(input, receipts);
          return local && independent ? [...local, ...independent, review.id].sort() : null;
        }
      }
    }
  }
}

export type WorkflowRoute = {
  edge: WorkflowEdge;
  checks: { guard: WorkflowGuard; evidenceIds: string[] | null }[];
};

function terminalGuardOrder(guard: WorkflowGuard): number {
  if (guard.capability === 'review') {
    switch (guard.parameters.condition) {
      case 'current':
        return 1;
      case 'clear':
      case 'blocking':
        return 2;
      case 'proof_set_current':
        return 3;
    }
  }
  if (guard.capability === 'human_approval') return 4;
  if (guard.capability === 'completion_observed') return 5;
  return 0;
}

export function evaluateWorkflowRoutes(input: ControllerInput, receipts: Receipt[]): WorkflowRoute[] {
  const graph = input.compiled_graph.graph;
  const guards = new Map(graph.guards.map((guard) => [guard.id, guard]));
  const terminals = new Set(graph.states.filter((state) => state.kind === 'terminal').map((state) => state.id));
  return graph.transitions
    .filter((edge) => edge.from === input.binding.source_state)
    .map((edge) => {
      const required = edge.guard_refs.map((guardId) => guards.get(guardId)!);
      if (terminals.has(edge.to)) required.sort((a, b) => terminalGuardOrder(a) - terminalGuardOrder(b));
      const checks = required.map((guard) => ({
        guard,
        evidenceIds: workflowGuardEvidence(input, receipts, guard, edge),
      }));
      return { edge, checks };
    });
}
