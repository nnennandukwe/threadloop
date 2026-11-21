import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ControllerInput } from 'threadloop-contracts/controller';
import { workflowDigest } from '../../src/domain/workflow-selection-types.js';
import { parse, stringify } from 'yaml';
import { selectWorkflowDecision } from '../../src/domain/workflow-controller.js';
import { addWorkflowReceipt, makeWorkflowInput } from '../helpers/workflow-input.js';

function releaseInput() {
  const profile = readFileSync(
    new URL(
      import.meta.resolve('threadloop-contracts/assets/workflow-graph-v0.1/fixtures/valid/release-to-publish.yaml'),
    ),
    'utf8',
  );
  const input = makeWorkflowInput(profile);
  input.binding.subject = { kind: 'artifact', artifact_id: 'toolkit', content_digest: 'a'.repeat(64) };
  input.observation.subject = input.binding.subject;
  input.observation.repository = null;
  input.policy.rules.repository_binding = null;
  input.policy.rules.publication_destination = 'stable';
  input.policy.digest = workflowDigest(input.policy.rules);
  return input;
}

function choose(input: ControllerInput) {
  const result = selectWorkflowDecision(input);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  const decision = result.value.decision;
  if (!('action_request' in decision)) return { kind: decision.outcome, ...decision };
  const request = decision.action_request.request;
  return {
    kind: 'action',
    action: { capability: request.capability, authority: request.actor },
    edge: input.compiled_graph.graph.transitions.find((edge) => edge.id === request.transition_id),
    guardIds: request.guard_ids,
    supportingEvidenceIds: request.evidence_ids,
  };
}

describe('workflow remedy selection', () => {
  it('selects independent proof after current local proof passes', () => {
    const input = makeWorkflowInput();
    input.binding.source_state = 'verifying';
    addWorkflowReceipt(input, 'checked', { type: 'local_proof', gate_id: 'unit', result: 'passed', clean: true });
    expect(choose(input)).toMatchObject({
      kind: 'action',
      action: { capability: 'obtain_independent_proof' },
      guardIds: ['independent'],
    });
  });

  it('blocks when either of two declared actions could collect the same missing gate', () => {
    const url = import.meta.resolve('threadloop-contracts/assets/workflow-graph-v0.1/fixtures/valid/governed-pr.yaml');
    const profile = parse(readFileSync(new URL(url), 'utf8')) as {
      guards: { id: string; required_actions: string[] }[];
      required_actions: { id: string; capability: string }[];
      transitions: { guard_refs: string[] }[];
    };
    const collector = profile.required_actions.find((action) => action.capability === 'run_local_gates')!;
    const alternate = { ...collector, id: 'collect_in_workspace' };
    profile.required_actions.push(alternate);
    const guard = profile.guards.find((guard) => guard.id === 'local_pass')!;
    for (const edge of profile.transitions)
      edge.guard_refs = edge.guard_refs.map((id) => (id === guard.id ? 'local_witness' : id));
    guard.id = 'local_witness';
    for (const order of [[alternate.id, collector.id], [collector.id, alternate.id], [alternate.id]]) {
      guard.required_actions = order;
      const input = makeWorkflowInput(stringify(profile, { aliasDuplicateObjects: false }));
      input.binding.source_state = 'verifying';
      const result = choose(input);
      if (order.length === 2)
        expect(result).toMatchObject({ kind: 'blocked', reasons: [{ code: 'AMBIGUOUS_REMEDY' }] });
      else
        expect(result).toMatchObject({
          kind: 'action',
          action: { capability: 'run_local_gates' },
          guardIds: ['local_witness'],
        });
    }
  });

  it('collects post-PR review evidence after both configured proof sets pass', () => {
    const input = makeWorkflowInput();
    input.binding.source_state = 'reviewing';
    if (input.history.status === 'verified') input.history.phase = 'post_pr';
    addWorkflowReceipt(input, 'checked', { type: 'local_proof', gate_id: 'unit', result: 'passed', clean: true });
    addWorkflowReceipt(input, 'independent', { type: 'independent_proof', gate_id: 'ci', result: 'passed' });
    expect(choose(input)).toMatchObject({
      kind: 'action',
      action: { capability: 'obtain_review_evidence' },
      guardIds: ['review_set'],
    });
  });

  it('corrects a configured setup failure without admitting code repair', () => {
    const input = makeWorkflowInput();
    input.binding.source_state = 'verifying';
    if (input.history.status === 'verified') input.history.phase = 'post_pr';
    addWorkflowReceipt(input, 'bad_setup', {
      type: 'local_proof',
      gate_id: 'unit',
      result: 'setup_failed',
      clean: true,
    });
    expect(choose(input)).toMatchObject({
      kind: 'action',
      edge: { id: 'return_to_review' },
      action: { capability: 'correct_gate_setup' },
      supportingEvidenceIds: ['bad_setup'],
    });
  });

  it('requests block evidence on the declared exit when a counted failure exhausts its budget', () => {
    const input = makeWorkflowInput();
    input.binding.source_state = 'verifying';
    if (input.history.status !== 'verified') throw new Error('Expected verified history');
    input.history.phase = 'post_pr';
    input.history.budget_counts[0]!.used = 3;
    addWorkflowReceipt(input, 'failing_check', { type: 'local_proof', gate_id: 'unit', result: 'failed', clean: true });
    expect(choose(input)).toMatchObject({
      kind: 'action',
      edge: { id: 'block_verifying' },
      action: { capability: 'block_run' },
      supportingEvidenceIds: ['failing_check'],
    });
  });

  it('requires current proof and clear review before requesting exact-subject human approval', () => {
    const input = makeWorkflowInput();
    input.binding.source_state = 'ready_for_human';
    if (input.history.status === 'verified') input.history.phase = 'post_pr';
    addWorkflowReceipt(input, 'local', { type: 'local_proof', gate_id: 'unit', result: 'passed', clean: true });
    addWorkflowReceipt(input, 'independent', { type: 'independent_proof', gate_id: 'ci', result: 'passed' });
    addWorkflowReceipt(input, 'review', { type: 'review', outcome: 'clean', findings: [] });
    expect(choose(input)).toMatchObject({
      kind: 'action',
      action: { capability: 'approve_change', authority: 'human' },
    });
    addWorkflowReceipt(input, 'approved', {
      type: 'human_approval',
      scope: 'current_subject',
      approver: { type: 'human', id: 'reviewer' },
      reason: 'Approved the exact commit.',
    });
    expect(choose(input)).toMatchObject({ kind: 'action', action: { capability: 'merge_change', authority: 'human' } });
  });

  it('blocks when the declared actor lacks the selected collection capability', () => {
    const input = makeWorkflowInput();
    input.binding.source_state = 'verifying';
    input.available_capabilities = input.available_capabilities.filter(
      (available) => available.capability !== 'run_local_gates',
    );
    expect(choose(input)).toMatchObject({
      kind: 'blocked',
      reasons: [{ code: 'UNSUPPORTED_CAPABILITY', action_id: 'run_gates' }],
    });
  });

  it('permits the last admitted repair and its scoped commit without opening another entry', () => {
    const input = makeWorkflowInput();
    input.binding.source_state = 'repairing';
    if (
      input.history.status !== 'verified' ||
      input.binding.subject.kind !== 'repository' ||
      !input.observation.repository
    )
      throw new Error('Expected repository state');
    input.history.phase = 'post_pr';
    input.history.budget_counts[0]!.used = 3;
    input.history.repair_admission = {
      action_id: 'repair',
      transition_id: 'repair_failed_proof',
      entry_state_version: 1,
      bound_state_version: 1,
      budget_id: 'repair_entries',
      consumed: 3,
    };
    addWorkflowReceipt(input, 'failed_check', { type: 'local_proof', gate_id: 'unit', result: 'failed', clean: true });
    expect(choose(input)).toMatchObject({
      kind: 'action',
      action: { capability: 'repair_change' },
      supportingEvidenceIds: ['failed_check'],
    });
    input.binding.subject = { ...input.binding.subject, content_digest: 'a'.repeat(64) };
    input.observation.subject = input.binding.subject;
    input.observation.repository.clean = false;
    expect(choose(input)).toMatchObject({ kind: 'action', action: { capability: 'commit_change' } });
    input.history.repair_admission = null;
    expect(choose(input)).toMatchObject({ kind: 'blocked', reasons: [{ code: 'NO_APPLICABLE_REMEDY' }] });
  });

  it('honors an explicit stop before collecting ordinary missing proof', () => {
    const input = makeWorkflowInput();
    input.binding.source_state = 'verifying';
    addWorkflowReceipt(input, 'stop', { type: 'stop_requested', reason: 'Operator requested a stop.' });
    expect(choose(input)).toMatchObject({
      kind: 'action',
      action: { capability: 'block_run' },
      supportingEvidenceIds: ['stop'],
    });
  });

  it('requests recovery only to the verified prior state', () => {
    const input = makeWorkflowInput();
    input.binding.source_state = 'blocked';
    if (input.history.status !== 'verified') throw new Error('Expected verified history');
    input.history.prior_state = 'implementing';
    expect(choose(input)).toMatchObject({
      kind: 'action',
      action: { capability: 'recover_run', authority: 'human' },
      edge: { to: 'implementing' },
      guardIds: ['recovery'],
    });
  });

  it('uses the declared bootstrap edge for a new plan and retains prior authority during restoration', () => {
    const input = makeWorkflowInput();
    if (input.history.status !== 'verified') throw new Error('Expected verified history');
    input.history.proof_plan_bound = false;
    input.policy.rules.proof_plan = null;
    input.policy.digest = workflowDigest(input.policy.rules);
    input.binding.source_state = 'framed';
    expect(choose(input)).toMatchObject({ kind: 'action', action: { capability: 'bind_proof_plan' } });
    input.binding.source_state = 'implementing';
    expect(choose(input)).toMatchObject({ kind: 'blocked', reasons: [{ code: 'NO_APPLICABLE_REMEDY' }] });
    input.history.proof_plan_bound = true;
    expect(choose(input)).toMatchObject({ kind: 'action', action: { capability: 'restore_proof_authority' } });
  });

  it('uses the artifact stage and observes the approved publication before verifying it', () => {
    const input = releaseInput();
    expect(choose(input)).toMatchObject({ kind: 'action', action: { capability: 'prepare_release' } });
    input.binding.source_state = 'verifying';
    addWorkflowReceipt(input, 'prepared', { type: 'artifact', stage: 'release_prepared', result: 'passed' });
    expect(choose(input)).toMatchObject({ kind: 'action', action: { capability: 'verify_release' } });
    input.binding.source_state = 'publication_check';
    addWorkflowReceipt(input, 'verified', { type: 'artifact', stage: 'release_verified', result: 'passed' });
    addWorkflowReceipt(input, 'approval', {
      type: 'human_approval',
      scope: 'current_subject',
      approver: { type: 'human', id: 'reviewer' },
      reason: 'Approved the artifact.',
    });
    addWorkflowReceipt(input, 'elsewhere', {
      type: 'completion_observed',
      kind: 'publication',
      destination: 'testing',
    });
    expect(choose(input)).toMatchObject({ kind: 'action', action: { capability: 'publish_release' } });
    addWorkflowReceipt(input, 'published', { type: 'completion_observed', kind: 'publication', destination: 'stable' });
    expect(choose(input)).toMatchObject({ kind: 'action', action: { capability: 'verify_publication' } });
  });

  it('requests pre-PR review after both proof sets pass while review changes remain unobserved', () => {
    const input = makeWorkflowInput();
    input.binding.source_state = 'pre_pr_reviewing';
    addWorkflowReceipt(input, 'local', { type: 'local_proof', gate_id: 'unit', result: 'passed', clean: true });
    addWorkflowReceipt(input, 'independent', { type: 'independent_proof', gate_id: 'ci', result: 'passed' });
    expect(choose(input)).toMatchObject({
      kind: 'action',
      action: { capability: 'record_pre_pr_review' },
      edge: { id: 'enter_review' },
    });
    addWorkflowReceipt(input, 'changes', { type: 'pre_pr_review', outcome: 'changes_required', findings: [] });
    expect(selectWorkflowDecision(input)).toMatchObject({
      ok: true,
      value: { decision: { outcome: 'transition_available', transition_id: 'address_pre_pr_review' } },
    });
  });

  it('requires the edge authority and the declared actor identity before issuing a handoff', () => {
    for (const authority of ['threadloop', 'human']) {
      const input = makeWorkflowInput();
      input.binding.source_state = 'verifying';
      input.policy.rules.authorities = input.policy.rules.authorities.filter((item) => item.type === authority);
      input.policy.digest = workflowDigest(input.policy.rules);
      addWorkflowReceipt(input, 'setup', { type: 'local_proof', gate_id: 'unit', result: 'setup_failed', clean: true });
      const expected =
        authority === 'threadloop'
          ? { code: 'NO_APPLICABLE_REMEDY' }
          : { code: 'AUTHORITY_UNAVAILABLE', transition_id: 'enter_pre_pr_review' };
      expect(choose(input)).toMatchObject({ kind: 'blocked', reasons: [expected] });
    }
  });

  it('restores a mismatched bound checkout and blocks work outside the declared implementation basis', () => {
    const input = makeWorkflowInput();
    input.binding.source_state = 'implementing';
    const checkout = input.observation.repository!;
    expect(choose(input)).toMatchObject({ kind: 'action', action: { capability: 'implement_change' } });
    checkout.clean = false;
    checkout.change_scope = 'outside_plan';
    expect(choose(input)).toMatchObject({ kind: 'blocked', reasons: [{ code: 'NO_APPLICABLE_REMEDY' }] });
    input.binding.source_state = 'verifying';
    checkout.branch = 'unbound';
    expect(choose(input)).toMatchObject({ kind: 'action', action: { capability: 'restore_repository' } });
    input.binding.source_state = 'reviewing';
    expect(choose(input)).toMatchObject({ kind: 'blocked', reasons: [{ code: 'NO_APPLICABLE_REMEDY' }] });
  });

  it('collects current local evidence on the progress path before requesting independent proof or review', () => {
    const input = makeWorkflowInput();
    input.binding.source_state = 'verifying';
    expect(selectWorkflowDecision(input)).toMatchObject({
      ok: true,
      value: {
        decision: {
          outcome: 'engineering_action_required',
          action_request: { request: { capability: 'run_local_gates', transition_id: 'enter_pre_pr_review' } },
        },
      },
    });
  });
});
