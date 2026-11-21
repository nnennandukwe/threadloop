import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import {
  applyWorkflow,
  applyObservedWorkflow,
  decideWorkflow,
  initialWorkflowHistory,
  observeWorkflow,
} from '../../src/services/workflow-evaluation.js';
import { prepareWorkflowGenesis } from '../../src/services/workflow-genesis.js';
import type { AdmittedObservation, Receipt, RunSnapshot, WorkflowGenesis } from '../../src/domain/workflow-run.js';
import { governedProfile, governedWorkflowFixture } from '../helpers/workflow-run.js';
import { workflowDigest } from '../../src/domain/workflow-selection-types.js';
import { cleanupTemporaryState, makeTempDir, makeCommittedRepo, git } from '../helpers/session.js';

const start = '2026-11-21T00:00:00.000Z';
async function quoteSnapshot(): Promise<RunSnapshot> {
  const folder = await makeTempDir();
  const subject = await makeCommittedRepo({ branch: 'quote', remote: null });
  const setup = {
    schema_version: 'threadloop.workflow-setup/1',
    subject_workspace: subject,
    repository_id: 'quote-project',
    policy: {
      id: 'local',
      proof_binding_transition_id: null,
      local_gate_ids: [],
      independent_gate_ids: [],
      publication_destination: null,
    },
    proof_plan: null,
    trusted_sources: null,
    allowed_change_paths: [],
  };
  await writeFile(path.join(folder, 'setup.json'), JSON.stringify(setup));
  const profile = fileURLToPath(new URL('../fixtures/workflow/quote.yaml', import.meta.url));
  const genesis = prepareWorkflowGenesis(folder, 'quote', profile, 'setup.json').build(start);
  return initialSnapshot(genesis);
}
function initialSnapshot(genesis: WorkflowGenesis): RunSnapshot {
  const digest = '3'.repeat(64);
  const view = {
    contract_version: 1 as const,
    workflow_run_id: genesis.run_id,
    graph_schema_version: '0.1' as const,
    graph_digest: genesis.compiled.graph_digest,
    policy: { id: genesis.policy.id, digest: genesis.policy.digest },
    state: genesis.compiled.graph.initial_state,
    state_version: 0,
    history_digest: digest,
    evidence_revision: 0,
  };
  return {
    genesis,
    view,
    history: { ...initialWorkflowHistory(genesis), digest },
    last_subject: genesis.baseline,
    implementation_manifest: null,
    product_pr: null,
    observations: [],
  };
}
async function governedSnapshot() {
  const { control } = await governedWorkflowFixture();
  return initialSnapshot(
    prepareWorkflowGenesis(control, 'session_wf_governed', governedProfile, 'setup.json').build(start),
  );
}
function instructionBatch(
  snapshot: RunSnapshot,
  payload: Receipt['payload'],
  until: string | null,
): AdmittedObservation {
  const policy = snapshot.genesis.source_policies['signed-instruction']!;
  const binding = {
    workflow_run_id: snapshot.view.workflow_run_id,
    graph_schema_version: '0.1' as const,
    graph_digest: snapshot.view.graph_digest,
    source_state: snapshot.view.state,
    state_version: snapshot.view.state_version,
    subject: snapshot.genesis.baseline,
  };
  const version = snapshot.view.state_version;
  const source = 'instruction_' + version;
  return {
    binding,
    branch: snapshot.genesis.baseline_branch,
    workflow_policy: snapshot.view.policy,
    evidence_policy: policy,
    source_id: source,
    stream: {
      kind: 'signed-instruction',
      pr: 5,
      version,
      purpose: payload.type === 'human_approval' ? 'recover_run' : 'block_run',
    },
    measured_at: start,
    valid_until: until,
    applicable_version: version,
    authorized_edge: null,
    receipts: [
      {
        id: source,
        workflow_run_id: binding.workflow_run_id,
        graph_digest: binding.graph_digest,
        source_state_version: version,
        subject: binding.subject,
        sequence: version + 1,
        policy,
        workflow_policy: snapshot.view.policy,
        acceptance: { id: source, digest: workflowDigest(source) },
        valid_until: until,
        origin: { kind: 'observation' },
        payload,
        payload_digest: workflowDigest(payload),
      },
    ],
  };
}
describe('workflow evaluation', () => {
  afterEach(cleanupTemporaryState);
  it('reconstructs a proposed graph transition at its observed instant and checks that edge at apply time', async () => {
    const snapshot = await quoteSnapshot();
    const decision = decideWorkflow(snapshot, observeWorkflow(snapshot), start);
    expect(decision.controller_decision.decision).toMatchObject({
      outcome: 'transition_available',
      transition_id: 'start_quote',
    });
    const applied = applyWorkflow(snapshot, decision, '2026-11-21T00:00:01.000Z');
    expect(applied.selected.target_state).toBe('prepared');
    expect(applyObservedWorkflow(snapshot, decision, applied.observed, '2026-11-21T00:00:01.000Z')).toEqual(applied);
    const corrupt = structuredClone(applied.observed);
    corrupt.physical!.manifest = {};
    expect(() => applyObservedWorkflow(snapshot, decision, corrupt, '2026-11-21T00:00:01.000Z')).toThrow(
      /physical subject/,
    );

    expect(applied.fresh_decision_digest).not.toBe(decision.expectation.decision_digest);
    await writeFile(path.join(snapshot.genesis.subject_root, 'README.md'), 'changed physical contents');
    expect(() => applyWorkflow(snapshot, decision, '2026-11-21T00:00:02.000Z')).toThrow(/decision|subject/i);
  });
  it('withdraws a block instruction when a later snapshot of its approval has no matching evidence', async () => {
    const snapshot = await governedSnapshot();
    const until = '2026-11-21T00:01:00.000Z';
    const before = instructionBatch(
      snapshot,
      {
        type: 'block_evidence',
        reason: 'Operator requested a stop',
        recovery: 'Inspect the run',
        stop_code: 'paused',
        prior_state: 'queued',
      },
      until,
    );
    const later = '2026-11-21T00:00:05.000Z';
    const withdrawn = { ...before, source_id: 'withdrawn', measured_at: later, receipts: [] };
    snapshot.observations = [before];
    const observe = () => observeWorkflow(snapshot);
    const first = decideWorkflow(snapshot, observe(), start);
    expect(first.controller_decision.decision).toMatchObject({
      outcome: 'transition_available',
      transition_id: 'block_queued',
    });
    expect(() => applyWorkflow(snapshot, first, until)).toThrow(/evidence|transition/i);
    snapshot.observations = [withdrawn, before];
    expect(decideWorkflow(snapshot, observe(), later).controller_decision.decision).toMatchObject({
      outcome: 'transition_available',
      transition_id: 'frame',
    });
  });
  it('retains the final repair admission through suspension and recovery and clears it on verified progress', async () => {
    const snapshot = await governedSnapshot();
    snapshot.view = { ...snapshot.view, state: 'verifying', state_version: 6 };
    snapshot.history = {
      ...snapshot.history,
      phase: 'post_pr',
      proof_plan_bound: true,
      budget_counts: [{ budget_id: 'repair_entries', used: 2 }],
    };
    const gate = instructionBatch(
      snapshot,
      { type: 'local_proof', gate_id: 'check', result: 'failed', clean: true },
      null,
    );
    const localPolicy = snapshot.genesis.source_policies['local-gate']!;
    gate.applicable_version = null;
    gate.evidence_policy = localPolicy;
    gate.stream = { kind: 'local-gate', gate_id: 'check' };
    gate.receipts[0]!.policy = localPolicy;
    snapshot.observations = [gate];
    function advance(transition: string) {
      const decision = decideWorkflow(snapshot, observeWorkflow(snapshot), start);
      expect(decision.controller_decision.decision).toMatchObject({
        outcome: 'transition_available',
        transition_id: transition,
      });
      const applied = applyWorkflow(snapshot, decision, start);
      const version = snapshot.view.state_version + 1;
      const digest = workflowDigest([transition, version]);
      snapshot.view = {
        ...snapshot.view,
        state: applied.selected.target_state,
        state_version: version,
        history_digest: digest,
      };
      snapshot.history = { ...applied.next_history, digest };
      snapshot.last_subject = applied.observed.subject;
      snapshot.implementation_manifest = applied.implementation_manifest;
    }
    advance('repair_failed_proof');
    const counted = {
      transition_id: 'repair_failed_proof',
      entry_state_version: 7,
      bound_state_version: 7,
      budget_id: 'repair_entries',
      consumed: 3,
    };
    expect(snapshot.history.repair_admission).toMatchObject(counted);
    snapshot.observations = [
      ...snapshot.observations,
      instructionBatch(
        snapshot,
        {
          type: 'block_evidence',
          reason: 'Pause',
          stop_code: 'human_stop',
          recovery: 'Review the change',
          prior_state: 'repairing',
        },
        null,
      ),
    ];
    advance('block_repairing');
    expect(snapshot.history.prior_state).toBe('repairing');
    snapshot.observations = [
      ...snapshot.observations,
      instructionBatch(
        snapshot,
        {
          type: 'human_approval',
          scope: 'recovery',
          reason: 'Resume the recorded repair',
          approver: { type: 'human', id: 'github_user' },
        },
        null,
      ),
    ];
    advance('resume_repairing');
    expect(snapshot.history.repair_admission).toMatchObject({ ...counted, bound_state_version: 9 });
    expect(snapshot.history.budget_counts).toEqual([{ budget_id: 'repair_entries', used: 3 }]);
    expect(snapshot.history.prior_state).toBeNull();
    const before = decideWorkflow(snapshot, observeWorkflow(snapshot), start);
    expect(before.controller_decision.decision.outcome).toBe('blocked');
    await git(snapshot.genesis.subject_root, 'commit', '--allow-empty', '-m', 'Record the reviewed revision');
    advance('verify_repair');
    expect(snapshot.history.repair_admission).toBeNull();
    expect(snapshot.history.budget_counts).toEqual([{ budget_id: 'repair_entries', used: 3 }]);
  });
  it('observes regular tracked filenames with JavaScript object property names', async () => {
    const snapshot = await quoteSnapshot();
    const root = snapshot.genesis.subject_root;
    await writeFile(path.join(root, '__proto__'), 'quoted line item');
    await git(root, 'add', '--', '__proto__');
    await git(root, 'commit', '-m', 'Track the regular quote file');
    const observed = observeWorkflow(snapshot);
    expect(observed.facts.status).toBe('verified');
    expect(Object.hasOwn(observed.physical!.manifest, '__proto__')).toBe(true);
    expect(observed.physical?.clean).toBe(true);
  });
  it('measures path scope from the retained basis including ignored files', async () => {
    const snapshot = await governedSnapshot();
    snapshot.history.implementation_basis = snapshot.genesis.baseline;
    snapshot.implementation_manifest = snapshot.genesis.baseline_manifest;
    await writeFile(path.join(snapshot.genesis.subject_root, 'README.md'), 'allowed');
    const allowed = observeWorkflow(snapshot);
    expect(allowed.facts.repository).toMatchObject({
      clean: false,
      relationship: 'equal',
      change_scope: 'within_plan',
    });
    await writeFile(path.join(snapshot.genesis.subject_root, '.git/info/exclude'), 'private-output.txt\n');
    await writeFile(path.join(snapshot.genesis.subject_root, 'private-output.txt'), 'undeclared');
    expect(observeWorkflow(snapshot).facts.repository).toMatchObject({ clean: false, change_scope: 'outside_plan' });
  });
});
