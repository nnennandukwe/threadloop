// Stop only the CLI that loaded this fixture, at an observed commit or gate invocation.
import childProcess from 'node:child_process';
import { writeSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const cut = process.env.THREADLOOP_TEST_COLLECTION_CUT;
function interrupt() {
  writeSync(2, 'collection-cut=' + cut + '\n');
  process.kill(process.pid, 'SIGKILL');
}

const writers = new WeakSet();
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  const statement = prepare.call(this, sql);
  if (!/^INSERT INTO workflow_collection_events\b/.test(sql)) return statement;
  const run = statement.run.bind(statement);
  statement.run = (...args) => {
    const result = run(...args);
    if (args[3] === cut) writers.add(this);
    return result;
  };
  return statement;
};
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  const result = exec.call(this, sql);
  if (sql === 'COMMIT' && writers.has(this)) interrupt();
  return result;
};

if (cut === 'after-invocation') {
  const spawn = childProcess.spawn;
  childProcess.spawn = (...args) => {
    const child = spawn(...args);
    child.stdout?.on('data', (chunk) => {
      if (chunk.toString().includes('local gate counted')) interrupt();
    });
    return child;
  };
  syncBuiltinESMExports();
}

if (cut === 'report-error' || cut === 'output-published') {
  const link = fsPromises.link;
  fsPromises.link = async (staged, file) => {
    if (cut === 'report-error' && typeof file === 'string' && path.basename(file) === 'execution.json') {
      writeSync(2, 'collection-cut=report-error\n');
      throw Object.assign(new Error('The test refused to publish the execution report.'), { code: 'EIO' });
    }
    await link(staged, file);
    if (cut === 'output-published' && typeof file === 'string' && path.basename(file) === 'setup-0-prepare.stdout.log')
      interrupt();
  };
  syncBuiltinESMExports();
}
