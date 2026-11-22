import { ensureWorkflowCollectionSchema } from './workflow-collection-schema.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../domain/canonical-json.js';
import type { AdmissionReply, HostSource, RunSnapshot } from '../../domain/workflow-run.js';
import { ThreadloopError } from '../../contracts/errors.js';
import { sha256 } from '../crypto/sha256.js';
import { withExistingStateWrite, withReadSnapshot } from './sqlite-store.js';
import type { DatabaseSync } from './sqlite-driver.js';
import { expectVersion, loadJournal } from './workflow-journal.js';
import { retainSource, restoreSource, type SourceRecord } from './workflow-stored-source.js';

export interface CollectionTarget {
  kind: 'local-gate' | 'pre-pr-review';
  target: string;
  state_version: number;
}
interface Intent extends CollectionTarget {
  attempt: string;
  subject_digest: string;
}
type Event =
  | { phase: 'intent'; intent: Intent }
  | { phase: 'captured'; record: SourceRecord }
  | { phase: 'completed'; reply: AdmissionReply }
  | { phase: 'failed'; reason: string };

function fail(message: string): never {
  throw new ThreadloopError('TRANSITION_GUARD_FAILED', message, {
    details: {
      reason: 'collection_outstanding',
      hint: 'Inspect the collection attempt and its retained output before retrying.',
    },
  });
}
function history(db: DatabaseSync, run: string, key: string): Event[] {
  return db
    .prepare(
      'SELECT ordinal,phase,body,digest FROM workflow_collection_events WHERE run_id=? AND key=? ORDER BY ordinal',
    )
    .all(run, key)
    .map((row, i) => {
      if (
        row.ordinal !== i ||
        typeof row.body !== 'string' ||
        row.digest !== sha256(canonicalJson([run, key, i, row.phase, row.body]))
      )
        fail('The retained collection has an invalid event digest.');
      const event = JSON.parse(row.body) as Event;
      if (event.phase !== row.phase || canonicalJson(event) !== row.body)
        fail('The retained collection event has invalid bytes.');
      return event;
    });
}
function append(db: DatabaseSync, run: string, key: string, ordinal: number, event: Event) {
  const body = canonicalJson(event);
  db.prepare('INSERT INTO workflow_collection_events VALUES(?,?,?,?,?,?)').run(
    run,
    key,
    ordinal,
    event.phase,
    body,
    sha256(canonicalJson([run, key, ordinal, event.phase, body])),
  );
}
function outstanding(db: DatabaseSync, run: string) {
  ensureWorkflowCollectionSchema(db);
  return db
    .prepare(
      "SELECT key FROM workflow_collection_events WHERE run_id=? GROUP BY key HAVING SUM(phase IN ('completed','failed'))=0 ORDER BY key",
    )
    .all(run)
    .map((row) => {
      const key = String(row.key);
      const events = history(db, run, key);
      const first = events[0];
      if (first?.phase !== 'intent') fail('The retained producer attempt has no intent.');
      return { key, ...first.intent, phase: events.at(-1)!.phase };
    });
}
export function activeWorkflowCollections(root: string, run: string) {
  return withReadSnapshot(root, (db) => outstanding(db, run));
}
export function guardWorkflowCollections(root: string, run: string) {
  if (activeWorkflowCollections(root, run).length) fail('An outstanding evidence collection holds this run.');
}
export function openCollection(
  root: string,
  run: string,
  key: string,
  target: CollectionTarget,
  preflight: (snapshot: RunSnapshot) => string,
) {
  return withExistingStateWrite(root, (db) => {
    const snapshot = loadJournal(db, run)?.snapshot;
    if (!snapshot?.genesis.gaap) fail('Evidence collection requires a managed Workflow Run.');
    ensureWorkflowCollectionSchema(db);
    const events = history(db, run, key),
      first = events[0],
      last = events.at(-1);
    if (first) {
      if (
        first.phase !== 'intent' ||
        first.intent.kind !== target.kind ||
        first.intent.target !== target.target ||
        first.intent.state_version !== target.state_version
      )
        throw new ThreadloopError('IDEMPOTENCY_CONFLICT', 'The collection key belongs to another request.');
      if (last?.phase === 'completed') return { stage: 'completed' as const, reply: last.reply };
      if (last?.phase === 'failed') fail(last.reason);
      if (last?.phase === 'captured') {
        const { verified } = restoreSource(last.record);
        if (verified.kind !== 'local-gate' && verified.kind !== 'pre-pr-review')
          fail('The retained collector source has the wrong kind.');
        return { stage: 'captured' as const, source: verified };
      }
      if (target.kind === 'local-gate') {
        // The gate's attempt directory is created before the gate launches. If it is absent, the gate never ran,
        // so the attempt can be closed safely and no longer holds the run.
        if (existsSync(path.join(root, '.threadloop', 'artifacts', 'workflow-collections', first.intent.attempt)))
          fail('A local gate may already have run. Its retained attempt must be reconciled before another launch.');
        const reason =
          'The local gate never launched before the interruption. Its attempt was closed; retry with a new idempotency key.';
        append(db, run, key, events.length, { phase: 'failed', reason });
        return { stage: 'abandoned' as const, reason };
      }
    } else if (outstanding(db, run).length) fail('Another collection holds this run.');
    expectVersion(snapshot.view.state_version, target.state_version);
    if (snapshot.managed_execution?.active) fail('An outstanding executor Attempt holds this run.');
    const subject = preflight(snapshot);
    const intent =
      first?.phase === 'intent' ? first.intent : { ...target, subject_digest: subject, attempt: randomUUID() };
    if (subject !== intent.subject_digest) fail('The collector subject changed during recovery.');
    if (!first) append(db, run, key, 0, { phase: 'intent', intent });
    return { stage: 'collect' as const, intent, snapshot };
  });
}
export function captureCollection(root: string, run: string, key: string, source: HostSource) {
  return withExistingStateWrite(root, (db) => {
    const rows = history(db, run, key);
    const last = rows.at(-1);
    if (last?.phase === 'completed') return last.reply;
    if (last?.phase === 'captured') {
      if (canonicalJson(last.record) !== canonicalJson(retainSource(source)))
        fail('Concurrent collectors observed different source bytes.');
    } else if (last?.phase === 'intent')
      append(db, run, key, rows.length, { phase: 'captured', record: retainSource(source) });
    else fail('The producer attempt has no active intent.');
    return undefined;
  });
}
export function finishCollection(
  root: string,
  run: string,
  key: string,
  event: Extract<Event, { phase: 'completed' | 'failed' }>,
) {
  withExistingStateWrite(root, (db) => {
    const rows = history(db, run, key),
      last = rows.at(-1);
    if (canonicalJson(last) === canonicalJson(event)) return;
    if (
      event.phase === 'completed' ? last?.phase !== 'captured' : last?.phase !== 'intent' && last?.phase !== 'captured'
    )
      fail('The collector completion conflicts with its retained events.');
    append(db, run, key, rows.length, event);
  });
}
