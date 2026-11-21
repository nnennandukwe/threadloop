import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { ActionRequest, ControllerInput } from 'threadloop-contracts/controller';
import { buildSelectedWorkflowRequest } from '../../src/domain/workflow-action-request.js';
import { workflowDigest } from '../../src/domain/workflow-selection-types.js';
import { addWorkflowReceipt, makeWorkflowInput } from '../helpers/workflow-input.js';

function releaseInput() {
  const profile = readFileSync(
    new URL(
      import.meta.resolve('threadloop-contracts/assets/workflow-graph-v0.1/fixtures/valid/release-to-publish.yaml'),
    ),
    'utf8',
  );
  const input = makeWorkflowInput(profile);
  input.binding.subject = { kind: 'artifact', artifact_id: 'release-package', content_digest: 'a'.repeat(64) };
  input.observation.subject = input.binding.subject;
  input.observation.repository = null;
  input.policy.rules.publication_destination = 'release-registry';
  input.policy.digest = workflowDigest(input.policy.rules);
  return input;
}

function actionAt(
  input: ControllerInput,
  edgeId: string,
  guardId: string,
  capability: ActionRequest['request']['capability'],
) {
  const graph = input.compiled_graph.graph;
  const edge = graph.transitions.find((candidate) => candidate.id === edgeId)!;
  const guard = graph.guards.find((candidate) => candidate.id === guardId)!;
  const action = graph.required_actions.find(
    (candidate) => guard.required_actions.includes(candidate.id) && candidate.capability === capability,
  )!;
  input.binding.source_state = edge.from;
  return { kind: 'action' as const, edge, action, guardIds: [guard.id] };
}

it('binds independent proof to the local gate receipt, its deadline, the immutable plan and the selected guard', () => {
  const input = makeWorkflowInput();
  const choice = actionAt(input, 'human_handoff', 'review_set', 'obtain_independent_proof');
  const proof = addWorkflowReceipt(input, 'local_check', {
    type: 'local_proof',
    gate_id: 'unit',
    result: 'passed',
    clean: true,
  });
  input.evaluation_time = '2026-11-21T00:00:00.000Z';
  proof.valid_until = '2026-11-22T00:00:00.000Z';
  const request = buildSelectedWorkflowRequest(input, input.receipts, choice);

  expect(request).toMatchObject({
    ok: true,
    value: {
      request: {
        actor: 'executor',
        capability: 'obtain_independent_proof',
        action_id: choice.action.id,
        transition_id: 'human_handoff',
        guard_ids: ['review_set'],
        evidence_ids: ['local_check'],
        evidence_requirements: [
          { family: 'independent_proof', guard_id: 'review_set', subject: input.binding.subject },
        ],
        inputs: [{ role: 'proof_plan', artifact: input.policy.rules.proof_plan }],
        constraints: {
          require_current_subject: true,
          lifecycle_mutation: false,
          valid_until: '2026-11-22T00:00:00.000Z',
        },
      },
    },
  });
});

it('requests publication of the exact verified artifact after current-subject human approval', () => {
  const input = releaseInput();
  const choice = actionAt(input, 'check_publication', 'published', 'publish_release');
  addWorkflowReceipt(input, 'prepared', { type: 'artifact', stage: 'release_prepared', result: 'passed' });
  addWorkflowReceipt(input, 'verified', { type: 'artifact', stage: 'release_verified', result: 'passed' });
  addWorkflowReceipt(input, 'approval', {
    type: 'human_approval',
    scope: 'current_subject',
    approver: { type: 'human', id: 'reviewer' },
    reason: 'Reviewed this release',
  });
  const request = buildSelectedWorkflowRequest(input, input.receipts, choice);
  expect(request).toMatchObject({
    ok: true,
    value: {
      request: {
        actor: 'executor',
        binding: { subject: input.binding.subject },
        inputs: [],
        evidence_ids: ['approval', 'verified'],
        evidence_requirements: [
          { family: 'completion_observed', guard_id: 'published', subject: input.binding.subject },
        ],
      },
    },
  });
});

it('binds a commit request to the verified implementation basis and observed scoped working tree', () => {
  const input = makeWorkflowInput();
  const choice = actionAt(input, 'verify_implementation', 'work_committed', 'commit_change');
  if (
    input.history.status !== 'verified' ||
    input.binding.subject.kind !== 'repository' ||
    !input.observation.repository
  )
    throw new Error('Expected repository history');
  const basis = { ...input.binding.subject };
  input.history.implementation_basis = basis;
  input.history.proof_plan_bound = true;
  input.binding.subject = { ...basis, content_digest: 'c'.repeat(64) };
  input.observation.subject = input.binding.subject;
  input.observation.repository.clean = false;
  input.observation.repository.basis = basis;

  const request = buildSelectedWorkflowRequest(input, input.receipts, choice);
  expect(request).toMatchObject({
    ok: true,
    value: {
      request: {
        capability: 'commit_change',
        evidence_ids: [],
        inputs: [
          { role: 'implementation_basis', artifact: { id: basis.revision, digest: basis.content_digest } },
          { role: 'proof_plan', artifact: input.policy.rules.proof_plan },
        ],
        evidence_requirements: [
          { family: 'repository_observation', guard_id: 'work_committed', subject: input.binding.subject },
        ],
      },
    },
  });
});

it('keeps a merge request human and binds every prerequisite witness, omitting unrelated receipts', () => {
  const input = makeWorkflowInput();
  const choice = actionAt(input, 'complete', 'merged', 'merge_change');
  addWorkflowReceipt(input, 'unit_pass', { type: 'local_proof', gate_id: 'unit', result: 'passed', clean: true });
  addWorkflowReceipt(input, 'ci_pass', { type: 'independent_proof', gate_id: 'ci', result: 'passed' });
  addWorkflowReceipt(input, 'review_clear', { type: 'review', outcome: 'clean', findings: [] });
  addWorkflowReceipt(input, 'approved', {
    type: 'human_approval',
    scope: 'current_subject',
    approver: { type: 'human', id: 'reviewer' },
    reason: 'Checked this change',
  });
  addWorkflowReceipt(input, 'recovery', {
    type: 'human_approval',
    scope: 'recovery',
    approver: { type: 'human', id: 'reviewer' },
    reason: 'Recovery only',
  });
  expect(buildSelectedWorkflowRequest(input, input.receipts, choice)).toMatchObject({
    ok: true,
    value: {
      request: {
        actor: 'human',
        capability: 'merge_change',
        evidence_ids: ['approved', 'ci_pass', 'review_clear', 'unit_pass'],
        evidence_requirements: [{ family: 'completion_observed', guard_id: 'merged', subject: input.binding.subject }],
      },
    },
  });
});

it('sends a gate setup failure to the declared human with only the configured failing gate as evidence', () => {
  const input = makeWorkflowInput();
  const choice = {
    ...actionAt(input, 'enter_pre_pr_review', 'local_pass', 'correct_gate_setup'),
    supportingEvidenceIds: ['setup'],
  };
  addWorkflowReceipt(input, 'optional', {
    type: 'local_proof',
    gate_id: 'optional',
    result: 'setup_failed',
    clean: true,
  });
  addWorkflowReceipt(input, 'setup', { type: 'local_proof', gate_id: 'unit', result: 'setup_failed', clean: true });
  expect(buildSelectedWorkflowRequest(input, input.receipts, choice)).toMatchObject({
    ok: true,
    value: {
      request: {
        actor: 'human',
        capability: 'correct_gate_setup',
        evidence_ids: ['setup'],
        evidence_requirements: [{ family: 'local_proof', guard_id: 'local_pass', subject: input.binding.subject }],
      },
    },
  });
});

it('ties publication verification to the observed publication at the configured destination', () => {
  const input = releaseInput();
  const choice = actionAt(input, 'complete', 'publication_passed', 'verify_publication');
  addWorkflowReceipt(input, 'elsewhere', {
    type: 'completion_observed',
    kind: 'publication',
    destination: 'another-registry',
  });
  addWorkflowReceipt(input, 'published_here', {
    type: 'completion_observed',
    kind: 'publication',
    destination: 'release-registry',
  });
  const approval = addWorkflowReceipt(input, 'approval', {
    type: 'human_approval',
    scope: 'current_subject',
    approver: { type: 'human', id: 'reviewer' },
    reason: 'Approved this release.',
  });
  approval.valid_until = '2026-01-02T00:00:00.000Z';
  expect(buildSelectedWorkflowRequest(input, input.receipts, choice)).toMatchObject({
    ok: true,
    value: {
      request: {
        capability: 'verify_publication',
        evidence_ids: ['approval', 'published_here'],
        constraints: { valid_until: approval.valid_until },
      },
    },
  });
});

it('binds the human block request to the failure that exhausted the selected repair route', () => {
  const input = makeWorkflowInput();
  const selection = actionAt(input, 'block_verifying', 'block', 'block_run');
  if (input.history.status !== 'verified') throw new Error('Expected verified history');
  input.history.phase = 'post_pr';
  input.history.budget_counts[0]!.used = 3;
  addWorkflowReceipt(input, 'irrelevant_failure', {
    type: 'local_proof',
    gate_id: 'optional',
    result: 'failed',
    clean: true,
  });
  addWorkflowReceipt(input, 'failed_check', { type: 'local_proof', gate_id: 'unit', result: 'failed', clean: true });
  const choice = { ...selection, supportingEvidenceIds: ['failed_check'] };
  expect(buildSelectedWorkflowRequest(input, input.receipts, choice)).toMatchObject({
    ok: true,
    value: { request: { capability: 'block_run', evidence_ids: ['failed_check'], actor: 'human' } },
  });
});

it('refuses a stale setup receipt or an unavailable actor without returning an executable request', () => {
  const input = makeWorkflowInput();
  const choice = {
    ...actionAt(input, 'enter_pre_pr_review', 'local_pass', 'correct_gate_setup'),
    supportingEvidenceIds: ['setup'],
  };
  const setup = addWorkflowReceipt(input, 'setup', {
    type: 'local_proof',
    gate_id: 'unit',
    result: 'setup_failed',
    clean: true,
  });
  setup.valid_until = input.evaluation_time;
  const stale = buildSelectedWorkflowRequest(input, [], choice);
  expect(stale.ok ? [] : stale.diagnostics.map(({ code }) => code)).toContain('STALE_OR_MISSING_EVIDENCE');
  setup.valid_until = null;
  input.available_capabilities = input.available_capabilities.filter(
    (item) => item.capability !== 'correct_gate_setup',
  );
  const unavailable = buildSelectedWorkflowRequest(input, input.receipts, choice);
  expect(unavailable.ok ? [] : unavailable.diagnostics.map(({ code }) => code)).toEqual(['UNSUPPORTED_CAPABILITY']);
});
