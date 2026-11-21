/** Exercise the installed CLI against a real Workflow Run and independently reopen the admitted child. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { GaapRequest } from 'threadloop-contracts/executor';
import type { GaapHost } from '../src/domain/gaap-binding.js';
import type { DecisionReply, RunView, ApplyReply } from '../src/domain/workflow-run.js';
import type { WorkflowExecutionImport, WorkflowCorrelation } from '../src/domain/workflow-execution.js';
import { GaapState } from '../src/adapters/fs/gaap-state.js';
import { createWorkflowStore } from '../src/adapters/fs/workflow-store.js';
import { observeGaapWorkspace } from '../src/adapters/fs/gaap-files.js';
import { inspectManagedGaapExecutor } from '../src/services/gaap-executor.js';
import { fixtureExecutorMapping } from '../tests/fixtures/gaap-controller.js';

export async function proveWorkflowExecution(
  cli: string,
  output: string,
  host: GaapHost,
  template: GaapRequest,
  scenario: string,
  python: string,
) {
  const run = 'session_wf_native';
  const control = path.join(output, 'control');
  mkdirSync(control, { mode: 0o700 });
  const save = (filename: string, value: unknown) => {
    const name = path.join(output, filename);
    writeFileSync(name, JSON.stringify(value, null, 2) + '\n');
    return name;
  };
  const command = <T>(...args: string[]) => {
    const raw = execFileSync(cli, ['workflow', ...args, '--json'], {
      cwd: control,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120000,
    });
    return JSON.parse(raw) as { ok: true; data: T };
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        cwd,
        '-c',
        'user.name=ThreadLoop Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      { encoding: 'utf8' },
    ).trim();
  git(control, 'init', '-b', 'main');
  execFileSync(cli, ['init'], { cwd: control });
  const profile = createRequire(import.meta.url).resolve(
    'threadloop-contracts/assets/workflow-graph-v0.1/fixtures/valid/governed-pr.yaml',
  );
  const mapping = fixtureExecutorMapping(host.workspace, template);
  const adapter = {
    schema_version: 'threadloop.workflow-gaap-adapter/1',
    ...mapping,
    lease_ms: 120000,
    execution_policy: { id: 'native-goose', retry_safety: 'reconciliation_required', max_attempts: 1 },
  };
  host.environment.GAAP_NATIVE_MAPPING = JSON.stringify(mapping.mapping_policy);
  save('adapter.json', adapter);
  save('host.json', host);
  const allowed = ['mcp.txt', 'shipping.py', 'terminal.txt'];
  save('plan.json', {
    acceptance_criteria: ['Five units at 20 ship for 97.'],
    gates: [
      {
        id: 'check',
        command: [python, '-B', '-c', 'from shipping import shipping_quote; assert shipping_quote(5, 20) == 97'],
        working_directory: '.',
        timeout_ms: 5000,
      },
    ],
  });
  save('sources.json', {
    schema_version: 'threadloop.workflow-sources/1',
    host_producers: ['local-gate'],
    github: null,
  });
  const setup = save('setup.json', {
    schema_version: 'threadloop.workflow-setup/2',
    subject_workspace: host.workspace,
    repository_id: 'owned-native-repository',
    policy: {
      id: 'native-governed-pr',
      proof_binding_transition_id: 'bind_plan',
      local_gate_ids: ['check'],
      independent_gate_ids: ['check'],
      publication_destination: null,
    },
    proof_plan: 'plan.json',
    trusted_sources: 'sources.json',
    allowed_change_paths: allowed,
    gaap: { adapter: 'adapter.json', host: 'host.json' },
  });
  const created = command<RunView>('create', run, '--profile', profile, '--setup', setup);
  assert.equal(created.data.state_version, 0);
  const apply = (decisionFile: string, key: string) =>
    command<ApplyReply>('apply', run, '--decision', decisionFile, '--idempotency-key', key);
  const decide = (filename: string) => {
    const decided = command<DecisionReply>('decide', run);
    return {
      proposal: decided.data,
      file: save(filename, decided),
      decision: decided.data.controller_decision.decision,
    };
  };
  const transitions = [];
  for (const edge of ['frame', 'bind_plan', 'begin_implementation']) {
    const selected = decide(edge + '-decision.json');
    assert.equal(selected.decision.outcome, 'transition_available');
    const result = apply(selected.file, edge);
    assert.equal(result.data.transition_id, edge);
    transitions.push(result.data);
  }
  const selected = decide('selected-decision.json');
  assert.equal(selected.proposal.expectation.state, 'implementing');
  assert.equal(selected.proposal.expectation.state_version, 3);
  assert.equal(selected.decision.outcome, 'engineering_action_required');
  const action = selected.decision.action_request;
  assert.equal(action.request.capability, 'implement_change');
  const before = observeGaapWorkspace(host.workspace);
  assert.equal(action.request.binding.subject.content_digest, before.digest);
  type Execution = WorkflowExecutionImport & { disposition: string; correlation: WorkflowCorrelation };
  const executed = command<Execution>('execute', run, '--decision', selected.file);
  save('result.json', executed);
  assert.equal(executed.data.disposition, 'imported');
  assert.equal(executed.data.state_version, 3);
  assert.equal(executed.data.request_digest, action.request_digest);
  const source = save('correlation.json', executed.data.correlation);
  const replay = command<Execution>(
    'evidence',
    'import',
    'gaap',
    '--run',
    run,
    '--source',
    source,
    '--expected-state-version',
    '3',
  );
  assert.deepEqual(replay.data, executed.data);
  const inspected = command<RunView>('inspect', run);
  assert.equal(inspected.data.state_version, 3);
  const store = createWorkflowStore(control);
  const reservation = store
    .read(run)
    .managed_execution?.reservations.find((item) => item.owner.request_digest === action.request_digest);
  assert.ok(reservation);
  const child = await inspectManagedGaapExecutor(new GaapState(reservation.child_directory), reservation.owner);
  assert.deepEqual(child.request.request.action_request, action);
  assert.equal(child.launch_count, 1);
  assert.equal(child.admitted.length, 1);
  const receipt = child.admitted[0]!;
  const publicReport = JSON.parse(
    execFileSync(cli, ['executor', 'inspect', '--state', reservation.child_directory, '--json'], {
      cwd: control,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    }),
  ) as {
    data: {
      owner: typeof reservation.owner;
      request_digest: string;
      revision: number;
      launch_count: number;
      admitted: { source_id: string; admission_digest: string }[];
    };
  };
  assert.deepEqual(publicReport.data.owner, reservation.owner);
  assert.equal(publicReport.data.request_digest, child.request.request_digest);
  assert.equal(publicReport.data.revision, child.revision);
  assert.equal(publicReport.data.launch_count, 1);
  assert.equal(publicReport.data.admitted[0]?.admission_digest, receipt.admission.admission_digest);
  assert.equal(publicReport.data.admitted[0]?.source_id, receipt.source_id);
  save('public-inspection.json', publicReport);
  assert.equal(receipt.admission.admission_digest, executed.data.admission_digest);
  assert.equal(receipt.source_id, executed.data.source_id);
  assert.equal(receipt.source_digest, executed.data.source_digest);
  const effect = observeGaapWorkspace(host.workspace);
  assert.equal(receipt.result.result.attempt_receipt.receipt.resulting_subject?.content_digest, effect.digest);
  assert.notEqual(effect.digest, before.digest);
  assert.equal(effect.revision, before.revision);
  save('executor-request.json', child.request);
  save('inspection.json', child);
  const after = decide('after-admission-decision.json');
  assert.notEqual(after.decision.outcome, 'transition_available');
  const refused = spawnSync(
    cli,
    ['workflow', 'apply', run, '--decision', after.file, '--idempotency-key', 'premature', '--json'],
    { cwd: control, encoding: 'utf8' },
  );
  assert.equal(refused.status, 1);
  const refusal = JSON.parse(refused.stderr) as { error: { code: string; details: { reason: string } } };
  assert.equal(refusal.error.code, 'TRANSITION_GUARD_FAILED');
  assert.equal(refusal.error.details.reason, 'transition_unavailable');
  save('refused-apply.json', refusal);
  if (scenario === 'bad_patch') {
    assert.equal(child.projection.attempts[0]?.status, 'unknown_outcome');
    assert.equal(after.decision.outcome, 'blocked');
    assert.ok(after.decision.reasons.some((reason) => reason.code === 'EXECUTION_RECONCILIATION_REQUIRED'));
  } else {
    assert.equal(child.projection.request_status, 'satisfied');
    assert.equal(child.projection.attempts[0]?.status, 'succeeded');
    git(host.workspace, 'add', '--', ...allowed);
    assert.deepEqual(git(host.workspace, 'diff', '--cached', '--name-only').split('\n').sort(), allowed);
    git(host.workspace, 'commit', '-m', 'Apply verified native shipping changes');
    const next = decide('committed-decision.json');
    assert.equal(next.decision.outcome, 'transition_available');
    assert.equal(next.decision.transition_id, 'verify_implementation');
    const advanced = apply(next.file, 'native-committed');
    assert.equal(advanced.data.state_version, 4);
    assert.deepEqual(apply(next.file, 'native-committed').data, advanced.data);
    transitions.push(advanced.data);
    const proof = command(
      'evidence',
      'collect',
      'local-gate',
      '--run',
      run,
      '--gate',
      'check',
      '--expected-state-version',
      '4',
      '--idempotency-key',
      'native-local-gate',
    );
    const currentSubject = observeGaapWorkspace(host.workspace);
    const receipt = store
      .read(run)
      .observations.flatMap((item) => item.receipts)
      .find((item) => item.payload.type === 'local_proof');
    assert.ok(receipt);
    assert.deepEqual(receipt.payload, { type: 'local_proof', gate_id: 'check', result: 'passed', clean: true });
    assert.equal(receipt.subject?.kind, 'repository');
    assert.equal(receipt.subject?.content_digest, currentSubject.digest);
    assert.equal(receipt.subject?.kind === 'repository' && receipt.subject.revision, currentSubject.revision);
    assert.equal(receipt.source_state_version, 4);
    save('local-gate.json', { outcome: proof, receipt });
    decide('after-local-gate-decision.json');
  }
  const final = command<RunView>('inspect', run);
  assert.equal(final.data.state, scenario === 'allow' ? 'verifying' : 'implementing');
  assert.equal(final.data.state_version, scenario === 'allow' ? 4 : 3);
  const verified = await inspectManagedGaapExecutor(new GaapState(reservation.child_directory), reservation.owner);
  assert.deepEqual(verified, child);
  const summary = {
    case: scenario,
    run,
    graph_digest: created.data.graph_digest,
    controller_request_digest: action.request_digest,
    executor_request_digest: child.request.request_digest,
    claim: child.request.request.claim,
    attempt_id: child.request.request.attempt_id,
    attempt_status: child.projection.attempts[0]?.status,
    source_id: receipt.source_id,
    source_digest: receipt.source_digest,
    admission_digest: receipt.admission.admission_digest,
    launch_count: child.launch_count,
    after_admission: inspected.data,
    transitions,
    final: final.data,
    subjects: {
      before: before.digest,
      after: effect.digest,
      original_commit: before.revision,
      final_commit: git(host.workspace, 'rev-parse', 'HEAD'),
    },
  };
  save('workflow-proof.json', summary);
  return summary;
}
