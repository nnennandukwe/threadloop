import { readFile } from 'node:fs/promises';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { compiledGraphSchema } from '../../scripts/workflow-graph/contracts.js';
import {
  controllerInputSchema,
  type ActionIntent,
  type ControllerInput,
} from '../../scripts/controller-contract/contracts.js';

export async function controllerSnapshot(
  profile: 'governed-pr' | 'release-to-publish' = 'governed-pr',
): Promise<ControllerInput> {
  const compiled = compiledGraphSchema.parse(
    JSON.parse(
      await readFile(
        new URL(`../../docs/contracts/workflow-graph-v0.1/fixtures/valid/${profile}.compiled.json`, import.meta.url),
        'utf8',
      ),
    ),
  );
  const subject =
    profile === 'governed-pr'
      ? {
          kind: 'repository',
          repository_id: 'sample_repository',
          revision: 'commit_b',
          content_digest: sha256('commit_b_tree'),
        }
      : { kind: 'artifact', artifact_id: 'sample_release', content_digest: sha256('release_b') };
  const identity = { id: 'trusted_evidence', digest: sha256('trusted_evidence_policy') };
  const rules = {
    selection: 'threadloop.remedies/0.1',
    proof_plan: profile === 'governed-pr' ? { id: 'proof_plan', digest: sha256('proof_plan') } : null,
    proof_binding_transition_id: profile === 'governed-pr' ? 'bind_plan' : null,
    repository_binding: profile === 'governed-pr' ? { branch: 'feature', baseline: subject } : null,
    publication_destination: profile === 'release-to-publish' ? 'release_channel' : null,
    local_gate_ids: profile === 'governed-pr' ? ['check'] : [],
    independent_gate_ids: profile === 'governed-pr' ? ['check'] : [],
    evidence_policies: [identity],
    authorities: [
      { type: 'threadloop', identity: { id: 'controller', digest: sha256('controller') } },
      { type: 'human', identity: { id: 'maintainer', digest: sha256('maintainer') } },
    ],
  };
  return controllerInputSchema.parse({
    schema_version: '0.1',
    compiled_graph: compiled,
    binding: {
      workflow_run_id: 'workflow_1',
      graph_schema_version: '0.1',
      graph_digest: compiled.graph_digest,
      source_state: profile === 'governed-pr' ? 'reviewing' : 'awaiting_approval',
      state_version: 5,
      subject,
    },
    observation: {
      id: 'observation_b',
      subject,
      state_version: 5,
      status: 'verified',
      valid_until: null,
      repository:
        profile === 'governed-pr'
          ? { branch: 'feature', clean: true, change_scope: 'unknown', basis: subject, relationship: 'equal' }
          : null,
    },
    history: {
      status: 'verified',
      digest: sha256('verified_history'),
      proof_plan_bound: profile === 'governed-pr',
      phase: profile === 'governed-pr' ? 'post_pr' : null,
      budget_counts: compiled.graph.budgets.map((budget) => ({ budget_id: budget.id, used: 0 })),
      prior_state: null,
      implementation_basis: null,
      repair_admission: null,
    },
    policy: { id: 'workflow_policy', digest: sha256(canonicalJson(rules)), rules },
    available_capabilities: compiled.graph.required_actions.map((action) => ({
      capability: action.capability,
      actor: action.authority,
    })),
    receipts: [],
    invalidated_claims: [],
    execution: { status: 'idle' },
    existing_requests: [],
    evaluation_time: null,
  });
}

export function localProofIntent(input: ControllerInput): ActionIntent {
  return {
    action_id: 'run_gates',
    transition_id: 'human_handoff',
    guard_ids: ['review_set'],
    inputs: [{ role: 'proof_plan', artifact: input.policy.rules.proof_plan! }],
    evidence_ids: [],
    evidence_requirements: [{ family: 'local_proof', guard_id: 'review_set', subject: input.binding.subject }],
    valid_until: null,
  };
}
