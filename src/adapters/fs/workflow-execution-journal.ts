import path from 'node:path';
import { requestReference, replayExecutionJournal } from 'threadloop-contracts/execution';
import {
  executorRequestAdmissionDigest,
  validateExecutorRequest,
  validateExecutorResult,
} from 'threadloop-contracts/executor';
import { StateCorruptedError } from '../../contracts/errors.js';
import { canonicalJson } from '../../domain/canonical-json.js';
import {
  workflowCorrelation,
  type ManagedExecutionState,
  type WorkflowCorrelation,
  type WorkflowReservation,
} from '../../domain/workflow-execution.js';
import type { RunSnapshot } from '../../domain/workflow-run.js';
import { workflowDigest } from '../../domain/workflow-selection-types.js';
import type { ManagedGaapInspection } from '../../services/gaap-executor.js';
import {
  assertWorkflowObservation,
  decideWorkflow,
  workflowControllerInput,
  workflowGaapBinding,
} from '../../services/workflow-evaluation.js';
import type { DatabaseSync } from './sqlite-driver.js';
import type { Journal } from './workflow-journal.js';
import { demand, equal } from './workflow-storage-checks.js';
import { ensureWorkflowCollectionSchema } from './workflow-collection-schema.js';
import { workflowExecutionSchema } from './workflow-schema.js';

type ExecutionContent =
  | { kind: 'reserve'; reservation: Omit<WorkflowReservation, 'child' | 'imported'> }
  | { kind: 'enroll'; child: ManagedGaapInspection }
  | { kind: 'observe'; child: ManagedGaapInspection }
  | { kind: 'import'; child: ManagedGaapInspection; correlation: WorkflowCorrelation };
interface ExecutionRow {
  run_id: string;
  revision: number;
  lifecycle_ordinal: number;
  lifecycle_digest: string;
  previous: string;
  kind: ExecutionContent['kind'];
  request_key: string;
  marker: string | null;
  body: string;
  digest: string;
}

export function initialExecution(run: string, genesisDigest: string): ManagedExecutionState {
  return {
    revision: 0,
    digest: workflowDigest({
      schema_version: 'threadloop.workflow-execution/1',
      run_id: run,
      genesis_digest: genesisDigest,
    }),
    active: null,
    reservations: [],
    existing_requests: [],
    invalidated_claims: [],
  };
}

export function childDirectory(db: DatabaseSync, id: string) {
  const main = db.prepare("SELECT file FROM pragma_database_list WHERE name='main'").get();
  demand(main && typeof main.file === 'string' && path.isAbsolute(main.file), 'missing control database location');
  return path.join(path.dirname(main.file), 'workflow-execution-' + id);
}

function verifyReservation(
  db: DatabaseSync,
  journal: Journal,
  row: ExecutionRow,
  content: Extract<ExecutionContent, { kind: 'reserve' }>,
) {
  const reservation = content.reservation,
    snapshot = journal.snapshot,
    state = snapshot.managed_execution!;
  const selected = reservation.proposal.controller_decision.decision;
  assertWorkflowObservation(snapshot, reservation.observed);
  demand(
    !state.active &&
      selected.outcome === 'engineering_action_required' &&
      reservation.proposal.expectation.evaluation_time <= reservation.reserved_at &&
      reservation.owner.workflow_run_id === row.run_id &&
      /^[a-f0-9]{32}$/.test(reservation.owner.reservation_id) &&
      reservation.child_directory === childDirectory(db, reservation.owner.reservation_id) &&
      !state.reservations.some(
        (other) =>
          other.request_key === row.request_key || other.owner.reservation_id === reservation.owner.reservation_id,
      ) &&
      reservation.request_key === row.request_key &&
      reservation.request_key === selected.action_request.request.idempotency_key &&
      reservation.owner.request_digest === selected.action_request.request_digest &&
      equal(
        decideWorkflow(snapshot, reservation.observed, reservation.proposal.expectation.evaluation_time),
        reservation.proposal,
      ),
    'invalid selected reservation',
  );
  const input = workflowControllerInput(snapshot, reservation.observed, reservation.reserved_at);
  demand(
    equal(workflowGaapBinding(snapshot, input, selected.action_request), reservation.binding),
    'reservation differs from its current authority',
  );
  state.active = { ...reservation, child: null, imported: null };
  state.reservations.push(state.active);
}

function prefix<T>(before: T[], after: T[]) {
  return before.length <= after.length && equal(before, after.slice(0, before.length));
}

export function verifyChild(snapshot: RunSnapshot, reservation: WorkflowReservation, child: ManagedGaapInspection) {
  const binding = reservation.binding,
    envelope = child.request,
    request = envelope.request;
  const replay = replayExecutionJournal(child.journal, { isAdmitted: (digest) => child.authority.includes(digest) });
  demand(
    equal(child.owner, reservation.owner) &&
      child.binding_digest === workflowDigest(binding) &&
      child.host_digest === snapshot.genesis.gaap?.host_digest &&
      validateExecutorRequest(envelope).ok &&
      child.authority.includes(executorRequestAdmissionDigest(envelope)) &&
      equal(request.action_request, binding.action_request) &&
      equal(request.parameters, binding.parameters) &&
      equal(request.executor, binding.executor) &&
      request.mapping_policy.digest === binding.mapping_policy.policy_digest &&
      request.mapping_policy.id === binding.mapping_policy.policy.id &&
      equal(request.execution_policy, { id: binding.execution_policy.id, digest: binding.execution_policy.digest }) &&
      equal(child.journal.execution.action_request, binding.action_request) &&
      equal(child.journal.execution.execution_policy, binding.execution_policy) &&
      equal(child.journal.execution.initial_context.snapshot, {
        ...binding.snapshot,
        evaluation_time: child.journal.execution.initial_context.snapshot.evaluation_time,
      }) &&
      Number.isSafeInteger(child.revision) &&
      child.revision >= 0 &&
      replay.ok &&
      equal(replay.value, child.projection),
    'child owner, journal or executor envelope differs from its reservation',
  );
  const attempt = child.projection.attempts[0],
    claim = child.projection.claims[0];
  demand(
    child.projection.attempts.length === 1 &&
      child.projection.claims.length === 1 &&
      attempt?.id === request.attempt_id &&
      equal(attempt.claim, request.claim) &&
      equal(attempt.executor, request.executor) &&
      claim?.id === request.claim.id &&
      claim.attempt_id === request.attempt_id &&
      equal(claim.executor, request.executor) &&
      [0, 1].includes(child.launch_count) &&
      child.launch_count === Number(attempt.started_at !== null) &&
      child.observations.length <= child.launch_count &&
      child.observations.every(
        (observation) =>
          Number.isSafeInteger(observation.id) && observation.id > 0 && typeof observation.status === 'string',
      ) &&
      child.admitted.length === child.projection.receipts.length &&
      child.admitted.length <= child.observations.length,
    'child claim, Attempt or transport differs from its projection',
  );
  for (const fact of child.admitted) {
    const { admission, result } = fact;
    demand(
      validateExecutorResult(result, envelope).ok &&
        child.observations.some(
          (observation) => observation.id === fact.observation_id && observation.status === 'ok',
        ) &&
        admission.admission_digest === workflowDigest(admission.admission) &&
        child.journal.execution.entries.some((entry) =>
          entry.context.receipt_admissions.some((recordedAdmission) => equal(recordedAdmission, admission)),
        ) &&
        child.projection.receipts.some((receipt) => equal(receipt.envelope, result.result.attempt_receipt)) &&
        fact.source_id === result.result.source_receipt.id &&
        fact.source_digest === result.result.source_receipt.digest,
      'import differs from the admitted child receipt or source',
    );
  }
  const previous = reservation.child;
  if (previous) {
    demand(
      child.revision >= previous.revision &&
        (child.revision !== previous.revision || equal(child, previous)) &&
        equal(child.request, previous.request) &&
        equal(child.journal.execution.initial_context, previous.journal.execution.initial_context) &&
        prefix(previous.journal.execution.entries, child.journal.execution.entries) &&
        prefix(previous.authority, child.authority) &&
        prefix(previous.observations, child.observations) &&
        prefix(previous.admitted, child.admitted) &&
        child.launch_count >= previous.launch_count,
      'child inspection changed an earlier execution fact',
    );
  }
}

function foldExecution(db: DatabaseSync, journal: Journal, row: ExecutionRow, content: ExecutionContent) {
  const snapshot = journal.snapshot,
    state = snapshot.managed_execution!;
  const { digest, ...fields } = row;
  demand(
    row.run_id === snapshot.genesis.run_id &&
      row.revision === state.revision + 1 &&
      row.previous === state.digest &&
      row.lifecycle_ordinal === journal.head.ordinal &&
      row.lifecycle_digest === journal.head.digest &&
      row.body === canonicalJson(content) &&
      row.kind === content.kind &&
      row.marker === (row.kind === 'observe' ? null : row.request_key) &&
      workflowDigest(fields) === digest,
    'execution record differs from its bound history',
  );
  if (content.kind === 'reserve') verifyReservation(db, journal, row, content);
  else {
    const reservation = state.active;
    demand(
      reservation?.request_key === row.request_key && reservation && !reservation.imported,
      'execution event requires an active reservation',
    );
    const child = content.child;
    verifyChild(snapshot, reservation, child);
    if (content.kind === 'enroll') {
      demand(
        !reservation.child &&
          child.launch_count === 0 &&
          child.projection.attempts[0]?.status === 'pending' &&
          !child.admitted.length,
        'enrollment requires the original pending child',
      );
      state.existing_requests.push(requestReference(reservation.binding.action_request));
    } else {
      demand(reservation.child && child.revision > reservation.child.revision, 'child revision did not advance');
      if (content.kind === 'observe') demand(!child.admitted.length, 'use import for admitted child evidence');
      else {
        const correlation = content.correlation;
        const fact = child.admitted.find((item) => item.observation_id === correlation.observation_id);
        demand(
          fact && equal(workflowCorrelation(reservation, correlation.observation_id), correlation),
          'import identifies a different source or Attempt',
        );
        reservation.imported = {
          ...correlation,
          contract_version: 1,
          state: snapshot.view.state,
          state_version: snapshot.view.state_version,
          evidence_revision: snapshot.view.evidence_revision,
          execution_revision: row.revision,
          execution_digest: digest,
          source_id: fact.source_id,
          source_digest: fact.source_digest,
          admission_digest: fact.admission.admission_digest,
          child_revision: child.revision,
          claim: child.request.request.claim,
          attempt_status: child.projection.attempts[0]!.status,
        };
        if (
          child.projection.request_status === 'satisfied' &&
          !child.projection.conflicts.some((conflict) => !conflict.resolved_by)
        )
          state.active = null;
      }
    }
    reservation.child = child;
    for (const invalid of child.projection.invalidated_claims)
      if (!state.invalidated_claims.some((item) => equal(item, invalid))) state.invalidated_claims.push(invalid);
  }
  state.revision = row.revision;
  state.digest = digest;
  snapshot.view = { ...snapshot.view, execution_revision: row.revision, execution_digest: digest };
}

export class ManagedLedgerSchemaError extends StateCorruptedError {
  readonly hint =
    'Restore the control database and its matching managed child state from a verified backup. Recreating the shared journals could lose an outstanding execution or evidence collection.';
}

function requireManagedLedgers(db: DatabaseSync, installForFirstRun = false) {
  try {
    demand(workflowExecutionSchema(db, installForFirstRun), 'missing managed execution journal');
    ensureWorkflowCollectionSchema(db, installForFirstRun);
  } catch (cause) {
    if (!(cause instanceof StateCorruptedError)) throw cause;
    throw new ManagedLedgerSchemaError(
      `ThreadLoop installs the shared journals with the first managed run. ${cause.message}`,
      { cause },
    );
  }
}

export function persistInitialExecution(db: DatabaseSync, snapshot: RunSnapshot) {
  const state = snapshot.managed_execution;
  if (!state) return;
  const priorManagedRun = db
    .prepare(
      `SELECT 1 FROM workflow_runs WHERE run_id<>? AND
    CASE WHEN json_valid(genesis_json) THEN json_extract(genesis_json,'$.setup.schema_version') END='threadloop.workflow-setup/2' LIMIT 1`,
    )
    .get(snapshot.genesis.run_id);
  const isFirstManagedRun = priorManagedRun === undefined;
  requireManagedLedgers(db, isFirstManagedRun);
  db.prepare('INSERT INTO workflow_execution_heads(run_id,revision,digest,active_reservation) VALUES (?,0,?,NULL)').run(
    snapshot.genesis.run_id,
    state.digest,
  );
}

export function executionReader(db: DatabaseSync, run: string) {
  requireManagedLedgers(db);
  const iterator = db
    .prepare(
      'SELECT run_id,revision,lifecycle_ordinal,lifecycle_digest,previous,kind,request_key,marker,body,digest FROM workflow_execution_events WHERE run_id=? ORDER BY revision',
    )
    .iterate(run);
  let next = iterator.next();
  return {
    close() {
      if (!next.done) iterator.return?.();
    },
    at(journal: Journal) {
      while (!next.done && next.value.lifecycle_ordinal === journal.head.ordinal) {
        const row = next.value as unknown as ExecutionRow;
        foldExecution(db, journal, row, JSON.parse(row.body) as ExecutionContent);
        next = iterator.next();
      }
    },
    finish(journal: Journal) {
      demand(next.done, 'execution history refers to a missing lifecycle prefix');
      checkExecutionHead(db, journal.snapshot);
    },
  };
}

function checkExecutionHead(db: DatabaseSync, snapshot: RunSnapshot) {
  if (!snapshot.managed_execution) return;
  const actual = db
    .prepare('SELECT revision,digest,active_reservation FROM workflow_execution_heads WHERE run_id=?')
    .get(snapshot.genesis.run_id);
  demand(
    equal(actual, {
      revision: snapshot.managed_execution.revision,
      digest: snapshot.managed_execution.digest,
      active_reservation: snapshot.managed_execution.active?.owner.reservation_id ?? null,
    }),
    'execution head differs from its journal',
  );
}

export function appendExecution(db: DatabaseSync, journal: Journal, key: string, content: ExecutionContent) {
  const snapshot = journal.snapshot,
    state = snapshot.managed_execution!,
    lifecycleHead = journal.head;
  const active = state.active?.owner.reservation_id ?? null;
  const fields = {
    run_id: snapshot.genesis.run_id,
    revision: state.revision + 1,
    lifecycle_ordinal: lifecycleHead.ordinal,
    lifecycle_digest: lifecycleHead.digest,
    previous: state.digest,
    kind: content.kind,
    request_key: key,
    marker: content.kind === 'observe' ? null : key,
    body: canonicalJson(content),
  };
  const row = { ...fields, digest: workflowDigest(fields) };
  foldExecution(db, journal, row, content);
  db.prepare(
    'INSERT INTO workflow_execution_events(run_id,revision,lifecycle_ordinal,lifecycle_digest,previous,kind,request_key,marker,body,digest) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(
    row.run_id,
    row.revision,
    row.lifecycle_ordinal,
    row.lifecycle_digest,
    row.previous,
    row.kind,
    row.request_key,
    row.marker,
    row.body,
    row.digest,
  );
  const changed = db
    .prepare(
      `UPDATE workflow_execution_heads SET revision=?,digest=?,active_reservation=?
    WHERE run_id=? AND revision=? AND digest=? AND active_reservation IS ? AND EXISTS
    (SELECT 1 FROM workflow_heads WHERE run_id=? AND version=? AND revision=? AND ordinal=? AND digest=?)`,
    )
    .run(
      row.revision,
      row.digest,
      state.active?.owner.reservation_id ?? null,
      row.run_id,
      row.revision - 1,
      row.previous,
      active,
      row.run_id,
      lifecycleHead.version,
      lifecycleHead.revision,
      lifecycleHead.ordinal,
      lifecycleHead.digest,
    );
  demand(changed.changes === 1, 'execution or lifecycle head changed during commit');
}
