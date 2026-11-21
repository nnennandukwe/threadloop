import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { managedWorkflowFixture } from '../helpers/workflow-execution.js';
import { governedProfile } from '../helpers/workflow-run.js';
import { cleanupTemporaryState, commitFiles, git } from '../helpers/session.js';
import { parseJson, runCli, runCliError } from '../helpers/cli.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await cleanupTemporaryState();
});
const operation = '125fe082-9417-45e2-b6c7-ab7a38e0c40e';
async function collectionFixture() {
  const { control, subject, producerRoot, setup } = await managedWorkflowFixture();
  roots.push(producerRoot);
  const file = (name: string, value: unknown) => writeFile(path.join(control, name), JSON.stringify(value));
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
  const reader = path.join(control, 'qodo-fixture'),
    raw = path.join(control, 'status.json');
  await writeFile(
    reader,
    '#!' +
      process.execPath +
      '\n' +
      'if(JSON.stringify(process.argv.slice(2))!==' +
      JSON.stringify(JSON.stringify(['review', 'status', operation, '--json'])) +
      ')process.exit(3);\n' +
      "process.stdout.write(require('node:fs').readFileSync(" +
      JSON.stringify(raw) +
      '));\n',
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
  return { control, subject, run, file, status, call, collect };
}
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
