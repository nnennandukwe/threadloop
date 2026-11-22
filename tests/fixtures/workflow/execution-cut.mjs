// Kill the test caller immediately before or after the selected real SQLite commit.
import { writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const point = process.env.THREADLOOP_TEST_EXECUTION_CUT;
const armed = new WeakSet();
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  const statement = prepare.call(this, sql);
  const childPhase = /^INSERT INTO (launch|observation|accepted)\b/.exec(sql)?.[1];
  const outer = sql.startsWith('INSERT INTO workflow_execution_events(');
  const expiry = point === 'expire' && sql.startsWith('UPDATE root SET ');
  if (!childPhase && !outer && !expiry) return statement;
  const run = statement.run.bind(statement);
  statement.run = (...args) => {
    const result = run(...args);
    const phase = outer ? args[5] : { launch: 'start', observation: 'observe', accepted: 'admit' }[childPhase];
    const expired = expiry && JSON.parse(args[0]).journal.execution.entries.at(-1)?.operation.command.kind === 'expire';
    if (phase === point || expired || (phase === 'observe' && point === 'before_observation_commit')) armed.add(this);
    return result;
  };
  return statement;
};
function interrupt() {
  writeSync(2, 'managed-cut=' + point + '\n');
  process.kill(process.pid, 'SIGKILL');
}
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  const selected = sql === 'COMMIT' && armed.has(this);
  if (selected && point === 'before_observation_commit') interrupt();
  const result = exec.call(this, sql);
  if (selected) interrupt();
  return result;
};
