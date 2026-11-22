import { execFile, execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { DatabaseSync } from '../../src/adapters/fs/sqlite-driver.js';
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
async function collectionFixture(
  gateCommand?: (control: string) => string[],
  readerBody?: string,
  scratchDirectoryFor?: 'gate' | 'setup',
) {
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
    plan.gates[0]!.setup = [
      {
        id: 'prepare',
        command: [
          process.execPath,
          '-e',
          "process.stdout.write('setup output'); process.stderr.write('setup diagnostics');",
        ],
        working_directory: '.',
        timeout_ms: 5_000,
      },
    ];
    if (scratchDirectoryFor) {
      await mkdir(path.join(subject, 'scratch'));
      const gate = plan.gates[0]!;
      const setup = gate.setup![0]!;
      (scratchDirectoryFor === 'gate' ? gate : setup).working_directory = 'scratch';
      setup.command = [
        process.execPath,
        '-e',
        "require('fs').appendFileSync(process.argv[1], 'setup\\n')",
        path.join(control, 'commands.log'),
      ];
    }
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
      (readerBody ??
        'if(JSON.stringify(process.argv.slice(2))!==' +
          JSON.stringify(JSON.stringify(['review', 'status', operation, '--json'])) +
          ')process.exit(3);\n' +
          "process.stdout.write(require('node:fs').readFileSync(require('node:path').join(__dirname, '../status.json')));\n"),
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

async function countedCollection(waitForRelease = false, scratchDirectoryFor?: 'gate' | 'setup') {
  const gate = fileURLToPath(new URL('../fixtures/workflow/collection-gate.mjs', import.meta.url));
  const fixture = await collectionFixture(
    (control) => [
      process.execPath,
      gate,
      path.join(control, 'gate-invocations'),
      ...(waitForRelease ? [path.join(control, 'release-gate')] : []),
    ],
    undefined,
    scratchDirectoryFor,
  );
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
  async function interruptAt(cut: 'intent' | 'captured' | 'after-invocation' | 'report-error' | 'output-published') {
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

it.each(['gate', 'setup'] as const)(
  'restores a missing %s working directory and collects once with the original key',
  async (role) => {
    const { control, subject, run, call, collect } = await collectionFixture(
      (root) => [
        process.execPath,
        '-e',
        "require('fs').appendFileSync(process.argv[1], 'gate\\n')",
        path.join(root, 'commands.log'),
      ],
      undefined,
      role,
    );
    const scratch = path.join(subject, 'scratch');
    const counts = path.join(control, 'commands.log');
    const request = collect('local-gate', 'restore-scratch', '--gate', 'check');
    const field =
      role === 'gate'
        ? 'proof_plan.gates.check.working_directory'
        : 'proof_plan.gates.check.setup.prepare.working_directory';
    await rm(scratch, { recursive: true });
    for (const state of ['missing', 'file']) {
      if (state === 'file') await writeFile(scratch, 'ordinary file');
      const { error } = await runCliError(control, request);
      expect(error).toMatchObject({ code: 'INVALID_ARGUMENT', details: { field, reason: 'invalid_gate_directory' } });
      expect(error.message).toContain('scratch');
      expect(error.details.hint).toContain('same collection key');
      expect((await call('inspect', run)).data).toMatchObject({ state_version: 3, collections: [] });
      await expect(readFile(counts)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await rm(scratch);
    await mkdir(scratch);
    const completed = await runCli(control, request);
    expect(parseJson<{ data: unknown }>(completed.stdout).data).toMatchObject({ state_version: 3 });
    expect(await readFile(counts, 'utf8')).toBe('setup\ngate\n');
    await rm(scratch, { recursive: true });
    expect((await runCli(control, request)).stdout).toBe(completed.stdout);
    expect(await readFile(counts, 'utf8')).toBe('setup\ngate\n');
  },
  30_000,
);

it('resumes a prelaunch intent once when two CLI processes retry the same gate', async () => {
  const { control, subject, run, args, count, inspect, interruptAt } = await countedCollection(true, 'setup');
  await interruptAt('intent');
  expect(await count()).toBe(0);
  const reserved = await inspect();
  expect(reserved).toMatchObject({ state_version: 3, collections: [{ key: 'interrupted-gate', phase: 'reserved' }] });
  const scratch = path.join(subject, 'scratch');
  await rm(scratch, { recursive: true });
  expect((await runCliError(control, args)).error.details.reason).toBe('invalid_gate_directory');
  expect(await inspect()).toEqual(reserved);
  expect(await count()).toBe(0);
  await mkdir(scratch);
  const attemptDirectory = path.join(
    control,
    '.threadloop',
    'artifacts',
    'workflow-collections',
    reserved.collections[0]!.attempt,
  );
  await mkdir(attemptDirectory, { recursive: true, mode: 0o700 });
  const saved = path.join(attemptDirectory, 'saved-output');
  await writeFile(saved, 'saved');
  expect((await runCliError(control, args)).error.message).toContain('empty before its first command');
  expect(await readFile(saved, 'utf8')).toBe('saved');
  expect(await inspect()).toEqual(reserved);
  expect(await count()).toBe(0);
  await rm(saved);
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

function capturedGateFiles(control: string, run: string): Map<string, Buffer> {
  const db = new DatabaseSync(path.join(control, '.threadloop', 'state', 'state.db'), { readOnly: true });
  try {
    const capture = db
      .prepare("SELECT body FROM workflow_collection_events WHERE run_id=? AND key=? AND phase='captured'")
      .get(run, 'interrupted-gate');
    const { record } = parseJson<{
      record: { artifact: { base64: string }; outputs: { path: string; content: { base64: string } }[] };
    }>(String(capture?.body));
    return new Map(
      [...record.outputs, { path: 'execution.json', content: record.artifact }].map(({ path: name, content }) => [
        name,
        Buffer.from(content.base64, 'base64'),
      ]),
    );
  } finally {
    db.close();
  }
}

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
    const capturedReport = capturedGateFiles(control, run).get('execution.json')!;
    await rm(directory, { recursive: true });
    if (cut === 'captured') {
      await interruptAt('output-published');
      expect(await readFile(path.join(directory, 'setup-0-prepare.stdout.log'), 'utf8')).toBe('setup output');
      await expect(stat(path.join(directory, 'execution.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await count()).toBe(1);
    }
    const [first, concurrent] = await Promise.all([runCli(control, args), runCli(control, args)]);
    expect(concurrent.stdout).toBe(first.stdout);
    const admitted = first.stdout;
    expect((await runCli(control, args)).stdout).toBe(admitted);
    expect(await count()).toBe(1);
    expect(await inspect()).toMatchObject({ state_version: 3, collections: [] });
    const report = parseJson<{ receipt_id: string; result: string }>(
      await readFile(path.join(directory, 'execution.json'), 'utf8'),
    );
    expect(report).toMatchObject({ receipt_id: 'receipt_' + attempt, result: 'passed' });
    expect(await readFile(path.join(directory, 'execution.json'))).toEqual(capturedReport);
    expect(await readFile(path.join(directory, 'stdout.log'), 'utf8')).toBe('local gate counted\n');
    expect(await readFile(path.join(directory, 'stderr.log'))).toHaveLength(0);
    expect(await readFile(path.join(directory, 'setup-0-prepare.stdout.log'), 'utf8')).toBe('setup output');
    expect(await readFile(path.join(directory, 'setup-0-prepare.stderr.log'), 'utf8')).toBe('setup diagnostics');
    await rm(path.join(directory, 'execution.json'));
    expect((await runCli(control, args)).stdout).toBe(admitted);
    expect(await readFile(path.join(directory, 'execution.json'))).toEqual(capturedReport);
    expect(await count()).toBe(1);
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

it('syncs gate files and their directories before admitting or replaying the captured result', async () => {
  const { control, run, args, count, inspect, interruptAt } = await countedCollection();
  await interruptAt('captured');
  const captured = await inspect();
  const attempt = captured.collections[0]!.attempt;
  const retained = capturedGateFiles(control, run);
  const artifacts = '.threadloop/artifacts';
  const collections = artifacts + '/workflow-collections';
  const directory = collections + '/' + attempt;
  const stdout = directory + '/stdout.log';
  const trace = path.join(control, 'gate-sync-trace');
  const preload = new URL('../fixtures/workflow/collection-sync.mjs', import.meta.url);
  const env = { NODE_OPTIONS: '--import=' + preload.href, THREADLOOP_TEST_GATE_SYNC_TRACE: trace };
  const failSync = async (name: string) => {
    const result = await runCliError(control, args, { ...env, THREADLOOP_TEST_GATE_SYNC_FAILURE: name });
    expect(result.error).toMatchObject({
      code: 'TRANSITION_GUARD_FAILED',
      details: { reason: 'collection_result_captured', workflow_run_id: run, key: 'interrupted-gate', attempt },
    });
    expect((await readFile(trace, 'utf8')).trim().split('\n').at(-1)).toBe(
      JSON.stringify({ name, result: 'injected EIO' }),
    );
    expect(capturedGateFiles(control, run)).toEqual(retained);
    expect(await count()).toBe(1);
  };
  const { createWorkflowStore } = await import('../../src/adapters/fs/workflow-store.js');
  const admittedGates = () =>
    createWorkflowStore(control)
      .read(run)
      .observations.flatMap((item) => item.receipts)
      .filter((receipt) => receipt.payload.type === 'local_proof');
  for (const name of [stdout, directory, collections]) {
    await failSync(name);
    expect(await inspect()).toEqual(captured);
    expect(admittedGates()).toHaveLength(0);
  }
  await writeFile(trace, '');
  const reply = (await runCli(control, args, env)).stdout;
  expect(admittedGates()).toHaveLength(1);
  const syncs = (await readFile(trace, 'utf8'))
    .trim()
    .split('\n')
    .map((row) => parseJson<{ name: string }>(row).name);
  const names = [
    'stdout.log',
    'stderr.log',
    'setup-0-prepare.stdout.log',
    'setup-0-prepare.stderr.log',
    'execution.json',
  ];
  expect(syncs).toEqual(expect.arrayContaining(names.map((name) => directory + '/' + name)));
  expect(syncs.slice(-5)).toEqual([directory, collections, artifacts, '.threadloop', '.']);
  for (const name of names) expect(await readFile(path.join(control, directory, name))).toEqual(retained.get(name));
  await failSync(directory);
  expect(admittedGates()).toHaveLength(1);
  expect((await runCli(control, args, env)).stdout).toBe(reply);
  expect(await count()).toBe(1);
}, 30_000);

it('preserves conflicting gate files and refuses admission until the operator moves them aside', async () => {
  const { control, run, args, count, inspect, interruptAt } = await countedCollection();
  await interruptAt('captured');
  const pending = await inspect();
  const attempt = pending.collections[0]!.attempt;
  const directory = path.join(control, '.threadloop', 'artifacts', 'workflow-collections', attempt);
  const report = path.join(directory, 'execution.json');
  const stdout = path.join(directory, 'stdout.log');
  const expected = {
    code: 'TRANSITION_GUARD_FAILED',
    details: {
      reason: 'collection_artifact_conflict',
      workflow_run_id: run,
      key: 'interrupted-gate',
      attempt,
    },
  };
  await writeFile(report, 'existing report');
  expect((await runCliError(control, args)).error).toMatchObject(expected);
  expect(await readFile(report, 'utf8')).toBe('existing report');
  await rm(report);
  await rm(stdout);
  const outside = path.join(control, 'preserved-file');
  await writeFile(outside, 'local gate counted\n');
  await symlink(outside, stdout);
  expect((await runCliError(control, args)).error).toMatchObject(expected);
  expect(await readFile(outside, 'utf8')).toBe('local gate counted\n');
  await rm(stdout);
  await chmod(directory, 0o777);
  expect((await runCliError(control, args)).error).toMatchObject(expected);
  await chmod(directory, 0o700);
  expect(await inspect()).toEqual(pending);
  await expect(stat(report)).rejects.toMatchObject({ code: 'ENOENT' });
  await runCli(control, args);
  expect(await readFile(stdout, 'utf8')).toBe('local gate counted\n');
  expect(await count()).toBe(1);
  expect(await inspect()).toMatchObject({ state_version: 3, collections: [] });
}, 30_000);

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

it('retries an unfinished Qodo operation with its original collection key', async () => {
  const { control, run, collect, call, file, status } = await collectionFixture();
  const request = collect('pre-pr-review', 'waiting-review', '--operation', operation);
  const working = { operation_id: operation, status: 'working' };
  const partial = {
    ...status,
    meta: { ...status.meta, coverage: { complete: false }, run: { ...status.meta.run, timing: {} } },
    finding_state: { ...status.finding_state, complete: false },
  };
  for (const report of [working, partial]) {
    await file('status.json', report);
    expect((await runCliError(control, request)).error).toMatchObject({
      code: 'TRANSITION_GUARD_FAILED',
      details: { reason: 'review_pending' },
    });
  }
  const primary = status.meta.run.passes[0]!;
  await file('status.json', {
    ...status,
    meta: {
      ...status.meta,
      run: {
        ...status.meta.run,
        passes: [
          {
            ...primary,
            agents: [
              ...primary.agents,
              { name: 'conversion_agent', status: 'skipped', reason: 'no_eligible_findings' },
            ],
          },
        ],
      },
    },
  });
  const completed = (await runCli(control, request)).stdout;
  expect((await runCli(control, request)).stdout).toBe(completed);
  expect((await call('inspect', run)).data.collections).toEqual([]);
}, 30_000);

it('releases an expired Qodo operation while preserving retries for an outage or an error for another operation', async () => {
  const next = '38503227-6954-40e9-8f3b-429a50cd86e1';
  const reader = `const [command, action, id, format] = process.argv.slice(2);
if (command !== 'review' || action !== 'status' || ![${JSON.stringify(operation)}, ${JSON.stringify(next)}].includes(id) || format !== '--json') process.exit(3);
const response = require('node:fs').readFileSync(require('node:path').join(__dirname, '../status.json'), 'utf8');
process.stdout.write(response);
if (JSON.parse(response).error) process.exitCode = 1;`;
  const { control, run, call, collect, file, status } = await collectionFixture(undefined, reader);
  const first = collect('pre-pr-review', 'original-review', '--operation', operation);
  const replacement = collect('pre-pr-review', 'replacement-review', '--operation', next);
  // This Qodo CLI response preserves the provider's U+2014 delimiter and error wording.
  const message =
    'no such review \u2014 the id may never have existed, may belong to another user, or may have expired (results are kept about 60 minutes after a review finishes, by default). The runtime does not distinguish these. Re-run the review.';
  const expired = { operation_id: operation, message, trace_id: 'review-status-trace' };
  for (const error of [
    { ...expired, message: 'Connection lost' },
    { ...expired, operation_id: next },
  ]) {
    await file('status.json', { error });
    expect((await runCliError(control, first)).error.details.reason).toBe('invalid_producer');
    expect((await runCliError(control, replacement)).error.details.reason).toBe('collection_outstanding');
  }
  for (const [key, error] of [
    ['original-review', expired],
    ['without-trace', { operation_id: operation, message }],
  ] as const) {
    await file('status.json', { error });
    const lookup = collect('pre-pr-review', key, '--operation', operation);
    expect((await runCliError(control, lookup)).error.details).toMatchObject({
      reason: 'invalid_terminal_review',
      operation_id: operation,
    });
  }
  await file('status.json', status);
  const admitted = (await runCli(control, replacement)).stdout;
  expect(parseJson<{ data: unknown }>(admitted).data).toMatchObject({ state_version: 3 });
  expect((await call('inspect', run)).data.collections).toEqual([]);
}, 30_000);
