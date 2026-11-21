// Loaded only in a test child. Kill that process at the requested writer boundary.
import { writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const writers = new WeakSet();
const cut = process.env.THREADLOOP_TEST_SQLITE_CUT;
function interrupt(point) {
  if (cut === point) {
    writeSync(2, `workflow-cut=${point}\n`);
    process.kill(process.pid, 'SIGKILL');
  }
}
const originalExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  if (sql === 'BEGIN IMMEDIATE') writers.add(this);
  if (writers.has(this) && sql === 'COMMIT') interrupt('before commit');
  const result = originalExec.call(this, sql);
  if (writers.has(this) && sql.startsWith('CREATE TABLE workflow_graphs')) interrupt('after schema');
  if (writers.has(this) && sql === 'COMMIT') {
    interrupt('after commit');
    writers.delete(this);
  }
  return result;
};
const originalPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  const statement = originalPrepare.call(this, sql);
  if (!writers.has(this)) return statement;
  const write = /^(INSERT INTO|UPDATE) (workflow_\w+)/.exec(sql);
  if (!write) return statement;
  const run = statement.run.bind(statement);
  statement.run = (...args) => {
    const result = run(...args);
    interrupt('after ' + write[2]);
    return result;
  };
  return statement;
};
