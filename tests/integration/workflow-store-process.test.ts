import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeAll, expect, it } from 'vitest';
import { withReadSnapshot } from '../../src/adapters/fs/sqlite-store.js';
import type { AdmissionReply, ApplyReply, Preparation, RunView } from '../../src/domain/workflow-run.js';
import { parseJson, resolveTestCliBundle, runCli, runCliError } from '../helpers/cli.js';
import { cleanupTemporaryState, git } from '../helpers/session.js';
import { governedProfile, governedWorkflowFixture } from '../helpers/workflow-run.js';

const exec = promisify(execFile);
const preload = fileURLToPath(new URL('../fixtures/workflow/sqlite-cut.mjs', import.meta.url));
const run = 'session_wf_durable';
const create = ['workflow', 'create', run, '--profile', governedProfile, '--setup', 'setup.json', '--json'];
const inspect = ['workflow', 'inspect', run, '--json'];
const prepare = [
  'workflow',
  'evidence',
  'prepare',
  'signed-gate',
  '--run',
  run,
  '--gate',
  'check',
  '--expected-state-version',
  '0',
  '--idempotency-key',
  'gate',
  '--json',
];

let cli: string;
beforeAll(() => {
  cli = resolveTestCliBundle();
});
afterEach(cleanupTemporaryState);

async function killed(root: string, argv: string[], point: string) {
  const failure = await exec(process.execPath, ['--import', preload, ...argv], {
    cwd: root,
    env: { ...process.env, THREADLOOP_TEST_SQLITE_CUT: point },
    timeout: 12_000,
  }).then(
    () => null,
    (err: Error & { signal?: string; stderr?: string }) => err,
  );
  expect(failure?.signal).toBe('SIGKILL');
  expect(failure?.stderr).toContain('workflow-cut=' + point);
}
function runCommand<T>(control: string, args: string[]) {
  return runCli(control, args).then(({ stdout }) => parseJson<{ data: T }>(stdout).data);
}
async function initialized() {
  const { control } = await governedWorkflowFixture();
  await git(control, 'init');
  await runCli(control, ['init']);
  return control;
}
function eventCount(control: string) {
  return withReadSnapshot(
    control,
    (db) => db.prepare('SELECT count(*) AS n FROM workflow_events WHERE run_id=?').get(run)?.n,
  );
}

it('recovers create across each uncommitted write and after losing the committed response', async () => {
  const control = await initialized();
  for (const cut of [
    'after schema',
    'after workflow_graphs',
    'after workflow_runs',
    'after workflow_events',
    'after workflow_heads',
    'before commit',
  ]) {
    await killed(control, [cli, ...create], cut);
    expect((await runCliError(control, inspect)).error.code).toBe('WORKFLOW_RUN_NOT_FOUND');
    const owned = withReadSnapshot(control, (db) =>
      db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'workflow_%'").all(),
    );
    expect(owned).toEqual([]);
  }
  await killed(control, [cli, ...create], 'after commit');
  const committed = await runCommand<RunView>(control, inspect);
  const replay = await runCommand<RunView>(control, create);
  expect(replay).toEqual(committed);
  expect(committed).toMatchObject({ state_version: 0, evidence_revision: 0 });
  expect(eventCount(control)).toBe(1);
});

it('recovers preparation and transition receipts at writer and lost-response boundaries', async () => {
  const control = await initialized();
  const initial = await runCommand<RunView>(control, create);
  for (const point of ['after workflow_events', 'after workflow_heads', 'before commit']) {
    await killed(control, [cli, ...prepare], point);
    expect(await runCommand<RunView>(control, inspect)).toEqual(initial);
    expect(eventCount(control)).toBe(1);
  }
  await killed(control, [cli, ...prepare], 'after commit');
  const prepared = await runCommand<Preparation>(control, prepare);
  expect(prepared.prepared_id).toMatch(/^wfr_[a-f0-9]{32}$/);
  expect(eventCount(control)).toBe(2);
  const decision = await runCli(control, ['workflow', 'decide', run, '--json']);
  await writeFile(path.join(control, 'decision.json'), decision.stdout);
  const apply = ['workflow', 'apply', run, '--decision', 'decision.json', '--idempotency-key', 'frame', '--json'];
  for (const point of ['after workflow_events', 'after workflow_heads', 'before commit']) {
    await killed(control, [cli, ...apply], point);
    expect(await runCommand<RunView>(control, inspect)).toEqual(initial);
    expect(eventCount(control)).toBe(2);
  }
  await killed(control, [cli, ...apply], 'after commit');
  const committed = await runCommand<RunView>(control, inspect);
  expect(await runCommand<ApplyReply>(control, apply)).toMatchObject({
    state_version: 1,
    event_digest: committed.history_digest,
  });
  expect(await runCommand<Preparation>(control, prepare)).toEqual(prepared);
  expect(eventCount(control)).toBe(3);
});

it('serializes independent creates and competing applies against the same version', async () => {
  const control = await initialized();
  const [a, b] = await Promise.all([runCommand<RunView>(control, create), runCommand<RunView>(control, create)]);
  expect(b).toEqual(a);
  const decision = await runCli(control, ['workflow', 'decide', run, '--json']);
  await writeFile(path.join(control, 'decision.json'), decision.stdout);
  const apply = (key: string) => [
    'workflow',
    'apply',
    run,
    '--decision',
    'decision.json',
    '--idempotency-key',
    key,
    '--json',
  ];
  const results = await Promise.allSettled(['one', 'two'].map((key) => runCommand<ApplyReply>(control, apply(key))));
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const loser = results.find((result) => result.status === 'rejected');
  expect(parseJson<{ error: { code: string } }>((loser?.reason as { stderr: string }).stderr).error.code).toBe(
    'STATE_VERSION_CONFLICT',
  );
  const winner = results[0]!.status === 'fulfilled' ? 0 : 1;
  expect(results[winner]).toEqual({
    status: 'fulfilled',
    value: await runCommand<ApplyReply>(control, apply(winner === 0 ? 'one' : 'two')),
  });
  expect(eventCount(control)).toBe(2);
});

it('recovers a single admission after process loss and refuses a decision from its earlier evidence revision', async () => {
  const control = await initialized();
  const initial = await runCommand<RunView>(control, create);
  const decision = await runCli(control, ['workflow', 'decide', run, '--json']);
  await writeFile(path.join(control, 'decision.json'), decision.stdout);
  const source = fileURLToPath(new URL('../fixtures/workflow/admit-review.ts', import.meta.url));
  const args = ['--import', import.meta.resolve('tsx'), source, control, run, new Date().toISOString()];
  for (const point of ['after workflow_events', 'after workflow_heads', 'before commit']) {
    await killed(control, args, point);
    expect(await runCommand<RunView>(control, inspect)).toEqual(initial);
    expect(eventCount(control)).toBe(1);
  }
  await killed(control, args, 'after commit');
  const replay = parseJson<AdmissionReply>((await exec(process.execPath, args, { cwd: control })).stdout);
  expect(replay).toMatchObject({ state_version: 0, evidence_revision: 1 });
  expect(replay.receipt_ids).toHaveLength(1);
  expect(replay.receipt_ids[0]).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
  const apply = ['workflow', 'apply', run, '--decision', 'decision.json', '--idempotency-key', 'stale', '--json'];
  expect((await runCliError(control, apply)).error).toMatchObject({
    code: 'STATE_VERSION_CONFLICT',
    details: { reason: 'stale_evidence_revision' },
  });
  expect(eventCount(control)).toBe(2);
});
