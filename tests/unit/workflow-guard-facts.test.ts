import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  currentWorkflowReceipts,
  evaluateWorkflowRoutes,
  workflowGuardEvidence,
} from '../../src/domain/workflow-guard-facts.js';
import type { WorkflowGuard } from '../../src/domain/workflow-selection-types.js';
import { addWorkflowReceipt, makeWorkflowInput } from '../helpers/workflow-input.js';

it('never revives a superseded local gate receipt when its replacement expires', () => {
  const input = makeWorkflowInput();
  addWorkflowReceipt(input, 'prior_pass', { type: 'local_proof', gate_id: 'unit', result: 'passed', clean: true });
  const replacement = addWorkflowReceipt(input, 'new_result', {
    type: 'local_proof',
    gate_id: 'unit',
    result: 'failed',
    clean: true,
  });
  input.evaluation_time = '2026-11-21T12:00:00.000Z';
  replacement.valid_until = input.evaluation_time;
  addWorkflowReceipt(input, 'other_gate', { type: 'local_proof', gate_id: 'docs', result: 'passed', clean: true });

  expect(currentWorkflowReceipts(input).map((receipt) => receipt.id)).toEqual(['other_gate']);
});

it('requires every configured local result to distinguish code failure from a gate setup failure', () => {
  const input = makeWorkflowInput();
  input.policy.rules.local_gate_ids = ['unit', 'style'];
  const guard = input.compiled_graph.graph.guards.find((entry) => entry.id === 'local_fail')!;
  const evidence = () => workflowGuardEvidence(input, currentWorkflowReceipts(input), guard);
  addWorkflowReceipt(input, 'unit_failed', { type: 'local_proof', gate_id: 'unit', result: 'failed', clean: true });
  expect(evidence()).toBeNull();
  addWorkflowReceipt(input, 'style_setup', {
    type: 'local_proof',
    gate_id: 'style',
    result: 'setup_failed',
    clean: true,
  });
  expect(evidence()).toBeNull();
  addWorkflowReceipt(input, 'extra_setup', {
    type: 'local_proof',
    gate_id: 'extra',
    result: 'setup_failed',
    clean: true,
  });
  addWorkflowReceipt(input, 'style_passed', { type: 'local_proof', gate_id: 'style', result: 'passed', clean: true });
  expect(evidence()).toEqual(['style_passed', 'unit_failed']);
});

it('reports current review evidence together with all clean local and independent witnesses for the proof set', () => {
  const input = makeWorkflowInput();
  const guard = input.compiled_graph.graph.guards.find((entry) => entry.id === 'review_set')!;
  const evidence = () => workflowGuardEvidence(input, currentWorkflowReceipts(input), guard);
  addWorkflowReceipt(input, 'unit', { type: 'local_proof', gate_id: 'unit', result: 'passed', clean: true });
  addWorkflowReceipt(input, 'ci', { type: 'independent_proof', gate_id: 'ci', result: 'passed' });
  addWorkflowReceipt(input, 'unused', { type: 'independent_proof', gate_id: 'extra', result: 'failed' });
  expect(evidence()).toBeNull();
  addWorkflowReceipt(input, 'review', { type: 'review', outcome: 'clean', findings: [] });
  expect(evidence()).toEqual(['ci', 'review', 'unit']);
  addWorkflowReceipt(input, 'dirty', { type: 'local_proof', gate_id: 'unit', result: 'passed', clean: false });
  expect(evidence()).toBeNull();
});

it('orders terminal review, approval and delivery by their guard meaning while retaining ordinary graph order', () => {
  const profile = readFileSync(
    new URL(import.meta.resolve('threadloop-contracts/assets/workflow-graph-v0.1/fixtures/valid/governed-pr.yaml')),
    'utf8',
  );
  const replacement = new Map([
    ['review_clear', 'alpha'],
    ['review_set', 'beta'],
    ['review_current', 'gamma'],
    ['approval', 'a_human'],
    ['merged', 'a_delivery'],
  ]);
  const renamed = profile.replace(/\b(?:review_clear|review_set|review_current|approval|merged)\b/g, (id) =>
    replacement.get(id)!,
  );
  const input = makeWorkflowInput(renamed);
  input.binding.source_state = 'reviewing';
  const checkIds = (edgeId: string) =>
    evaluateWorkflowRoutes(input, [])
      .find(({ edge }) => edge.id === edgeId)
      ?.checks.map(({ guard }) => guard.id);
  expect(checkIds('human_handoff')).toEqual(['alpha', 'beta', 'gamma']);
  input.binding.source_state = 'ready_for_human';
  expect(checkIds('complete')).toEqual(['gamma', 'alpha', 'beta', 'a_human', 'a_delivery']);
  expect(checkIds('human_handoff')).toBeUndefined();
});

it('separates release verification, authorized approval and observation of the policy destination', () => {
  const input = makeWorkflowInput();
  input.policy.rules.publication_destination = 'release/stable';
  const guards = [
    {
      id: 'verified',
      capability: 'artifact',
      parameters: { stage: 'release_verified', result: 'passed' },
      required_actions: [],
    },
    { id: 'approved', capability: 'human_approval', parameters: { scope: 'current_subject' }, required_actions: [] },
    { id: 'published', capability: 'completion_observed', parameters: { kind: 'publication' }, required_actions: [] },
  ] satisfies WorkflowGuard[];
  const evidence = () => guards.map((guard) => workflowGuardEvidence(input, currentWorkflowReceipts(input), guard));
  addWorkflowReceipt(input, 'prepared', { type: 'artifact', stage: 'release_prepared', result: 'passed' });
  addWorkflowReceipt(input, 'verified', { type: 'artifact', stage: 'release_verified', result: 'passed' });
  addWorkflowReceipt(input, 'stranger', {
    type: 'human_approval',
    scope: 'current_subject',
    approver: { type: 'human', id: 'guest' },
    reason: 'review',
  });
  addWorkflowReceipt(input, 'recovery', {
    type: 'human_approval',
    scope: 'recovery',
    approver: { type: 'human', id: 'reviewer' },
    reason: 'resume',
  });
  addWorkflowReceipt(input, 'elsewhere', {
    type: 'completion_observed',
    kind: 'publication',
    destination: 'release/beta',
  });
  expect(evidence()).toEqual([['verified'], null, null]);
  addWorkflowReceipt(input, 'approval', {
    type: 'human_approval',
    scope: 'current_subject',
    approver: { type: 'human', id: 'reviewer' },
    reason: 'review',
  });
  addWorkflowReceipt(input, 'release', {
    type: 'completion_observed',
    kind: 'publication',
    destination: 'release/stable',
  });
  expect(evidence()).toEqual([['verified'], ['approval'], ['release']]);
});

it('bootstraps proof binding only on the configured edge from the observed clean baseline', () => {
  const input = makeWorkflowInput();
  if (input.history.status !== 'verified' || !input.observation.repository)
    throw new Error('Expected repository history');
  input.history.proof_plan_bound = false;
  const graph = input.compiled_graph.graph;
  const plan = graph.guards.find((guard) => guard.id === 'plan')!;
  const binding = graph.transitions.find((edge) => edge.id === 'bind_plan')!;
  const later = graph.transitions.find((edge) => edge.id === 'enter_review')!;
  expect(workflowGuardEvidence(input, [], plan)).toBeNull();
  expect(workflowGuardEvidence(input, [], plan, binding)).toEqual([]);
  expect(workflowGuardEvidence(input, [], plan, later)).toBeNull();
  input.observation.repository.branch = 'main';
  expect(workflowGuardEvidence(input, [], plan, binding)).toBeNull();
});

it('accepts completion of an admitted repair at the entry limit on its own later clean commit', () => {
  const input = makeWorkflowInput();
  const graph = input.compiled_graph.graph;
  const history = input.history;
  const basis = history.status === 'verified' && history.implementation_basis;
  if (history.status !== 'verified' || !basis || basis.kind !== 'repository' || !input.observation.repository) {
    throw new Error('Expected repository history');
  }
  const repair = graph.guards.find((guard) => guard.id === 'repair_committed')!;
  const available = graph.guards.find((guard) => guard.id === 'repair_available')!;
  input.binding.source_state = 'repairing';
  input.binding.state_version = 4;
  history.budget_counts[0]!.used = 3;
  history.repair_admission = {
    action_id: 'repair',
    transition_id: 'repair_review',
    entry_state_version: 4,
    bound_state_version: 4,
    budget_id: 'repair_entries',
    consumed: 3,
  };
  input.observation.repository.relationship = 'descendant';
  expect(workflowGuardEvidence(input, [], repair)).toBeNull();
  input.observation.subject = input.binding.subject = { ...basis, revision: 'repaired' };
  expect(workflowGuardEvidence(input, [], repair)).toEqual([]);
  expect(workflowGuardEvidence(input, [], available)).toBeNull();
  history.repair_admission.bound_state_version = 3;
  expect(workflowGuardEvidence(input, [], repair)).toBeNull();
  history.budget_counts[0]!.used = 2;
  expect(workflowGuardEvidence(input, [], available)).toEqual([]);
});

it('includes only the applicable recorded recovery route with its scoped human witness', () => {
  const input = makeWorkflowInput();
  if (input.history.status !== 'verified') throw new Error('Expected verified history');
  input.binding.source_state = 'blocked';
  input.history.prior_state = 'verifying';
  addWorkflowReceipt(input, 'resume', {
    type: 'human_approval',
    scope: 'recovery',
    approver: { type: 'human', id: 'reviewer' },
    reason: 'repaired',
  });
  const routes = evaluateWorkflowRoutes(input, currentWorkflowReceipts(input));
  const eligible = routes.filter(({ checks }) => checks.every(({ evidenceIds }) => evidenceIds !== null));
  expect(eligible.map(({ edge }) => edge.id)).toEqual(['resume_verifying']);
  expect(eligible[0]!.checks.map(({ evidenceIds }) => evidenceIds)).toEqual([[], ['resume']]);
});

it('matches stop, block and phase guards against their own facts', () => {
  const input = makeWorkflowInput();
  input.binding.source_state = 'verifying';
  const guards = [
    { capability: 'stop_requested', parameters: {}, id: 'stop', required_actions: [] },
    { capability: 'block_evidence', parameters: {}, id: 'block', required_actions: [] },
    { capability: 'phase', parameters: { value: 'pre_pr' }, id: 'pre', required_actions: [] },
    { capability: 'phase', parameters: { value: 'post_pr' }, id: 'post', required_actions: [] },
  ] satisfies WorkflowGuard[];
  const evidence = () => guards.map((guard) => workflowGuardEvidence(input, currentWorkflowReceipts(input), guard));
  addWorkflowReceipt(input, 'requested', { type: 'stop_requested', reason: 'paused' });
  addWorkflowReceipt(input, 'earlier', {
    type: 'block_evidence',
    prior_state: 'implementing',
    reason: 'paused',
    recovery: 'resume',
    stop_code: 'hold',
  });
  expect(evidence()).toEqual([['requested'], null, [], null]);
  addWorkflowReceipt(input, 'blocked', {
    type: 'block_evidence',
    prior_state: 'verifying',
    reason: 'paused',
    recovery: 'resume',
    stop_code: 'hold',
  });
  expect(evidence()).toEqual([['requested'], ['blocked'], [], null]);
});

it('requires a clean pre-PR review without blocking findings and follows review supersession', () => {
  const input = makeWorkflowInput();
  const graph = input.compiled_graph.graph;
  const clean = graph.guards.find((guard) => guard.id === 'review_clean')!;
  const changes = graph.guards.find((guard) => guard.id === 'review_changes')!;
  const evidence = () =>
    [clean, changes].map((guard) => workflowGuardEvidence(input, currentWorkflowReceipts(input), guard));
  addWorkflowReceipt(input, 'needs_changes', {
    type: 'pre_pr_review',
    outcome: 'changes_required',
    findings: [{ id: 'fix', blocking: true }],
  });
  expect(evidence()).toEqual([null, ['needs_changes']]);
  addWorkflowReceipt(input, 'contradiction', {
    type: 'pre_pr_review',
    outcome: 'clean',
    findings: [{ id: 'fix', blocking: true }],
  });
  expect(evidence()).toEqual([null, null]);
  addWorkflowReceipt(input, 'clean_review', { type: 'pre_pr_review', outcome: 'clean', findings: [] });
  expect(evidence()).toEqual([['clean_review'], null]);
  if (input.history.status !== 'verified') throw new Error('Expected verified history');
  input.history.proof_plan_bound = false;
  expect(evidence()).toEqual([null, null]);
});

it('retains an earlier producer version and rejects supersession from a different subject, policy or claim version', () => {
  const input = makeWorkflowInput();
  const payload = { type: 'review', outcome: 'clean', findings: [] } as const;
  const addReview = (id: string) => addWorkflowReceipt(input, id, { ...payload, findings: [] });
  const accepted = addReview('accepted');
  input.binding.state_version++;
  const differentHead = addReview('other_head');
  differentHead.subject = { ...input.binding.subject, content_digest: 'a'.repeat(64) };
  const differentPolicy = addReview('other_policy');
  differentPolicy.workflow_policy = { id: input.policy.id, digest: 'b'.repeat(64) };
  expect(currentWorkflowReceipts(input).map(({ id }) => id)).toEqual([accepted.id]);
  const replacement = addReview('attempt');
  replacement.origin = {
    kind: 'attempt',
    claim: { id: 'claim', version: 2 },
    attempt_id: 'attempt',
    request: { request_digest: 'c'.repeat(64), idempotency_key: 'd'.repeat(64) },
  };
  input.invalidated_claims.push({ id: 'claim', version: 1 });
  input.receipts.reverse();
  expect(currentWorkflowReceipts(input).map(({ id }) => id)).toEqual([replacement.id]);
  input.invalidated_claims.push({ id: 'claim', version: 2 });
  expect(currentWorkflowReceipts(input)).toEqual([]);
});

it('keeps only one authoritative result per configured gate in a large unordered history', () => {
  const input = makeWorkflowInput();
  input.policy.rules.local_gate_ids = ['unit', 'format'];
  const latest = addWorkflowReceipt(input, 'unit_latest', {
    type: 'local_proof',
    gate_id: 'unit',
    result: 'passed',
    clean: true,
  });
  const format = addWorkflowReceipt(input, 'format_latest', {
    type: 'local_proof',
    gate_id: 'format',
    result: 'passed',
    clean: true,
  });
  latest.sequence = 4001;
  format.sequence = 4002;
  for (let i = 1; i <= 4000; i++) {
    const previous = i % 2 === 0 ? latest : format;
    input.receipts.push({ ...previous, id: 'prior_' + i, sequence: i });
  }
  const receipts = currentWorkflowReceipts(input);
  expect(receipts).toHaveLength(2);
  const guard = input.compiled_graph.graph.guards.find((entry) => entry.id === 'local_pass')!;
  expect(workflowGuardEvidence(input, receipts, guard)).toEqual(['format_latest', 'unit_latest']);
});

it('orders authorized human approval before publication on an artifact terminal edge with renamed guards', () => {
  const profile = readFileSync(
    new URL(import.meta.resolve('threadloop-contracts/assets/workflow-graph-v0.1/fixtures/valid/minimal-release.yaml')),
    'utf8',
  )
    .replaceAll('id: approval', 'id: z_human')
    .replaceAll('- approval', '- z_human')
    .replaceAll('published', 'a_observed');
  const input = makeWorkflowInput(profile);
  input.binding.subject = { kind: 'artifact', artifact_id: 'archive', content_digest: '1'.repeat(64) };
  input.observation.subject = input.binding.subject;
  input.observation.repository = null;
  input.policy.rules.publication_destination = 'releases';
  addWorkflowReceipt(input, 'operator', {
    type: 'human_approval',
    scope: 'current_subject',
    approver: { type: 'human', id: 'reviewer' },
    reason: 'approved',
  });
  addWorkflowReceipt(input, 'deployed', { type: 'completion_observed', kind: 'publication', destination: 'releases' });
  const [finish] = evaluateWorkflowRoutes(input, currentWorkflowReceipts(input));
  expect(finish!.edge.guard_refs).toEqual(['a_observed', 'z_human']);
  expect(finish!.checks.map(({ guard, evidenceIds }) => [guard.id, evidenceIds])).toEqual([
    ['z_human', ['operator']],
    ['a_observed', ['deployed']],
  ]);
});
