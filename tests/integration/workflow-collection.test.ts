import { execFile, execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { managedWorkflowFixture } from '../helpers/workflow-execution.js';
import { governedProfile } from '../helpers/workflow-run.js';
import { cleanupTemporaryState, commitFiles, git, type proofPlan } from '../helpers/session.js';
import { parseJson, resolveTestCliBundle, runCli, runCliError } from '../helpers/cli.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await cleanupTemporaryState();
});
const operation = '125fe082-9417-45e2-b6c7-ab7a38e0c40e';
async function collectionFixture(gateCommand?: (control: string) => string[]) {
  const { control, subject, producerRoot, setup } = await managedWorkflowFixture('success', [
    'local-gate',
    'pre-pr-review',
  ]);
  roots.push(producerRoot);
  const file = (name: string, value: unknown) => writeFile(path.join(control, name), JSON.stringify(value));
  if (gateCommand) {
    const plan = JSON.parse(await readFile(path.join(control, 'plan.json'), 'utf8')) as ReturnType<typeof proofPlan>;
    plan.gates[0]!.command = gateCommand(control);
    plan.gates[0]!.timeout_ms = 12_000;
    await file('plan.json', plan);
  }
  const base = await git(subject, 'rev-parse', 'HEAD');
  await commitFiles(subject, 'Prepare an independent review head', { 'README.md': 'review fixture\n' });
  const head = await git(subject, 'rev-parse', 'HEAD');
  const tree = await git(subject, 'rev-parse', 'HEAD^{tree}');
  const snapshot = { base_sha: base, commit_sha: head, tree_sha: tree };
  const status = {
    meta: {
      analysis: { mode: 'full' },
      coverage: { complete: true },
      skipped_files: [],
      run: {
        id: 'fixture-review',
        snapshot,
        timing: { finished_at: new Date().toISOString() },
        passes: [
          { kind: 'primary', agent_statuses_reported: true, agents: [{ name: 'issue-review', status: 'completed' }] },
        ],
      },
    },
    finding_state: { complete: true, introduced: [], still_open: ['retained'], dismissed: [], resolved: [] },
    findings: [
      {
        id: 'retained',
        title: 'A previous implementation defect remains open',
        action_level: 'action_required',
        location: { file_path: 'README.md' },
      },
    ],
  };
  const readerDir = path.join(control, 'reader-bin');
  await mkdir(readerDir, { mode: 0o700 });
  const reader = path.join(readerDir, 'qodo-fixture');
  await writeFile(
    reader,
    '#!' +
      process.execPath +
      '\n' +
      'if(JSON.stringify(process.argv.slice(2))!==' +
      JSON.stringify(JSON.stringify(['review', 'status', operation, '--json'])) +
      ')process.exit(3);\n' +
      "process.stdout.write(require('node:fs').readFileSync(require('node:path').join(__dirname, '../status.json')));\n",
  );
  await chmod(reader, 0o700);
  await file('status.json', status);
  await file('setup.json', {
    ...setup,
    review_reader: { provider: 'qodo', executable: reader, base_commit: base, reviewer_id: 'fixture-status-reader' },
  });
  await git(control, 'init', '-b', 'main');
  await runCli(control, ['init']);
  const run = 'session_wf_producers';
  const call = async (...args: string[]) =>
    parseJson<{ data: Record<string, unknown> }>((await runCli(control, ['workflow', ...args, '--json'])).stdout);
  await call('create', run, '--profile', governedProfile, '--setup', 'setup.json');
  for (const edge of ['frame', 'bind_plan', 'begin_implementation']) {
    await file('decision.json', await call('decide', run));
    await call('apply', run, '--decision', 'decision.json', '--idempotency-key', edge);
  }
  const collect = (kind: string, key: string, selector: string, value: string) => [
    'workflow',
    'evidence',
    'collect',
    kind,
    '--run',
    run,
    selector,
    value,
    '--expected-state-version',
    '3',
    '--idempotency-key',
    key,
    '--json',
  ];
  return { control, subject, run, file, status, call, collect, readerDir, reader };
}

async function countedCollection(waitForRelease = false) {
  const gate = fileURLToPath(new URL('../fixtures/workflow/collection-gate.mjs', import.meta.url));
  const fixture = await collectionFixture((control) => [
    process.execPath,
    gate,
    path.join(control, 'gate-invocations'),
    ...(waitForRelease ? [path.join(control, 'release-gate')] : []),
  ]);
  const { control, run, collect } = fixture;
  const args = collect('local-gate', 'interrupted-gate', '--gate', 'check');
  const inspect = async () =>
    parseJson<{
      data: { state_version: number; collections: { key: string; attempt: string; phase: string }[] };
    }>((await runCli(control, ['workflow', 'inspect', run, '--json'])).stdout).data;
  const count = async () =>
    readFile(path.join(control, 'gate-invocations'), 'utf8').then(
      (bytes) => bytes.trim().split('\n').length,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return 0;
        throw error;
      },
    );
  async function interruptAt(cut: 'intent' | 'captured' | 'after-invocation' | 'report-error') {
    const preload = fileURLToPath(new URL('../fixtures/workflow/collection-cut.mjs', import.meta.url));
    const failure = await promisify(execFile)(
      process.execPath,
      ['--import', preload, resolveTestCliBundle(), ...args],
      {
        cwd: control,
        timeout: 20_000,
        env: { ...process.env, THREADLOOP_TEST_COLLECTION_CUT: cut },
      },
    ).then(
      () => null,
      (e: Error & { signal?: string; code?: number; stderr?: string }) => e,
    );
    if (cut === 'report-error') expect(failure?.code).toBe(1);
    else expect(failure?.signal).toBe('SIGKILL');
    expect(failure?.stderr).toContain('collection-cut=' + cut);
    return failure?.stderr;
  }
  return { ...fixture, args, count, inspect, interruptAt };
}

it('resumes a prelaunch intent once when two CLI processes retry the same gate', async () => {
  const { control, run, args, count, inspect, interruptAt } = await countedCollection(true);
  await interruptAt('intent');
  expect(await count()).toBe(0);
  const reserved = await inspect();
  expect(reserved).toMatchObject({ state_version: 3, collections: [{ key: 'interrupted-gate', phase: 'reserved' }] });
  const collecting = runCli(control, args);
  try {
    await Promise.race([
      expect.poll(count, { timeout: 8000 }).toBe(1),
      collecting.then(() => {
        throw new Error('The gate returned before its release.');
      }),
    ]);
    expect((await inspect()).collections).toMatchObject([
      { attempt: reserved.collections[0]!.attempt, phase: 'launch_claimed' },
    ]);
    const competing = await runCliError(control, args);
    expect(competing.error.details.reason).toBe('collection_outstanding');
  } finally {
    await writeFile(path.join(control, 'release-gate'), '');
    await collecting.catch(() => undefined);
  }
  const completed = (await collecting).stdout;
  expect(parseJson<{ data: unknown }>(completed).data).toMatchObject({ state_version: 3 });
  expect((await runCli(control, args)).stdout).toBe(completed);
  expect(await count()).toBe(1);
  expect(await inspect()).toMatchObject({ state_version: 3, collections: [] });
  const attempt = reserved.collections[0]!.attempt;
  const artifact = path.join(control, '.threadloop', 'artifacts', 'workflow-collections', attempt, 'execution.json');
  expect(parseJson<unknown>(await readFile(artifact, 'utf8'))).toMatchObject({
    receipt_id: 'receipt_' + attempt,
    session_id: run,
    gate_id: 'check',
    result: 'passed',
  });
}, 30_000);

it.each(['captured', 'report-error'] as const)(
  'recovers a captured local result after %s and loss of its output directory',
  async (cut) => {
    const { control, run, args, count, inspect, interruptAt } = await countedCollection();
    const diagnostic = await interruptAt(cut);
    expect(await count()).toBe(1);
    const { collections } = await inspect();
    expect(collections).toMatchObject([{ key: 'interrupted-gate', phase: 'captured' }]);
    const attempt = collections[0]!.attempt;
    if (cut === 'report-error') {
      const reply = parseJson<{ error: unknown }>(diagnostic?.slice(diagnostic.indexOf('{')));
      expect(reply.error).toMatchObject({
        code: 'TRANSITION_GUARD_FAILED',
        details: { reason: 'collection_result_captured', workflow_run_id: run, key: 'interrupted-gate', attempt },
      });
    }
    const directory = path.join(control, '.threadloop', 'artifacts', 'workflow-collections', attempt);
    expect(await readFile(path.join(directory, 'stdout.log'), 'utf8')).toBe('local gate counted\n');
    await expect(stat(path.join(directory, 'execution.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(directory, { recursive: true });
    const admitted = (await runCli(control, args)).stdout;
    expect((await runCli(control, args)).stdout).toBe(admitted);
    expect(await count()).toBe(1);
    expect(await inspect()).toMatchObject({ state_version: 3, collections: [] });
    const { createWorkflowStore } = await import('../../src/adapters/fs/workflow-store.js');
    const receipts = createWorkflowStore(control)
      .read(run)
      .observations.flatMap((item) => item.receipts);
    expect(
      receipts.filter((receipt) => receipt.payload.type === 'local_proof').map((receipt) => receipt.payload),
    ).toEqual([{ type: 'local_proof', gate_id: 'check', result: 'passed', clean: true }]);
  },
  30_000,
);

it('holds a local gate that ran before the host could retain its result', async () => {
  const { control, args, count, inspect, collect, interruptAt } = await countedCollection();
  await interruptAt('after-invocation');
  const outstanding = await inspect();
  expect(outstanding).toMatchObject({
    state_version: 3,
    collections: [{ key: 'interrupted-gate', phase: 'launch_claimed' }],
  });
  for (const retry of [args, collect('local-gate', 'another-gate', '--gate', 'check')]) {
    expect((await runCliError(control, retry)).error.details.reason).toBe('collection_outstanding');
  }
  expect(await inspect()).toEqual(outstanding);
  expect(await count()).toBe(1);
}, 30_000);

it('requires a protected reader installation at enrollment and when collecting a review', async () => {
  const { control, run, collect, call, readerDir, reader } = await collectionFixture();
  const before = await call('inspect', run);
  await chmod(readerDir, 0o775);
  const refused = await runCliError(control, [
    'workflow',
    'create',
    run + '_second',
    '--profile',
    governedProfile,
    '--setup',
    'setup.json',
    '--json',
  ]);
  expect(refused.error).toMatchObject({ code: 'INVALID_ARGUMENT', details: { reason: 'invalid_gaap_enrollment' } });
  const request = collect('pre-pr-review', 'protected-review', '--operation', operation);
  const changed = { code: 'TRANSITION_GUARD_FAILED', details: { reason: 'managed_producer_changed' } };
  expect((await runCliError(control, request)).error).toMatchObject(changed);
  await chmod(readerDir, 0o700);
  await chmod(reader, 0o775);
  expect((await runCliError(control, request)).error).toMatchObject(changed);
  await chmod(reader, 0o700);
  if (process.platform === 'darwin') {
    execFileSync('/bin/chmod', ['+a', 'everyone allow write', reader]);
    expect((await runCliError(control, request)).error).toMatchObject(changed);
    execFileSync('/bin/chmod', ['-N', reader]);
    execFileSync('/bin/chmod', ['+a', 'everyone allow read', reader]);
  }
  expect(await call('inspect', run)).toEqual(before);
  expect(parseJson<{ data: unknown }>((await runCli(control, request)).stdout).data).toMatchObject({
    state_version: 3,
  });
}, 30_000);

it('runs the declared gate once and collects only the retained review at its enrolled base, head and tree', async () => {
  const { control, run, status, file, call, collect } = await collectionFixture();
  const gate = collect('local-gate', 'first-gate', '--gate', 'check');
  const local = (await runCli(control, gate)).stdout;
  expect(parseJson<{ data: unknown }>(local).data).toMatchObject({ state_version: 3 });
  expect((await runCli(control, gate)).stdout).toBe(local);
  const review = collect('pre-pr-review', 'observe-review', '--operation', operation);
  const correct = status.meta.run.snapshot.commit_sha;
  status.meta.run.snapshot.commit_sha = '0'.repeat(40);
  await file('status.json', status);
  expect((await runCliError(control, review)).error.code).toBe('TRANSITION_GUARD_FAILED');
  status.meta.run.snapshot.commit_sha = correct;
  await file('status.json', status);
  const currentReview = collect('pre-pr-review', 'current-review', '--operation', operation);
  const received = (await runCli(control, currentReview)).stdout;
  expect((await runCli(control, currentReview)).stdout).toBe(received);
  expect((await call('inspect', run)).data).toMatchObject({ state: 'implementing', state_version: 3, collections: [] });
  const { createWorkflowStore } = await import('../../src/adapters/fs/workflow-store.js');
  const records = createWorkflowStore(control).read(run).observations;
  expect(records.flatMap((r) => r.receipts.map((receipt) => receipt.payload))).toContainEqual({
    type: 'pre_pr_review',
    outcome: 'changes_required',
    findings: [{ id: 'retained', blocking: true }],
  });
  expect(records.flatMap((r) => r.receipts.map((receipt) => receipt.payload))).toContainEqual({
    type: 'local_proof',
    gate_id: 'check',
    result: 'passed',
    clean: true,
  });
  expect(await readFile(path.join(control, 'status.json'), 'utf8')).toContain(correct);
}, 30_000);
