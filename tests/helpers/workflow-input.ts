import { readFileSync } from 'node:fs';
import { compileWorkflowProfile } from 'threadloop-contracts/workflow';
import type { ControllerInput } from 'threadloop-contracts/controller';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';

const governedProfile = readFileSync(
  new URL(import.meta.resolve('threadloop-contracts/assets/workflow-graph-v0.1/fixtures/valid/governed-pr.yaml')),
  'utf8',
);

export function makeWorkflowInput(profile: string = governedProfile): ControllerInput {
  const compiled = compileWorkflowProfile(profile);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const { graph, graph_digest } = compiled.value;
  const subject = {
    kind: 'repository' as const,
    repository_id: 'shipping',
    revision: 'first',
    content_digest: sha256('first tree'),
  };
  const proofGuard = graph.guards.find((guard) => guard.capability === 'proof_plan_bound');
  const rules: ControllerInput['policy']['rules'] = {
    selection: 'threadloop.remedies/0.1',
    proof_plan: proofGuard ? { id: 'shipping-plan', digest: sha256('shipping plan') } : null,
    proof_binding_transition_id: proofGuard
      ? (graph.transitions.find((edge) => edge.id === 'bind_plan' && edge.guard_refs.includes(proofGuard.id))?.id ??
        null)
      : null,
    repository_binding: { branch: 'feature', baseline: subject },
    publication_destination: null,
    local_gate_ids: ['unit'],
    independent_gate_ids: ['ci'],
    evidence_policies: [{ id: 'sensor', digest: sha256('sensor policy') }],
    authorities: [
      { type: 'threadloop', identity: { id: 'controller', digest: sha256('controller authority') } },
      { type: 'human', identity: { id: 'reviewer', digest: sha256('reviewer authority') } },
    ],
  };
  const capabilities = new Map<string, ControllerInput['available_capabilities'][number]>();
  for (const action of graph.required_actions) {
    const actor = {
      capability: action.capability,
      actor: action.authority,
    } as ControllerInput['available_capabilities'][number];
    capabilities.set(canonicalJson(actor), actor);
  }
  return {
    schema_version: '0.1',
    compiled_graph: compiled.value,
    binding: {
      workflow_run_id: 'shipping-run',
      graph_schema_version: '0.1',
      graph_digest,
      source_state: graph.initial_state,
      state_version: 1,
      subject,
    },
    observation: {
      id: 'checkout',
      subject,
      state_version: 1,
      status: 'verified',
      valid_until: null,
      repository: {
        branch: 'feature',
        clean: true,
        change_scope: 'within_plan',
        basis: subject,
        relationship: 'equal',
      },
    },
    history: {
      status: 'verified',
      digest: sha256('accepted history'),
      proof_plan_bound: Boolean(proofGuard),
      phase: graph.phase_policy ? 'pre_pr' : null,
      budget_counts: graph.budgets.map((budget) => ({ budget_id: budget.id, used: 0 })),
      prior_state: null,
      implementation_basis: subject,
      repair_admission: null,
    },
    policy: { id: 'shipping-policy', rules, digest: sha256(canonicalJson(rules)) },
    available_capabilities: Array.from(capabilities.values()),
    receipts: [],
    invalidated_claims: [],
    execution: { status: 'idle' },
    existing_requests: [],
    evaluation_time: '2026-01-01T00:00:00.000Z',
  };
}

export function addWorkflowReceipt(
  input: ControllerInput,
  id: string,
  payload: ControllerInput['receipts'][number]['payload'],
) {
  const receipt: ControllerInput['receipts'][number] = {
    id,
    workflow_run_id: input.binding.workflow_run_id,
    graph_digest: input.binding.graph_digest,
    source_state_version: input.binding.state_version,
    subject: input.binding.subject,
    sequence: Math.max(0, ...input.receipts.map((entry) => entry.sequence)) + 1,
    policy: input.policy.rules.evidence_policies[0]!,
    workflow_policy: { id: input.policy.id, digest: input.policy.digest },
    acceptance: { id: 'accepted-' + id, digest: sha256('acceptance ' + id) },
    valid_until: null,
    origin: { kind: 'observation' },
    payload,
    payload_digest: sha256(canonicalJson(payload)),
  };
  input.receipts.push(receipt);
  return receipt;
}
