// Order two real child writers after the managed producer has finished and before its output commits.
import { ChildProcess, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mock } from 'node:test';

const spawn = ChildProcess.prototype.spawn;
let returned;
ChildProcess.prototype.spawn = function (options) {
  const result = spawn.call(this, options);
  const output = options.envPairs.find((item) => item.startsWith('THREADLOOP_GAAP_EVIDENCE_DIRECTORY='));
  if (output) {
    const stdout = createHash('sha256');
    const stderr = createHash('sha256');
    this.stdout.on('data', (bytes) => stdout.update(bytes));
    this.stderr.on('data', (bytes) => stderr.update(bytes));
    this.once('close', () => {
      const directory = output.slice(output.indexOf('=') + 1);
      const envelope = readFileSync(path.join(directory, 'envelope.json'));
      returned = {
        stdout: stdout.digest('hex'),
        stderr: stderr.digest('hex'),
        envelope: createHash('sha256').update(envelope).digest('hex'),
      };
    });
  }
  return result;
};

const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  if (returned && sql === 'PRAGMA synchronous=FULL; BEGIN IMMEDIATE') {
    const captured = returned;
    returned = undefined;
    const readRoot = () => JSON.parse(this.prepare('SELECT body FROM root WHERE id=1').get().body);
    const root = readRoot();
    const deadline = root.journal.execution.entries.find((e) => e.operation.command.kind === 'acquire').operation
      .command.valid_until;
    const command = [
      process.argv[1],
      'workflow',
      'expire-claim',
      root.owner.workflow_run_id,
      '--attempt',
      root.request.request.attempt_id,
      '--expected-state-version',
      String(root.binding.snapshot.binding.state_version),
      '--json',
    ];
    const expiry = spawnSync(process.execPath, ['--import', new URL('clock.mjs', import.meta.url).href, ...command], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, NODE_OPTIONS: '', THREADLOOP_TEST_CLOCK: deadline },
    });
    if (expiry.status !== 0) throw new Error(expiry.stderr || 'The expiry writer failed.');
    const expired = readRoot();
    const database = this.prepare('PRAGMA database_list')
      .all()
      .find((entry) => entry.name === 'main');
    copyFileSync(database.file, process.env.THREADLOOP_TEST_OBSERVATION_CAPTURE + '.sqlite');
    writeFileSync(
      process.env.THREADLOOP_TEST_OBSERVATION_CAPTURE,
      JSON.stringify({
        deadline,
        captured,
        expiry: JSON.parse(expiry.stdout).data,
        child_revision: expired.revision,
        journal_digest: expired.journal.execution_digest,
        authority: expired.authority,
      }),
    );
    mock.timers.enable({ apis: ['Date'], now: Date.parse(deadline) });
  }
  return exec.call(this, sql);
};
