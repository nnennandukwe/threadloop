import type { ControllerInput } from './contracts.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';

type Receipt = ControllerInput['receipts'][number];
type Guard = ControllerInput['compiled_graph']['graph']['guards'][number];
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);

export function hasRepairAdmission(input: ControllerInput, actionId: string): boolean {
  const admission = input.history.status === 'verified' ? input.history.repair_admission : null;
  return (
    admission !== null &&
    admission.action_id === actionId &&
    admission.bound_state_version === input.binding.state_version &&
    input.compiled_graph.graph.transitions.some(
      (edge) => edge.id === admission.transition_id && edge.to === input.binding.source_state,
    )
  );
}

// Check required facts of an asserted transition. No outgoing-edge search or remedy selection occurs here.
export function supportsGuard(input: ControllerInput, guard: Guard, receipts: Receipt[]): boolean {
  const history = input.history;
  const rules = input.policy.rules;
  const payloads = receipts.map((receipt) => receipt.payload);
  switch (guard.capability) {
    case 'proof_plan_bound':
      return (
        rules.proof_plan !== null &&
        rules.repository_binding !== null &&
        history.status === 'verified' &&
        (history.proof_plan_bound ||
          (input.observation.repository?.clean === true &&
            input.observation.repository.branch === rules.repository_binding.branch &&
            same(input.binding.subject, rules.repository_binding.baseline)))
      );
    case 'repository': {
      const observation = input.observation.repository;
      const binding = rules.repository_binding;
      if (!observation?.clean || !binding || observation.branch !== binding.branch) return false;
      switch (guard.parameters.condition) {
        case 'baseline_matches':
          return same(input.binding.subject, binding.baseline);
        case 'clean_plan_branch':
          return true;
        case 'clean_descendant':
        case 'committed_repair':
          return (
            history.status === 'verified' &&
            (guard.parameters.condition !== 'committed_repair' ||
              guard.required_actions.some((actionId) => hasRepairAdmission(input, actionId))) &&
            history.implementation_basis !== null &&
            same(observation.basis, history.implementation_basis) &&
            observation.relationship === 'descendant'
          );
      }
      break;
    }
    case 'phase':
      return history.status === 'verified' && history.phase === guard.parameters.value;
    case 'recorded_prior_state':
      return history.status === 'verified' && history.prior_state === guard.parameters.state;
    case 'budget_available': {
      const budget = input.compiled_graph.graph.budgets.find((budget) => budget.id === guard.parameters.budget)!;
      const used =
        history.status === 'verified'
          ? history.budget_counts.find((count) => count.budget_id === budget.id)?.used
          : undefined;
      return used !== undefined && used < budget.limit;
    }
    case 'local_proof': {
      const local = payloads.filter((payload) => payload.type === 'local_proof');
      const allPresent =
        rules.local_gate_ids.length > 0 &&
        rules.local_gate_ids.every((gate) => local.some((proof) => proof.gate_id === gate));
      return (
        allPresent &&
        (guard.parameters.result === 'passed'
          ? rules.local_gate_ids.every((gate) =>
              local.some((proof) => proof.gate_id === gate && proof.result === 'passed' && proof.clean),
            )
          : local.some((proof) => rules.local_gate_ids.includes(proof.gate_id) && proof.result === 'failed') &&
            local.every((proof) => proof.result !== 'setup_failed'))
      );
    }
    case 'independent_proof':
      return (
        rules.independent_gate_ids.length > 0 &&
        rules.independent_gate_ids.every((gate) =>
          payloads.some(
            (proof) => proof.type === 'independent_proof' && proof.gate_id === gate && proof.result === 'passed',
          ),
        )
      );
    case 'pre_pr_review':
      return payloads.some(
        (review) =>
          review.type === 'pre_pr_review' &&
          review.outcome === guard.parameters.outcome &&
          (review.outcome !== 'clean' || review.findings.every((finding) => !finding.blocking)),
      );
    case 'review': {
      const review = payloads.find((payload) => payload.type === 'review');
      if (!review) return false;
      const blocking =
        review.outcome === 'changes_required' ||
        review.findings.some((finding) => finding.blocking && !finding.outdated);
      if (guard.parameters.condition === 'current') return true;
      if (guard.parameters.condition === 'blocking') return blocking;
      if (guard.parameters.condition === 'clear') return !blocking;
      return (
        rules.local_gate_ids.length > 0 &&
        rules.local_gate_ids.every((gate) =>
          payloads.some(
            (proof) =>
              proof.type === 'local_proof' && proof.gate_id === gate && proof.result === 'passed' && proof.clean,
          ),
        ) &&
        rules.independent_gate_ids.length > 0 &&
        rules.independent_gate_ids.every((gate) =>
          payloads.some(
            (proof) => proof.type === 'independent_proof' && proof.gate_id === gate && proof.result === 'passed',
          ),
        )
      );
    }
    case 'human_approval':
      return payloads.some(
        (approval) =>
          approval.type === 'human_approval' &&
          approval.scope === guard.parameters.scope &&
          rules.authorities.some(
            (authority) => authority.type === 'human' && authority.identity.id === approval.approver.id,
          ),
      );
    case 'completion_observed':
      return payloads.some(
        (completion) =>
          completion.type === 'completion_observed' &&
          completion.kind === guard.parameters.kind &&
          (completion.kind !== 'publication' || completion.destination === rules.publication_destination),
      );
    case 'block_evidence':
      return payloads.some(
        (block) => block.type === 'block_evidence' && block.prior_state === input.binding.source_state,
      );
    case 'stop_requested':
      return payloads.some((stop) => stop.type === 'stop_requested');
    case 'artifact':
      return payloads.some(
        (artifact) =>
          artifact.type === 'artifact' &&
          artifact.stage === guard.parameters.stage &&
          artifact.result === guard.parameters.result,
      );
  }
}
