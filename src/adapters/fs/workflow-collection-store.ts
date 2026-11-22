import { ensureWorkflowCollectionSchema, requireGateLaunchSchema } from './workflow-collection-schema.js';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../../domain/canonical-json.js';
import type { AdmissionReply, HostSource, RunSnapshot } from '../../domain/workflow-run.js';
import { StateCorruptedError, ThreadloopError } from '../../contracts/errors.js';
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
  launch_protocol?: 1;
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
function history(db: DatabaseSync, run: string, key: string) {
  const events = db
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
  const first = events[0];
  const claimed =
    first?.phase === 'intent' && first.intent.launch_protocol !== undefined
      ? launchClaimed(db, run, key, first.intent)
      : undefined;
  if (claimed === false && events.some((event) => event.phase === 'captured' || event.phase === 'completed'))
    throw new StateCorruptedError('The captured gate result has no committed launch claim.');
  return { events, claimed };
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
function intentDigest(run: string, key: string, intent: Intent) {
  return sha256(canonicalJson([run, key, 0, 'intent', canonicalJson({ phase: 'intent', intent })]));
}

function launchClaimed(db: DatabaseSync, run: string, key: string, intent: Intent): boolean {
  if (intent.launch_protocol !== 1 || intent.kind !== 'local-gate')
    throw new StateCorruptedError('The collection has an unsupported gate launch protocol.');
  requireGateLaunchSchema(db);
  const row = db
    .prepare('SELECT attempt,intent_digest,claimed FROM workflow_gate_launches WHERE run_id=? AND key=?')
    .get(run, key);
  if (
    row?.attempt !== intent.attempt ||
    row.intent_digest !== intentDigest(run, key, intent) ||
    (row.claimed !== 0 && row.claimed !== 1)
  )
    throw new StateCorruptedError(
      'The managed gate launch reservation is missing or differs from its intent. Restore the original control database before retrying.',
    );
  return row.claimed === 1;
}

function heldGate(run: string, key: string, attempt: string): never {
  throw new ThreadloopError(
    'TRANSITION_GUARD_FAILED',
    'The gate may already have started. Its outcome is still unknown.',
    {
      details: {
        reason: 'collection_outstanding',
        workflow_run_id: run,
        key,
        attempt,
        hint: `Inspect workflow run ${run} and retry the original collection key ${key} to recover captured output.`,
      },
    },
  );
}

function ready(snapshot: RunSnapshot, target: CollectionTarget, preflight: (snapshot: RunSnapshot) => string) {
  expectVersion(snapshot.view.state_version, target.state_version);
  if (snapshot.managed_execution?.active) fail('An outstanding executor Attempt holds this run.');
  return preflight(snapshot);
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
      const { events, claimed } = history(db, run, key);
      const first = events[0];
      if (first?.phase !== 'intent') fail('The retained producer attempt has no intent.');
      const last = events.at(-1)!.phase;
      const phase = last === 'intent' && claimed !== undefined ? (claimed ? 'launch_claimed' : 'reserved') : last;
      return { key, ...first.intent, phase };
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
    const { events, claimed } = history(db, run, key);
    const first = events[0],
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
        if (claimed !== false) heldGate(run, key, first.intent.attempt);
        return { stage: 'collect' as const, intent: first.intent, snapshot };
      }
    } else if (outstanding(db, run).length) fail('Another collection holds this run.');
    const digest = ready(snapshot, target, preflight);
    const intent: Intent =
      first?.phase === 'intent'
        ? first.intent
        : {
            ...target,
            subject_digest: digest,
            attempt: randomUUID(),
            ...(target.kind === 'local-gate' ? { launch_protocol: 1 } : {}),
          };
    if (digest !== intent.subject_digest) fail('The collector subject changed during recovery.');
    if (!first) {
      if (intent.launch_protocol) requireGateLaunchSchema(db, true);
      append(db, run, key, 0, { phase: 'intent', intent });
      if (intent.launch_protocol)
        db.prepare(
          'INSERT INTO workflow_gate_launches(run_id,key,attempt,intent_digest,claimed) VALUES(?,?,?,?,0)',
        ).run(run, key, intent.attempt, intentDigest(run, key, intent));
    }
    return { stage: 'collect' as const, intent, snapshot };
  });
}

export function claimCollectionLaunch(
  root: string,
  run: string,
  key: string,
  attempt: string,
  preflight: (snapshot: RunSnapshot) => string,
): boolean {
  return withExistingStateWrite(root, (db) => {
    const snapshot = loadJournal(db, run)?.snapshot;
    if (!snapshot?.genesis.gaap) fail('Gate launch requires its managed Workflow Run.');
    ensureWorkflowCollectionSchema(db);
    const { events: rows, claimed } = history(db, run, key);
    const first = rows[0];
    if (first?.phase !== 'intent' || first.intent.kind !== 'local-gate' || first.intent.attempt !== attempt)
      fail('The claim must identify the original gate and attempt.');
    const intent = first.intent;
    if (intent.launch_protocol === undefined) heldGate(run, key, attempt);
    if (claimed || rows.at(-1)?.phase !== 'intent') return false;
    if (ready(snapshot, intent, preflight) !== intent.subject_digest) fail('The gate subject changed before launch.');
    const result = db
      .prepare('UPDATE workflow_gate_launches SET claimed=1 WHERE run_id=? AND key=? AND attempt=? AND claimed=0')
      .run(run, key, attempt);
    return result.changes === 1;
  });
}

export function captureCollection(root: string, run: string, key: string, source: HostSource) {
  return withExistingStateWrite(root, (db) => {
    const { events: rows, claimed } = history(db, run, key);
    const first = rows[0],
      last = rows.at(-1);
    if (first?.phase !== 'intent') fail('The producer attempt has no intent.');
    const intent = first.intent,
      binding = source.producing.binding;
    if (
      source.kind !== intent.kind ||
      binding.workflow_run_id !== run ||
      binding.state_version !== intent.state_version ||
      binding.subject.content_digest !== intent.subject_digest ||
      (source.kind === 'local-gate' &&
        (source.receipt.gateId !== intent.target || source.receipt.id !== 'receipt_' + intent.attempt))
    )
      fail('The captured producer output differs from its collection intent.');
    const prior = rows.find((event) => event.phase === 'captured');
    if (prior) {
      if (canonicalJson(prior.record) !== canonicalJson(retainSource(source)))
        fail('Concurrent collectors observed different source bytes.');
      if (last?.phase === 'completed') return last.reply;
      if (last?.phase !== 'captured') fail('The producer attempt is already closed.');
    } else if (last?.phase === 'intent') {
      if (intent.kind === 'local-gate' && claimed !== true) fail('Only the claimed gate attempt can capture output.');
      append(db, run, key, rows.length, { phase: 'captured', record: retainSource(source) });
    } else fail('The producer attempt has no active intent.');
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
    const { events: rows, claimed } = history(db, run, key);
    const last = rows.at(-1);
    if (canonicalJson(last) === canonicalJson(event)) return;
    if (
      event.phase === 'completed' ? last?.phase !== 'captured' : last?.phase !== 'intent' && last?.phase !== 'captured'
    )
      fail('The collector completion conflicts with its retained events.');
    if (event.phase === 'failed' && last?.phase === 'intent' && last.intent.kind === 'local-gate' && claimed !== false)
      heldGate(run, key, last.intent.attempt);
    append(db, run, key, rows.length, event);
  });
}
