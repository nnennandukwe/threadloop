import { copyFile, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from '../../src/adapters/fs/sqlite-driver.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { GaapState } from '../../src/adapters/fs/gaap-state.js';
import { createWorkflowStore } from '../../src/adapters/fs/workflow-store.js';
import type { ManagedGaapInspection } from '../../src/services/gaap-executor.js';
import type { GaapProcessResult } from '../../src/adapters/process/gaap-runner.js';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { managedWorkflowFixture } from '../helpers/workflow-execution.js';
import { parseJson, runCli, runCliError, resolveTestCliBundle } from '../helpers/cli.js';
import { cleanupTemporaryState, git } from '../helpers/session.js';
import { governedProfile } from '../helpers/workflow-run.js';
import type { DecisionReply } from '../../src/domain/workflow-run.js';

let cli: string;
beforeAll(() => {
  cli = resolveTestCliBundle();
});
const temporaryProducers: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryProducers.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await cleanupTemporaryState();
});

async function managedFixture(mode = 'success', maxAttempts = 1) {
  const run = 'session_wf_managed';
  const { control, subject, producerRoot, host, adapter } = await managedWorkflowFixture(mode);
  temporaryProducers.push(producerRoot);
  const file = (name: string, value: unknown) => writeFile(path.join(control, name), JSON.stringify(value));
  host.environment.TEST_GAAP_COUNTER_DIRECTORY = control;
  await file('host.json', host);
  adapter.execution_policy.max_attempts = maxAttempts;
  await file('adapter.json', adapter);
  await git(control, 'init', '-b', 'main');
  await runCli(control, ['init']);
  const command = async <T>(...args: string[]) =>
    parseJson<{ data: T }>((await runCli(control, ['workflow', ...args, '--json'])).stdout);
  await command('create', run, '--profile', governedProfile, '--setup', 'setup.json');
  for (const edge of ['frame', 'bind_plan', 'begin_implementation']) {
    await file('decision.json', await command('decide', run));
    await command('apply', run, '--decision', 'decision.json', '--idempotency-key', edge);
  }
  return { control, subject, run, command, file };
}

it('executes a saved engineering request once and recovers its admission without advancing the run', async () => {
  const { control, run, command, file } = await managedFixture();
  const saved = await command<DecisionReply>('decide', run);
  const decision = saved.data.controller_decision.decision;
  expect(decision.outcome).toBe('engineering_action_required');
  if (decision.outcome !== 'engineering_action_required') throw new Error('Expected a selected engineering request');
  const digest = decision.action_request.request_digest;
  await file('decision.json', saved);
  const execute = () =>
    command<{
      disposition: string;
      correlation: unknown;
      claim: { id: string; version: number };
      attempt_status: string;
    }>('execute', run, '--decision', 'decision.json');
  const first = await execute();
  expect(first.data).toMatchObject({
    disposition: 'imported',
    state_version: 3,
    correlation: { workflow_run_id: run, request_digest: digest },
  });
  await file('correlation.json', first.data.correlation);
  const recovered = await command(
    'evidence',
    'import',
    'gaap',
    '--run',
    run,
    '--source',
    'correlation.json',
    '--expected-state-version',
    '3',
  );
  expect(recovered.data).toEqual(first.data);
  expect((await execute()).data).toEqual(first.data);
  const children = (await readdir(path.join(control, '.threadloop'), { recursive: true })).filter(
    (name) => path.basename(name) === 'executor.sqlite',
  );
  expect(children).toHaveLength(1);
  const inspected = await command<{ execution: { claim: { id: string; version: number }; attempt: string } }>(
    'inspect',
    run,
  );
  expect(inspected.data).toMatchObject({
    state: 'implementing',
    state_version: 3,
    execution: { attempt: 'succeeded' },
  });
  expect(first.data.claim).toEqual(inspected.data.execution.claim);
  expect(first.data.attempt_status).toBe(inspected.data.execution.attempt);
}, 30_000);

const exec = promisify(execFile);
const preload = fileURLToPath(new URL('../fixtures/workflow/execution-cut.mjs', import.meta.url));
async function interruptExecution(control: string, args: string[], cut: string, env?: NodeJS.ProcessEnv) {
  const failure = await exec(process.execPath, ['--import', preload, cli, ...args], {
    cwd: control,
    timeout: 25_000,
    env: { ...process.env, ...env, THREADLOOP_TEST_EXECUTION_CUT: cut },
  }).then(
    () => null,
    (err: Error & { signal?: string; stderr?: string }) => err,
  );
  expect(failure?.signal).toBe('SIGKILL');
  expect(failure?.stderr).toContain('managed-cut=' + cut);
}
function atDeadline(at: string) {
  return {
    NODE_OPTIONS: '--import=' + new URL('../fixtures/workflow/clock.mjs', import.meta.url).href,
    NODE_NO_WARNINGS: '1',
    THREADLOOP_TEST_CLOCK: at,
  };
}

interface ClaimInspection {
  state_version: number;
  execution: {
    valid_until: string;
    child_revision: number;
    observation: { status: string } | null;
    correlation: { attempt_id: string };
    recovery_argv: string[];
  };
}

it.each([
  { cut: 'enroll', launches: 0, reported: 'enrolled' },
  { cut: 'start', launches: 0, reported: 'started' },
  { cut: 'observe', launches: 1, reported: 'started' },
  { cut: 'before_observation_commit', launches: 1, reported: 'started' },
  { cut: 'admit', launches: 1, reported: 'admitted' },
  { cut: 'import', launches: 1, reported: 'imported' },
])(
  'recovers the child after a process dies at $cut',
  async ({ cut, launches, reported }) => {
    const { control, run, command, file } = await managedFixture();
    await file('expectation.json', await command('decide', run));
    const args = ['workflow', 'execute', run, '--decision', 'expectation.json', '--json'];
    await interruptExecution(control, args, cut);
    const readCount = () =>
      readFile(path.join(control, 'invocations.log'), 'utf8').then(
        (b) => b.trim().split('\n').length,
        (e: NodeJS.ErrnoException) => {
          if (e.code === 'ENOENT') return 0;
          throw e;
        },
      );
    expect(await readCount()).toBe(launches);
    const inspect = await command<{ execution: { disposition: string; correlation: unknown }; state_version: number }>(
      'inspect',
      run,
    );
    expect(inspect.data).toMatchObject({ state_version: 3, execution: { disposition: reported } });
    await file('recover.json', inspect.data.execution.correlation);
    const recover = [
      'workflow',
      'evidence',
      'import',
      'gaap',
      '--run',
      run,
      '--source',
      'recover.json',
      '--expected-state-version',
      '3',
      '--json',
    ];
    if (cut === 'start' || cut === 'before_observation_commit') {
      expect(inspect.data.execution).toMatchObject({ observation: null, source_id: null });
      expect((await runCliError(control, args)).error.details.reason).toBe('execution_outstanding');
      expect((await runCliError(control, recover)).error.details.reason).toBe('execution_outstanding');
      expect(await readCount()).toBe(launches);
    } else {
      let deadline: NodeJS.ProcessEnv | undefined;
      if (cut === 'admit') {
        const retained = (await command<ClaimInspection>('inspect', run)).data.execution;
        deadline = atDeadline(retained.valid_until);
        expect(
          (
            await runCliError(
              control,
              [
                'workflow',
                'expire-claim',
                run,
                '--attempt',
                retained.correlation.attempt_id,
                '--expected-state-version',
                '3',
                '--json',
              ],
              deadline,
            )
          ).error.details.reason,
        ).toBe('claim_closed');
        const child = (await readdir(path.join(control, '.threadloop'), { recursive: true })).find(
          (p) => path.basename(p) === 'executor.sqlite',
        )!;
        await rm(path.join(control, '.threadloop', path.dirname(child), 'outputs'), { recursive: true });
      }
      const { stdout } = await runCli(control, cut === 'enroll' ? args : recover, deadline);
      expect(parseJson<{ data: unknown }>(stdout).data).toMatchObject({ disposition: 'imported', state_version: 3 });
      expect(await readCount()).toBe(1);
    }
  },
  35_000,
);

it('holds a lost subprocess effect across retries and refuses a changed request', async () => {
  const { control, subject, run, command, file } = await managedFixture('effect_response_lost');
  const saved = await command<DecisionReply>('decide', run);
  const selected = saved.data.controller_decision.decision;
  if (selected.outcome !== 'engineering_action_required') throw new Error('Expected selected engineering work');
  await file('effect.json', saved);
  const args = ['workflow', 'execute', run, '--decision', 'effect.json', '--json'];
  expect((await runCliError(control, args)).error.details).toMatchObject({
    reason: 'execution_outstanding',
    phase: 'transport',
    child_reason: 'exit_failed',
  });
  expect(await readFile(path.join(subject, 'source.txt'), 'utf8')).toMatch(/effect occurred/);
  expect((await runCliError(control, args)).error.details.reason).toBe('execution_outstanding');
  const changed = structuredClone(saved);
  changed.data.expectation.history_digest = 'e'.repeat(64);
  await file('effect.json', changed);
  expect((await runCliError(control, args)).error.code).toBe('IDEMPOTENCY_CONFLICT');
  const inspect = await command<{ execution: { recovery_argv: string[]; child_revision: number } }>('inspect', run);
  expect(inspect.data).toMatchObject({ state_version: 3, execution: { launch_count: 1, source_id: null } });
  const recovery = inspect.data.execution.recovery_argv;
  expect(recovery.slice(0, 3)).toEqual(['threadloop', 'executor', 'inspect']);
  const recovered = parseJson<{ data: unknown }>((await runCli(control, recovery.slice(1))).stdout);
  expect(recovered.data).toMatchObject({
    revision: inspect.data.execution.child_revision,
    launch_count: 1,
    observations: [{ status: 'exit_failed' }],
    admitted: [],
  });
  expect((await command('inspect', run)).data).toEqual(inspect.data);
  expect((await readFile(path.join(control, 'invocations.log'), 'utf8')).trim().split('\n')).toHaveLength(1);
}, 35_000);

it.each([
  { cut: 'observe', status: 'unknown_outcome', effect: 'unknown', launches: 1 },
  { cut: 'enroll', status: 'interrupted', effect: 'not_started', launches: 0 },
])(
  'records expiry once for the real Attempt after $cut',
  async ({ cut, status, effect, launches }) => {
    const { control, run, command, file } = await managedFixture();
    await file('decision.json', await command('decide', run));
    const execute = ['workflow', 'execute', run, '--decision', 'decision.json', '--json'];
    await interruptExecution(control, execute, cut);
    const inspect = ['workflow', 'inspect', run, '--json'];
    const before = (await command<ClaimInspection>('inspect', run)).data.execution;
    const attempt = before.correlation.attempt_id;
    const expire = (id: string, version: number) => [
      'workflow',
      'expire-claim',
      run,
      '--attempt',
      id,
      '--expected-state-version',
      String(version),
      '--json',
    ];
    const deadline = atDeadline(before.valid_until);
    await file('correlation.json', before.correlation);
    const importArgs = [
      'workflow',
      'evidence',
      'import',
      'gaap',
      '--run',
      run,
      '--source',
      'correlation.json',
      '--expected-state-version',
      '3',
      '--json',
    ];
    expect(
      (
        await runCliError(
          control,
          expire(attempt, 3),
          atDeadline(new Date(Date.parse(before.valid_until) - 1).toISOString()),
        )
      ).error.details.reason,
    ).toBe('claim_not_expired');
    expect((await runCliError(control, expire('wrong-attempt', 3), deadline)).error.details.reason).toBe(
      'attempt_mismatch',
    );
    expect((await runCliError(control, expire(attempt, 2), deadline)).error.details.reason).toBe('stale_version');
    const overdue = parseJson<{ data: ClaimInspection }>((await runCli(control, inspect, deadline)).stdout).data
      .execution;
    expect(overdue.child_revision).toBe(before.child_revision);
    expect(overdue.recovery_argv.slice(1)).toEqual(expire(attempt, 3));
    if (cut === 'observe') {
      expect(overdue.observation?.status).toBe('ok');
      expect((await runCliError(control, importArgs, deadline)).error.details.reason).toBe(
        'execution_authority_changed',
      );
    }
    await interruptExecution(control, expire(attempt, 3), 'expire', deadline);
    const cutRead = parseJson<{ data: ClaimInspection }>((await runCli(control, inspect, deadline)).stdout).data;
    expect(cutRead.execution).toMatchObject({
      claim_status: 'expired',
      attempt: status,
      effect,
      observation: before.observation,
      recovery_argv: overdue.recovery_argv,
    });
    const record = async () =>
      parseJson<{ data: { recovery_argv: string[]; recovery: string } }>(
        (await runCli(control, expire(attempt, 3), deadline)).stdout,
      ).data;
    const first = await record();
    expect(first).toMatchObject({
      disposition: 'claim_expired',
      state_version: 3,
      closed_at: before.valid_until,
      attempt_id: attempt,
      attempt_status: status,
      effect,
      launch_count: launches,
      attempts_used: 1,
      max_attempts: 1,
      attempts_remaining: 0,
      retry_safety: 'reconciliation_required',
    });
    expect(await record()).toEqual(first);
    expect(first.recovery).toMatch(cut === 'observe' ? /independent evidence/ : /exhausted its Attempt budget/);
    const child = parseJson<{ data: unknown }>(
      (await runCli(control, first.recovery_argv.slice(1), deadline)).stdout,
    ).data;
    expect(child).toMatchObject({
      projection: { claims: [{ status: 'expired' }], attempts: [{ id: attempt, status, effect }] },
      launch_count: launches,
      admitted: [],
      observations: cut === 'observe' ? [{ status: 'ok' }] : [],
    });
    const next = parseJson<{ data: DecisionReply }>(
      (await runCli(control, ['workflow', 'decide', run, '--json'], deadline)).stdout,
    ).data;
    expect(next.controller_decision.decision.outcome).toBe('blocked');
    expect((await runCliError(control, execute, deadline)).error.code).toBe('EXECUTOR_REJECTED');
    const calls = await readFile(path.join(control, 'invocations.log'), 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return '';
      },
    );
    expect(calls.trim().split('\n').filter(Boolean)).toHaveLength(launches);
    expect(parseJson<{ data: ClaimInspection }>((await runCli(control, inspect, deadline)).stdout).data).toMatchObject({
      state_version: 3,
      execution: { child_revision: cutRead.execution.child_revision, recovery_argv: first.recovery_argv },
    });
  },
  35_000,
);

it('reports the original remaining policy budget after a prelaunch expiry', async () => {
  const { control, run, command, file } = await managedFixture('success', 2);
  await file('selected.json', await command('decide', run));
  await interruptExecution(control, ['workflow', 'execute', run, '--decision', 'selected.json', '--json'], 'enroll');
  const { execution } = (await command<ClaimInspection>('inspect', run)).data;
  const clock = atDeadline(execution.valid_until);
  const expired = await runCli(
    control,
    [
      'workflow',
      'expire-claim',
      run,
      '--attempt',
      execution.correlation.attempt_id,
      '--expected-state-version',
      '3',
      '--json',
    ],
    clock,
  );
  const reply = parseJson<{ data: { recovery: string } }>(expired.stdout).data;
  expect(reply.recovery).toMatch(/separately authorized replacement/);
  expect(reply).toMatchObject({
    attempt_status: 'interrupted',
    effect: 'not_started',
    launch_count: 0,
    attempts_used: 1,
    max_attempts: 2,
    attempts_remaining: 1,
  });
  const inspect = await runCli(control, ['workflow', 'inspect', run, '--json'], clock);
  expect(parseJson<{ data: unknown }>(inspect.stdout).data).toMatchObject({
    execution: { attempts_remaining: 1, retry_safety: 'reconciliation_required' },
  });
  expect(
    await readFile(path.join(control, 'invocations.log'), 'utf8').catch((error: NodeJS.ErrnoException) => error.code),
  ).toBe('ENOENT');
}, 30_000);

it('retains the returned transport when another writer expires the claim before the observation commit', async () => {
  const { control, run, command, file } = await managedFixture();
  await file('selected.json', await command('decide', run));
  const args = ['workflow', 'execute', run, '--decision', 'selected.json', '--json'];
  const captureFile = path.join(control, 'capture.json');
  const writer = await runCliError(control, args, {
    NODE_OPTIONS: '--import=' + new URL('../fixtures/workflow/expire-returned-observation.mjs', import.meta.url).href,
    NODE_NO_WARNINGS: '1',
    THREADLOOP_TEST_OBSERVATION_CAPTURE: captureFile,
  });
  const capture = parseJson<{
    deadline: string;
    captured: { stdout: string; stderr: string; envelope: string };
    expiry: { claim_status: string; attempt_status: string; launch_count: number };
    child_revision: number;
    journal_digest: string;
    authority: string[];
  }>(await readFile(captureFile, 'utf8'));
  expect(capture.expiry).toMatchObject({ claim_status: 'expired', attempt_status: 'unknown_outcome', launch_count: 1 });
  expect(writer.error.details.reason).toBe('execution_outstanding');
  const env = atDeadline(capture.deadline);
  const inspect = async () =>
    parseJson<{ data: ClaimInspection }>((await runCli(control, ['workflow', 'inspect', run, '--json'], env)).stdout)
      .data;
  const view = await inspect();
  expect(view).toMatchObject({
    state_version: 3,
    execution: {
      attempt: 'unknown_outcome',
      claim_status: 'expired',
      observation: { id: 1, status: 'ok' },
      launch_count: 1,
      source_id: null,
    },
  });
  const childDir = view.execution.recovery_argv[4]!;
  const child = new DatabaseSync(path.join(childDir, 'executor.sqlite'), { readOnly: true });
  try {
    const root = JSON.parse(String(child.prepare('SELECT body FROM root WHERE id=1').get()!.body)) as {
      journal: { execution_digest: string };
      revision: number;
      authority: string[];
    };
    expect(root.revision).toBe(capture.child_revision + 1);
    expect(root.journal.execution_digest).toBe(capture.journal_digest);
    expect(root.authority).toEqual(capture.authority);
    const rows = child.prepare('SELECT stdout,stderr,envelope FROM observation').all();
    expect(rows).toHaveLength(1);
    for (const name of ['stdout', 'stderr', 'envelope'] as const) {
      expect(sha256(rows[0]![name] as Uint8Array)).toBe(capture.captured[name]);
    }
    expect(child.prepare('SELECT COUNT(*) AS count FROM accepted').get()?.count).toBe(0);
  } finally {
    child.close();
  }
  const store = new GaapState(childDir);
  const retained = store.inspectForReport();
  const { root } = retained;
  if (root.schema_version !== 'threadloop.gaap-state/2') throw new Error('Expected the managed child');
  const row = retained.observations[0]!;
  const output = String(retained.launches[0]!.output_directory);
  const metadata = JSON.parse(String(row.metadata)) as Omit<GaapProcessResult, 'stdout' | 'stderr'>;
  const diagnostic = {
    transport: {
      ...metadata,
      stdout: Buffer.from(row.stdout as Uint8Array),
      stderr: Buffer.from(row.stderr as Uint8Array),
    },
    envelope: Buffer.from(row.envelope as Uint8Array),
    evidenceError: null,
  };
  expect(() =>
    store.recordObservation(root.request, output, diagnostic, { ...root.owner, reservation_id: 'another' }),
  ).toThrow(/owning Workflow Run/);
  expect(() => store.recordObservation(root.request, path.join(output, 'another'), diagnostic, root.owner)).toThrow(
    /committed launch/,
  );
  expect(() => store.recordObservation(root.request, output, diagnostic, root.owner)).toThrow(
    /already has a retained observation/,
  );
  expect(store.inspectForReport()).toEqual(retained);
  // A second caller can finish its verified read before our transport commits and report it afterwards.
  const controlDb = new DatabaseSync(path.join(control, '.threadloop', 'state', 'state.db'), { readOnly: true });
  let earlier: ManagedGaapInspection;
  try {
    const event = controlDb
      .prepare("SELECT body FROM workflow_execution_events WHERE run_id=? AND kind='observe' ORDER BY revision LIMIT 1")
      .get(run)!;
    earlier = (JSON.parse(String(event.body)) as { child: ManagedGaapInspection }).child;
  } finally {
    controlDb.close();
  }
  expect(earlier.revision).toBe(capture.child_revision);
  expect(earlier.observations).toHaveLength(0);
  const delayed = createWorkflowStore(control).observeExecution(run, root.owner.reservation_id, earlier);
  expect(delayed.child?.observations).toEqual([{ id: 1, status: 'ok' }]);
  expect(await inspect()).toEqual(view);
  await file('late.json', view.execution.correlation);
  const late = await runCliError(
    control,
    [
      'workflow',
      'evidence',
      'import',
      'gaap',
      '--run',
      run,
      '--source',
      'late.json',
      '--expected-state-version',
      '3',
      '--json',
    ],
    env,
  );
  expect(late.error.details.reason).toBe('execution_authority_changed');
  expect((await runCliError(control, args, env)).error.details.reason).toBe('execution_outstanding');
  expect(await inspect()).toEqual(view);
  await copyFile(captureFile + '.sqlite', path.join(childDir, 'executor.sqlite'));
  expect((await runCliError(control, ['workflow', 'inspect', run, '--json'], env)).error.code).toBe('STATE_CORRUPTED');
  expect((await runCliError(control, args, env)).error.code).toBe('STATE_CORRUPTED');
  expect((await readFile(path.join(control, 'invocations.log'), 'utf8')).trim().split('\n')).toHaveLength(1);
}, 35_000);
