import {
  buildActionRequest,
  type ActionIntent,
  type ActionRequest,
  type ControllerInput,
} from 'threadloop-contracts/controller';
import type { ValidationResult } from 'threadloop-contracts/workflow';
import { workflowGuardEvidence } from './workflow-guard-facts.js';
import type { WorkflowAction, WorkflowGuard } from './workflow-selection-types.js';
import type { WorkflowRemedy } from './workflow-remedies.js';

type SelectedAction = Extract<WorkflowRemedy, { kind: 'action' }>;

function requestInputs(input: ControllerInput, capability: WorkflowAction['capability']) {
  const result: ActionIntent['inputs'] = [];
  const plan = input.policy.rules.proof_plan;
  if (input.binding.subject.kind === 'repository' && plan) result.push({ role: 'proof_plan', artifact: plan });
  const basis = input.history.status === 'verified' ? input.history.implementation_basis : null;
  if (capability === 'commit_change' && basis?.kind === 'repository') {
    result.push({ role: 'implementation_basis', artifact: { id: basis.revision, digest: basis.content_digest } });
  }
  return result;
}

export function workflowGuardEvidenceFamily(
  guard: WorkflowGuard,
  capability: WorkflowAction['capability'],
): ActionIntent['evidence_requirements'][number]['family'] | null {
  switch (guard.capability) {
    case 'repository':
      return 'repository_observation';
    case 'proof_plan_bound':
      return 'proof_plan';
    case 'recorded_prior_state':
      return 'human_approval';
    case 'budget_available':
      return 'block_evidence';
    case 'phase':
      return null;
    case 'review':
      if (guard.parameters.condition === 'proof_set_current') {
        if (capability === 'run_local_gates' || capability === 'correct_gate_setup') return 'local_proof';
        if (capability === 'obtain_independent_proof') return 'independent_proof';
      }
      return 'review';
    default:
      return guard.capability;
  }
}

type GuardCondition<G = WorkflowGuard> = G extends WorkflowGuard ? Omit<G, 'id' | 'required_actions'> : never;

function supportingReceipts(
  input: ControllerInput,
  receipts: ControllerInput['receipts'],
  action: WorkflowAction,
): string[] {
  const witnesses = (condition: GuardCondition) =>
    workflowGuardEvidence(input, receipts, { id: 'prerequisite', required_actions: [], ...condition }) ?? [];
  const local = () => witnesses({ capability: 'local_proof', parameters: { result: 'passed' } });
  const independent = () => witnesses({ capability: 'independent_proof', parameters: {} });
  const review = () => witnesses({ capability: 'review', parameters: { condition: 'clear' } });
  const verifiedRelease = () =>
    witnesses({ capability: 'artifact', parameters: { stage: 'release_verified', result: 'passed' } });
  const approved = () => witnesses({ capability: 'human_approval', parameters: { scope: 'current_subject' } });
  switch (action.capability) {
    case 'obtain_independent_proof':
      return local();
    case 'record_pre_pr_review':
    case 'obtain_review_evidence':
      return [...local(), ...independent()];
    case 'approve_change':
      return input.binding.subject.kind === 'artifact'
        ? verifiedRelease()
        : [...local(), ...independent(), ...review()];
    case 'merge_change':
      return [...local(), ...independent(), ...review(), ...approved()];
    case 'verify_publication':
      return [...approved(), ...witnesses({ capability: 'completion_observed', parameters: { kind: 'publication' } })];
    case 'verify_release':
      return witnesses({ capability: 'artifact', parameters: { stage: 'release_prepared', result: 'passed' } });
    case 'publish_release':
      return [...verifiedRelease(), ...approved()];
    // The selection carries any receipt that establishes a stop, setup correction or repair intervention.
    case 'block_run':
    case 'correct_gate_setup':
    case 'repair_change':
    case 'frame_change':
    case 'bind_proof_plan':
    case 'restore_proof_authority':
    case 'restore_repository':
    case 'restore_evidence':
    case 'implement_change':
    case 'commit_change':
    case 'run_local_gates':
    case 'prepare_release':
    case 'recover_run':
      return [];
  }
}

export function buildSelectedWorkflowRequest(
  input: ControllerInput,
  receipts: ControllerInput['receipts'],
  choice: SelectedAction,
): ValidationResult<ActionRequest> {
  const evidenceIds = new Set([
    ...supportingReceipts(input, receipts, choice.action),
    ...(choice.supportingEvidenceIds ?? []),
  ]);
  const guardIds = new Set(choice.guardIds);
  return buildActionRequest(input, {
    action_id: choice.action.id,
    transition_id: choice.edge.id,
    guard_ids: choice.guardIds,
    inputs: requestInputs(input, choice.action.capability),
    evidence_ids: [...evidenceIds],
    evidence_requirements: input.compiled_graph.graph.guards
      .filter((guard) => guardIds.has(guard.id))
      .flatMap((guard) => {
        const family = workflowGuardEvidenceFamily(guard, choice.action.capability);
        return family ? [{ family, guard_id: guard.id, subject: input.binding.subject }] : [];
      }),
    valid_until: null,
  });
}
