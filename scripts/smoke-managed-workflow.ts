import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import type { DecisionReply } from '../src/domain/workflow-run.js';
import { managedWorkflowFixture } from '../tests/helpers/workflow-execution.js';
import { cleanupTemporaryState, git } from '../tests/helpers/session.js';
import { governedProfile } from '../tests/helpers/workflow-run.js';

const execute = promisify(execFile);
const cli = process.argv[2];
if (!cli || !path.isAbsolute(cli)) throw new Error('Pass the absolute installed ThreadLoop CLI entry point.');
async function run(mode: 'success' | 'signature') {
  const { control, producerRoot } = await managedWorkflowFixture(mode);
  const runId = 'session_wf_packaged_' + mode;
  const command = (...args: string[]) => execute(process.execPath, [cli!, ...args, '--json'], { cwd: control });
  const json = async <T>(...args: string[]) => (JSON.parse((await command(...args)).stdout) as { data: T }).data;
  const saveDecision = async () => {
    const result = await command('workflow', 'decide', runId);
    await writeFile(path.join(control, 'decision.json'), result.stdout);
    return (JSON.parse(result.stdout) as { data: DecisionReply }).data.controller_decision.decision;
  };
  try {
    await git(control, 'init', '-b', 'main');
    await execute(process.execPath, [cli!, 'init'], { cwd: control });
    await command('workflow', 'create', runId, '--profile', governedProfile, '--setup', 'setup.json');
    for (const edge of ['frame', 'bind_plan', 'begin_implementation']) {
      const decision = await saveDecision();
      assert.equal(decision.outcome, 'transition_available');
      await command('workflow', 'apply', runId, '--decision', 'decision.json', '--idempotency-key', edge);
    }
    const decision = await saveDecision();
    assert.equal(decision.outcome, 'engineering_action_required');
    const submit = () =>
      json<{ disposition: string; correlation: { request_digest: string } }>(
        'workflow',
        'execute',
        runId,
        '--decision',
        'decision.json',
      );
    if (mode === 'success') {
      const first = await submit();
      assert.equal(first.disposition, 'imported');
      assert.equal(first.correlation.request_digest, decision.action_request.request_digest);
      assert.deepEqual(await submit(), first);
    } else {
      const refused = async (operation: () => Promise<unknown>, reason: RegExp) => {
        try {
          await operation();
        } catch (error) {
          const failure = JSON.parse((error as { stderr: string }).stderr) as {
            error: { code: string; details?: { reason?: string } };
          };
          assert.equal(failure.error.code, 'EXECUTOR_REJECTED');
          assert.match(failure.error.details?.reason ?? '', reason);
          return;
        }
        assert.fail('The installed runtime accepted a result with an invalid fixture signature.');
      };
      await refused(submit, /^execution_outstanding$/);
      const held = await json<{ execution: { correlation: unknown } }>('workflow', 'inspect', runId);
      await writeFile(path.join(control, 'correlation.json'), JSON.stringify(held.execution.correlation));
      await refused(
        () =>
          command(
            'workflow',
            'evidence',
            'import',
            'gaap',
            '--run',
            runId,
            '--source',
            'correlation.json',
            '--expected-state-version',
            '3',
          ),
        /^dsse\.signature$/,
      );
      await refused(submit, /^execution_outstanding$/);
    }
    const view = await json<{ state: string; state_version: number }>('workflow', 'inspect', runId);
    assert.equal(view.state, 'implementing');
    assert.equal(view.state_version, 3);
    const stateRoot = path.join(control, '.threadloop');
    const childFiles = (await readdir(stateRoot, { recursive: true })).filter(
      (name) => path.basename(name) === 'executor.sqlite',
    );
    assert.equal(childFiles.length, 1);
    const database = new DatabaseSync(path.join(stateRoot, childFiles[0]!), { readOnly: true });
    try {
      assert.equal(database.prepare('SELECT count(*) AS n FROM launch').get()?.n, 1);
      assert.equal(database.prepare('SELECT count(*) AS n FROM accepted').get()?.n, mode === 'success' ? 1 : 0);
    } finally {
      database.close();
    }
  } finally {
    await rm(producerRoot, { recursive: true, force: true });
    await cleanupTemporaryState();
  }
}
await run('success');
await run('signature');
console.log(
  'The installed managed Workflow Run verified the signed fixture result and refused its invalid signature after one launch each.',
);
