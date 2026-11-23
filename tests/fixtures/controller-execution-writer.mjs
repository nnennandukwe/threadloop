// Each process receives one admitted test operation and competes for the actual SQLite writer lock.
import { readFileSync, writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ScenarioJournal } from '../../scripts/controller-conformance/scenario-journal.ts';

const { filename, step, admissions } = JSON.parse(readFileSync(0, 'utf8'));
const digests = new Set(admissions);
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  if (sql === 'BEGIN IMMEDIATE') writeSync(2, 'scenario-writer-at-begin\n');
  return exec.call(this, sql);
};
const journal = new ScenarioJournal(filename, { isAdmitted: (digest) => digests.has(digest) });
const result = journal.apply(step.context, step.operation);
process.stdout.write(
  JSON.stringify(result.ok ? { result: result.value.result, replayed: result.value.replayed } : result),
);
