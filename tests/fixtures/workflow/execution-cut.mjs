// A process dies immediately after a selected real SQLite commit, before the caller can report it.
import { writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const point = process.env.THREADLOOP_TEST_EXECUTION_CUT;
const armed = new WeakSet();
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  const statement = prepare.call(this, sql);
  const childPhase = /^INSERT INTO (launch|observation|accepted)\b/.exec(sql)?.[1];
  const outer = sql.startsWith('INSERT INTO workflow_execution_events(');
  if (!childPhase && !outer) return statement;
  const run = statement.run.bind(statement);
  statement.run = (...args) => {
    const result = run(...args);
    const phase = outer ? args[5] : { launch: 'start', observation: 'observe', accepted: 'admit' }[childPhase];
    if (phase === point) armed.add(this);
    return result;
  };
  return statement;
};
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  const result = exec.call(this, sql);
  if (sql === 'COMMIT' && armed.has(this)) {
    writeSync(2, 'managed-cut=' + point + '\n');
    process.kill(process.pid, 'SIGKILL');
  }
  return result;
};
