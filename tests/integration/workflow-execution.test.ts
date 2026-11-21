import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

async function managedFixture(mode = 'success') {
  const run = 'session_wf_managed';
  const { control, subject, producerRoot, host } = await managedWorkflowFixture(mode);
  temporaryProducers.push(producerRoot);
  const file = (name: string, value: unknown) => writeFile(path.join(control, name), JSON.stringify(value));
  host.environment.TEST_GAAP_COUNTER_DIRECTORY = control;
  await file('host.json', host);
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
it.each([
  { cut: 'enroll', launches: 0, reported: 'enrolled' },
  { cut: 'start', launches: 0, reported: 'started' },
  { cut: 'observe', launches: 1, reported: 'started' },
  { cut: 'admit', launches: 1, reported: 'admitted' },
  { cut: 'import', launches: 1, reported: 'imported' },
])(
  'recovers the child after a process dies just after $cut commits',
  async ({ cut, launches, reported }) => {
    const { control, run, command, file } = await managedFixture();
    await file('expectation.json', await command('decide', run));
    const args = ['workflow', 'execute', run, '--decision', 'expectation.json', '--json'];
    const failure = await exec(process.execPath, ['--import', preload, cli, ...args], {
      cwd: control,
      timeout: 25_000,
      env: { ...process.env, THREADLOOP_TEST_EXECUTION_CUT: cut },
    }).then(
      () => null,
      (err: Error & { signal?: string; stderr?: string }) => err,
    );
    expect(failure?.signal).toBe('SIGKILL');
    expect(failure?.stderr).toContain('managed-cut=' + cut);
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
    if (cut === 'start') {
      expect((await runCliError(control, args)).error.details.reason).toBe('execution_outstanding');
      expect((await runCliError(control, recover)).error.details.reason).toBe('execution_outstanding');
      expect(await readCount()).toBe(0);
    } else {
      if (cut === 'admit') {
        const child = (await readdir(path.join(control, '.threadloop'), { recursive: true })).find(
          (p) => path.basename(p) === 'executor.sqlite',
        )!;
        await rm(path.join(control, '.threadloop', path.dirname(child), 'outputs'), { recursive: true });
      }
      const { stdout } = await runCli(control, cut === 'enroll' ? args : recover);
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
  expect((await runCliError(control, args)).error.details.reason).toBe('execution_outstanding');
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
