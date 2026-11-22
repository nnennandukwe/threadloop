import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createWorkflowStore } from '../../src/adapters/fs/workflow-store.js';
import type { Preparation } from '../../src/domain/workflow-run.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { runGateProcess } from '../../src/adapters/process/gate-runner.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import type { HostSource } from '../../src/domain/workflow-run.js';
import { observeWorkflow } from '../../src/services/workflow-evaluation.js';
import {
  importWorkflowEvidence,
  decideWorkflowRun,
  applyWorkflowRun,
  admitWorkflowHostSource,
} from '../../src/services/workflow-runtime.js';
import {
  boundGateArtifact,
  boundReviewArtifact,
  fixtureRepository,
  signedGatePackage,
  signedReviewPackage,
  trustPolicy,
  verifiedSigner,
  writeSignedPackage,
} from '../fixtures/receipts.js';
import { parseJson, runCli, runCliError } from '../helpers/cli.js';
import {
  cleanupTemporaryState,
  commitFiles,
  git,
  makeCommittedRepo,
  makeRepo,
  makeTempDir,
  proofPlan,
} from '../helpers/session.js';

afterEach(cleanupTemporaryState);
const run = 'session_wf_shipping';
const github = { base_ref: 'main', human_node_id: 'user-1', preparation_ttl_ms: 120_000, evidence_ttl_ms: 300_000 };

async function createFixture(governed: boolean) {
  const control = await makeRepo(),
    subject = await makeCommittedRepo();
  const base = await git(subject, 'rev-parse', 'HEAD');
  const plan = { ...proofPlan(), review: trustPolicy('review', 'threadloop.yml', 'main') };
  const yaml = governed
    ? await readFile(
        new URL(import.meta.resolve('threadloop-contracts/assets/workflow-graph-v0.1/fixtures/valid/governed-pr.yaml')),
        'utf8',
      )
    : (await readFile(new URL('../fixtures/workflow/quote.yaml', import.meta.url), 'utf8')).replace(
        'kind: publication',
        'kind: merge',
      );
  await writeFile(path.join(control, 'profile.yaml'), yaml);
  await writeFile(
    path.join(control, 'sources.json'),
    JSON.stringify({
      schema_version: 'threadloop.workflow-sources/1',
      host_producers: ['local-gate', 'pre-pr-review'],
      github,
    }),
  );
  await writeFile(path.join(control, 'plan.json'), JSON.stringify(plan));
  await writeFile(
    path.join(control, 'setup.json'),
    JSON.stringify({
      schema_version: 'threadloop.workflow-setup/1',
      subject_workspace: subject,
      repository_id: fixtureRepository,
      policy: {
        id: 'fixture-policy',
        proof_binding_transition_id: governed ? 'bind_plan' : null,
        local_gate_ids: ['check'],
        independent_gate_ids: ['check'],
        publication_destination: null,
      },
      proof_plan: 'plan.json',
      trusted_sources: 'sources.json',
      allowed_change_paths: ['README.md'],
    }),
  );
  await runCli(control, ['init']);
  await runCli(control, ['workflow', 'create', run, '--profile', 'profile.yaml', '--setup', 'setup.json', '--json']);
  const advance = async (key: string) => {
    const file = path.join(control, key + '.json');
    const response = await runCli(control, ['workflow', 'decide', run, '--json']);
    await writeFile(file, response.stdout);
    const committed = await runCli(control, [
      'workflow',
      'apply',
      run,
      '--decision',
      file,
      '--idempotency-key',
      key,
      '--json',
    ]);
    return parseJson<{ data: { to: string; state_version: number } }>(committed.stdout).data;
  };
  const prepare = async (kind: string, version: number, key: string, ...flags: string[]) => {
    const response = await runCli(control, [
      'workflow',
      'evidence',
      'prepare',
      kind,
      '--run',
      run,
      ...flags,
      '--expected-state-version',
      String(version),
      '--idempotency-key',
      key,
      '--json',
    ]);
    return parseJson<{ data: Preparation }>(response.stdout).data;
  };
  return { control, subject, base, plan, advance, prepare };
}

it('retains the original signed gate producer version across apply, restart and byte-identical retry', async () => {
  const { control, subject, base, plan, advance, prepare } = await createFixture(true);
  expect((await advance('frame')).to).toBe('framed');
  expect((await advance('bind')).to).toBe('proof_ready');
  expect((await advance('begin')).to).toBe('implementing');
  const head = await commitFiles(subject, 'Implement quote', { 'README.md': 'Shipping quote verified\n' });
  expect(head).not.toBe(base);
  const prep = await prepare('signed-gate', 3, 'gate', '--gate', 'check');
  expect(prep.binding.subject).toMatchObject({ revision: head });
  expect((await advance('verify')).to).toBe('verifying');
  const stamp = new Date().toISOString();
  const artifact = boundGateArtifact(
    { sessionId: run, planSha256: prep.sensor_inputs.plan_sha256, head, gate: plan.gates[0]! },
    {
      receipt_id: prep.prepared_id,
      started_at: stamp,
      ended_at: stamp,
      duration_ms: 0,
    },
  );
  const source = await writeSignedPackage(control, signedGatePackage(artifact));
  const options = { run, source, expectedStateVersion: 4 };
  const admitted = await importWorkflowEvidence(control, 'signed-gate', options, verifiedSigner('gate', artifact));
  expect(admitted).toMatchObject({ state: 'verifying', state_version: 4, evidence_revision: 1 });
  expect(createWorkflowStore(control).read(run).observations[0]?.receipts[0]?.source_state_version).toBe(3);
  const replay = await runCli(control, [
    'workflow',
    'evidence',
    'import',
    'signed-gate',
    '--run',
    run,
    '--source',
    source,
    '--expected-state-version',
    '3',
    '--json',
  ]);
  expect(parseJson<{ data: unknown }>(replay.stdout).data).toEqual(admitted);
  await writeFile(source, (await readFile(source, 'utf8')) + '\n');
  const conflict = await runCliError(control, [
    'workflow',
    'evidence',
    'import',
    'signed-gate',
    '--run',
    run,
    '--source',
    source,
    '--expected-state-version',
    '4',
    '--json',
  ]);
  expect(conflict.error.code).toBe('IDEMPOTENCY_CONFLICT');
});

type Fixture = Awaited<ReturnType<typeof createFixture>>;
async function observeReview(
  fixture: Fixture,
  prepared: Preparation,
  head: string,
  version: number,
  approved: boolean,
  merged: boolean,
) {
  const at = new Date().toISOString();
  const pull = prepared.pull_request!;
  const artifact = boundReviewArtifact(
    { sessionId: run, planSha256: prepared.sensor_inputs.plan_sha256, head },
    {
      receipt_id: prepared.prepared_id,
      observed_at: at,
      source: {
        repository: fixtureRepository,
        ref: 'refs/heads/main',
        head_sha: fixture.base,
        run_invocation_uri: fixtureRepository + '/actions/runs/' + String(Date.now()) + '/attempts/1',
      },
      pull_request: {
        number: pull.number,
        url: pull.url,
        base_ref: 'main',
        head_sha: head,
        merged,
        merged_at: merged ? at : null,
      },
      review: {
        decision: approved ? 'APPROVED' : 'REVIEW_REQUIRED',
        approvals: approved
          ? [
              {
                actor_id: 'user-1',
                actor_login: 'reviewer',
                actor_type: 'User',
                state: 'APPROVED',
                commit_sha: head,
                submitted_at: at,
              },
            ]
          : [],
        threads: [],
      },
    },
  );
  const source = await writeSignedPackage(fixture.control, signedReviewPackage(artifact));
  const policy = trustPolicy('review', 'threadloop.yml', 'main');
  return importWorkflowEvidence(
    fixture.control,
    prepared.target.kind,
    { source, run, expectedStateVersion: version },
    async () => ({
      ...(await verifiedSigner('review', artifact)()),
      certificateIdentity: policy.certificate_identity,
    }),
  );
}

it('requires separate current same-head human assent and merge before applying terminal state with a fixture signer', async () => {
  const fixture = await createFixture(false);
  expect((await fixture.advance('start')).to).toBe('prepared');
  const prepare = (key: string) => fixture.prepare('signed-review', 1, key, '--pr', '42');
  await observeReview(fixture, await prepare('approval'), fixture.base, 1, true, false);
  await expect(fixture.advance('early')).rejects.toThrow();
  const merged = await prepare('merged');
  await observeReview(fixture, merged, fixture.base, 1, false, true);
  await expect(fixture.advance('withdrawn')).rejects.toThrow();
  await observeReview(fixture, await prepare('approved-merge'), fixture.base, 1, true, true);
  expect(await fixture.advance('complete')).toMatchObject({ to: 'completed', state_version: 2 });
});

it('binds explicit suspension and recovery to distinct approved companion commits with a fixture signer', async () => {
  const fixture = await createFixture(true);
  const companion = await makeTempDir('threadloop-companion-');
  await git(fixture.subject, 'worktree', 'add', '-b', 'authorization', companion, fixture.base);
  async function approveInstruction(purpose: Record<string, unknown>, version: number, key: string) {
    const filename = path.join(fixture.control, key + '.json');
    await writeFile(filename, JSON.stringify(purpose));
    const prepared = await fixture.prepare('signed-instruction', version, key, '--instruction', filename, '--pr', '7');
    const head = await commitFiles(companion, 'Review ' + key, {
      '.threadloop-instruction.json': prepared.manifest_json!,
    });
    const admission = await observeReview(fixture, prepared, head, version, true, false);
    return { head, admission };
  }
  const blocked = await approveInstruction(
    {
      purpose: 'block_run',
      transition_id: 'block_queued',
      reason: 'The approved input is missing.',
      stop_code: 'missing_input',
      evidence_ref: 'ticket-7',
      recovery: 'Review the replacement input.',
      request_stop: true,
    },
    0,
    'stop',
  );
  expect(blocked.admission.receipt_ids).toHaveLength(2);
  expect((await fixture.advance('suspend')).to).toBe('blocked');
  await expect(fixture.advance('premature')).rejects.toThrow();
  const recovered = await approveInstruction(
    { purpose: 'recover_run', transition_id: 'resume_queued', reason: 'The replacement input was reviewed.' },
    1,
    'resume',
  );
  expect(recovered.head).not.toBe(blocked.head);
  expect((await fixture.advance('recover')).to).toBe('queued');
  expect((await fixture.advance('fresh')).to).toBe('framed');
});

it('rechecks native local gate output and a host review before committing the governed PR handoff', async () => {
  const fixture = await createFixture(true);
  const { control, subject, plan } = fixture;
  // Use the same service entry points as the CLI to keep this multi-stage fixture bounded on CI.
  const advance = async (key: string) => {
    const proposal = await decideWorkflowRun(control, run);
    const file = path.join(control, key + '.json');
    await writeFile(file, JSON.stringify({ ok: true, command: 'workflow decide', data: proposal }));
    return (await applyWorkflowRun(control, run, file, key)).to;
  };
  expect(await advance('frame')).toBe('framed');
  expect(await advance('bind')).toBe('proof_ready');
  expect(await advance('begin')).toBe('implementing');
  const head = await commitFiles(subject, 'Implement quote', { 'README.md': 'Shipping rule\n' });
  expect(await advance('verify')).toBe('verifying');
  function sourceBinding(kind: 'local-gate' | 'pre-pr-review') {
    const snap = createWorkflowStore(control).read(run);
    const observed = observeWorkflow(snap);
    const policy = snap.genesis.source_policies[kind]!;
    return {
      producer_id: policy,
      producing: {
        binding: {
          workflow_run_id: run,
          graph_schema_version: '0.1' as const,
          graph_digest: snap.view.graph_digest,
          source_state: snap.view.state,
          state_version: snap.view.state_version,
          subject: observed.subject,
        },
        branch: snap.genesis.baseline_branch,
        workflow_policy: snap.view.policy,
        evidence_policy: policy,
      },
    };
  }
  const gate = plan.gates[0]!;
  const binding = sourceBinding('local-gate');
  const log = await makeTempDir('threadloop-gate-outputs-');
  const native = await runGateProcess({
    command: gate.command,
    cwd: subject,
    timeoutMs: gate.timeout_ms,
    stdoutPath: path.join(log, 'stdout.log'),
    stderrPath: path.join(log, 'stderr.log'),
  });
  expect(native.result).toBe('passed');
  expect(sourceBinding('local-gate')).toEqual(binding);
  const outputs = await Promise.all(
    ['stdout.log', 'stderr.log'].map(async (name) => ({
      path: name,
      content: raw(await readFile(path.join(log, name))),
    })),
  );
  const prep = await fixture.prepare('signed-gate', 4, 'independent', '--gate', 'check');
  const core = {
    session_id: run,
    gate_id: 'check',
    plan_sha256: prep.sensor_inputs.plan_sha256,
    result: native.result,
    setup: [],
    command: gate.command,
    working_directory: '.',
    timeout_ms: gate.timeout_ms,
    started_at: native.startedAt,
    ended_at: native.endedAt,
    duration_ms: native.durationMs,
    exit_status: native.exitStatus,
    signal: native.signal,
    head_before: head,
    head_after: head,
    clean_before: true,
    clean_after: true,
    sensor: { name: 'threadloop-local-gate', contract_version: 2 },
  };
  const artifact = raw(
    Buffer.from(
      canonicalJson({
        ...core,
        contract_version: 2,
        receipt_id: 'local_check',
        stdout: { path: 'stdout.log', ...native.stdout },
        stderr: { path: 'stderr.log', ...native.stderr },
        error: native.error,
      }) + '\n',
    ),
  );
  const json = canonicalJson({
    ...core,
    id: 'local_check',
    artifact: { path: 'execution.json', sha256: artifact.sha256 },
  });
  const local: HostSource = {
    kind: 'local-gate',
    ...binding,
    artifact,
    outputs,
    receipt: {
      sequence: 1,
      id: 'local_check',
      sessionId: run,
      gateId: 'check',
      planSha256: core.plan_sha256,
      headBefore: head,
      headAfter: head,
      result: native.result,
      artifactPath: 'execution.json',
      artifactSha256: artifact.sha256,
      receiptJson: json,
      receiptSha256: sha256(json),
      stateVersion: 4,
      createdAt: native.endedAt,
    },
  };
  await expect(admitWorkflowHostSource(control, run, 4, { ...local, outputs: [] })).rejects.toThrow(/output/);
  await admitWorkflowHostSource(control, run, 4, local);
  const at = new Date().toISOString();
  const ci = boundGateArtifact(
    { sessionId: run, planSha256: core.plan_sha256, head, gate },
    { receipt_id: prep.prepared_id, started_at: at, ended_at: at, duration_ms: 0 },
  );
  await importWorkflowEvidence(
    control,
    'signed-gate',
    { run, source: await writeSignedPackage(control, signedGatePackage(ci)), expectedStateVersion: 4 },
    verifiedSigner('gate', ci),
  );
  expect(await advance('pre-review')).toBe('pre_pr_reviewing');
  const stamp = new Date().toISOString();
  const report = raw(
    Buffer.from(
      canonicalJson({
        reviewer_id: 'fixture-reviewer',
        head_sha: head,
        observed_at: stamp,
        outcome: 'clean',
        findings: [],
      }),
    ),
  );
  await admitWorkflowHostSource(control, run, 5, {
    kind: 'pre-pr-review',
    ...sourceBinding('pre-pr-review'),
    reviewer_id: 'fixture-reviewer',
    observed_at: stamp,
    artifact: report,
    findings: [],
    review: {
      headSha: head,
      outcome: 'clean',
      evidenceRef: 'fixture-review',
      evidenceSha256: report.sha256,
      findings: [],
    },
  });
  expect(await advance('review')).toBe('reviewing');
  await observeReview(
    fixture,
    await fixture.prepare('signed-review', 6, 'product', '--pr', '42'),
    head,
    6,
    false,
    false,
  );
  expect(await advance('handoff')).toBe('ready_for_human');
  const handoff = await decideWorkflowRun(control, run);
  expect(handoff.controller_decision.decision.outcome).toBe('human_action_required');
  const handoffFile = path.join(control, 'handoff.json');
  await writeFile(handoffFile, JSON.stringify({ ok: true, command: 'workflow decide', data: handoff }));
  const handed = parseJson<{ data: unknown }>(
    (await runCli(control, ['workflow', 'execute', run, '--decision', handoffFile, '--json'])).stdout,
  );
  expect(handed.data).toMatchObject({
    disposition: 'human_handoff',
    state_version: 7,
    action_request: { request: { actor: 'human' } },
  });
  expect(createWorkflowStore(control).read(run).view).toMatchObject({ state: 'ready_for_human', state_version: 7 });
  await observeReview(
    fixture,
    await fixture.prepare('signed-review', 7, 'finish-review', '--pr', '42'),
    head,
    7,
    true,
    true,
  );
  expect(await advance('finish')).toBe('completed');
});

function raw(bytes: Buffer) {
  return { bytes, sha256: sha256(bytes) };
}

it('keeps a human preparation unused when the approved tree or manifest differs', async () => {
  const fixture = await createFixture(true);
  const companion = await makeTempDir('threadloop-instruction-tree-');
  await git(fixture.subject, 'worktree', 'add', '-b', 'authorization', companion, fixture.base);
  const filename = path.join(fixture.control, 'stop.json');
  await writeFile(filename, JSON.stringify({ purpose: 'request_stop', reason: 'Pause for missing input.' }));
  const prepared = await fixture.prepare('signed-instruction', 0, 'stop', '--instruction', filename, '--pr', '9');
  const instruction = '.threadloop-instruction.json';
  const changed = await commitFiles(companion, 'Different file bytes', {
    [instruction]: prepared.manifest_json + '\n',
  });
  await expect(observeReview(fixture, prepared, changed, 0, true, false)).rejects.toThrow(
    /approved instruction bytes/i,
  );
  const unrelated = await commitFiles(companion, 'Additional product change', {
    [instruction]: prepared.manifest_json!,
    'another.txt': 'additional scope\n',
  });
  await expect(observeReview(fixture, prepared, unrelated, 0, true, false)).rejects.toThrow(/another path/);
  const store = createWorkflowStore(fixture.control);
  expect(store.read(run).view).toMatchObject({ state: 'queued', state_version: 0, evidence_revision: 0 });
  await git(companion, 'rm', 'another.txt');
  await git(companion, 'commit', '-m', 'Restore the approved file scope');
  const intact = await git(companion, 'rev-parse', 'HEAD');
  expect(await observeReview(fixture, prepared, intact, 0, true, false)).toMatchObject({
    state_version: 0,
    evidence_revision: 1,
  });
  expect(store.read(run).observations[0]?.receipts[0]?.payload.type).toBe('stop_requested');
});
