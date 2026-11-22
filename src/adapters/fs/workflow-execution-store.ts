import { randomBytes } from 'node:crypto';
import { ThreadloopError } from '../../contracts/errors.js';
import {
  workflowCorrelation,
  type WorkflowExecutionStore,
  type WorkflowReservation,
} from '../../domain/workflow-execution.js';
import { selectWorkflowDecision } from '../../domain/workflow-controller.js';
import type { ManagedGaapInspection } from '../../services/gaap-executor.js';
import { workflowControllerInput } from '../../services/workflow-evaluation.js';
import type { DatabaseSync } from './sqlite-driver.js';
import { appendExecution, childDirectory, verifyChild } from './workflow-execution-journal.js';
import type { Journal } from './workflow-journal.js';
import { conflict, equal, expectVersion } from './workflow-storage-checks.js';

function rejected(reason: string, message: string): never {
  throw new ThreadloopError('EXECUTOR_REJECTED', message, {
    details: { reason, hint: 'Inspect this Workflow Run and its retained execution before retrying.' },
  });
}

function managed(journal: Journal) {
  const state = journal.snapshot.managed_execution;
  if (!state)
    throw new ThreadloopError(
      'WORKFLOW_RUNTIME_UNSUPPORTED',
      'This Workflow Run requires a setup with managed execution.',
      {
        details: {
          reason: 'managed_execution_unavailable',
          hint: 'Create a new Workflow Run with a version 2 setup and its enrolled adapter.',
        },
      },
    );
  return state;
}

function current(journal: Journal, id: string) {
  const state = managed(journal),
    reservation = state.active;
  if (!reservation || reservation.owner.reservation_id !== id || reservation.imported)
    rejected('reservation_inactive', 'The named reservation has no outstanding operation.');
  return reservation;
}

function inAuthority(
  journal: Journal,
  reservationId: string,
  guard: Parameters<WorkflowExecutionStore['enrollExecution']>[3],
  now: () => string,
) {
  const reservation = current(journal, reservationId),
    runView = journal.snapshot.view,
    reservedExpectation = reservation.proposal.expectation;
  if (
    runView.state_version !== reservedExpectation.state_version ||
    runView.history_digest !== reservedExpectation.history_digest ||
    runView.evidence_revision !== reservedExpectation.evidence_revision
  )
    rejected('execution_authority_changed', 'The run or evidence changed since the action was reserved.');
  syncResult(guard(structuredClone(journal.snapshot), structuredClone(reservation), now()));
  const evaluatedAt = now();
  const { execution, existing_requests, invalidated_claims } = reservation.binding.snapshot;
  const input = workflowControllerInput(journal.snapshot, reservation.observed, evaluatedAt, {
    execution,
    existing_requests,
    invalidated_claims,
  });
  const decision = selectWorkflowDecision(input);
  const leaseDeadline = reservation.child?.projection.claims[0]?.valid_until;
  if (
    evaluatedAt < reservation.reserved_at ||
    (leaseDeadline && evaluatedAt >= leaseDeadline) ||
    !decision.ok ||
    decision.value.decision.outcome !== 'engineering_action_required' ||
    !equal(decision.value.decision.action_request, reservation.binding.action_request)
  )
    rejected('execution_authority_changed', 'The selected request or its lease expired before the child write.');
  return reservation;
}

function verifiedEarlierChild(
  journal: Journal,
  reservation: WorkflowReservation,
  earlier: ManagedGaapInspection,
): boolean {
  if (!reservation.child || earlier.revision >= reservation.child.revision) return false;
  verifyChild(journal.snapshot, { ...reservation, child: null }, earlier);
  verifyChild(journal.snapshot, { ...reservation, child: earlier }, reservation.child);
  return true;
}

function syncResult<T>(value: T): T {
  if (value && (typeof value === 'object' || typeof value === 'function') && 'then' in value)
    throw new ThreadloopError('INVALID_ARGUMENT', 'An execution transaction requires a synchronous callback.');
  return value;
}

export function workflowExecutionOperations(
  now: () => string,
  write: <T>(action: (db: DatabaseSync) => T) => T,
  readRun: (db: DatabaseSync, run: string) => Journal,
): WorkflowExecutionStore {
  return {
    reserveExecution(run, proposal, check) {
      return write((db) => {
        const journal = readRun(db, run),
          state = managed(journal);
        const selected = proposal.controller_decision.decision;
        if (selected.outcome !== 'engineering_action_required')
          rejected('engineering_action_unavailable', 'The decision must select an engineering action.');
        const request = selected.action_request,
          key = request.request.idempotency_key;
        const replay = state.reservations.find((reservation) => reservation.request_key === key);
        if (replay) {
          if (!equal(replay.proposal, proposal)) conflict('The selected request key already has a different decision.');
          return replay;
        }
        if (state.active) rejected('execution_outstanding', 'A previous execution still holds this run.');
        expectVersion(journal.snapshot.view.state_version, proposal.expectation.state_version);
        if (
          state.revision !== proposal.expectation.execution_revision ||
          state.digest !== proposal.expectation.execution_digest ||
          journal.head.revision !== proposal.expectation.evidence_revision
        )
          rejected('stale_decision', 'The execution or evidence changed since selection.');
        const at = now();
        const { observed, binding } = syncResult(check(structuredClone(journal.snapshot), at));
        const id = randomBytes(16).toString('hex');
        appendExecution(db, journal, key, {
          kind: 'reserve',
          reservation: {
            owner: { workflow_run_id: run, reservation_id: id, request_digest: request.request_digest },
            request_key: key,
            child_directory: childDirectory(db, id),
            reserved_at: at,
            proposal,
            observed,
            binding,
          },
        });
        return state.reservations.at(-1)!;
      });
    },
    enrollExecution(run, id, child, guard) {
      return write((db) => {
        const journal = readRun(db, run),
          state = managed(journal);
        const existing = state.reservations.find((reservation) => reservation.owner.reservation_id === id);
        if (existing?.child) {
          if (
            !equal(existing.owner, child.owner) ||
            !equal(existing.child.request, child.request) ||
            existing.child.host_digest !== child.host_digest ||
            existing.child.binding_digest !== child.binding_digest
          )
            conflict('The reservation already enrolled a different child.');
          if (child.revision === existing.child.revision && !equal(child, existing.child))
            conflict('The enrolled child revision already has different content.');
          if (!verifiedEarlierChild(journal, existing, child)) verifyChild(journal.snapshot, existing, child);
          return existing;
        }
        const reservation = inAuthority(journal, id, guard, now);
        appendExecution(db, journal, reservation.request_key, { kind: 'enroll', child });
        return reservation;
      });
    },
    observeExecution(run, id, child) {
      return write((db) => {
        const journal = readRun(db, run),
          reservation = current(journal, id);
        if (!reservation.child) rejected('child_not_enrolled', 'Enroll the child before reading transport progress.');
        if (equal(reservation.child, child) || verifiedEarlierChild(journal, reservation, child)) return reservation;
        appendExecution(db, journal, reservation.request_key, { kind: 'observe', child });
        return reservation;
      });
    },
    withClaimExpiryFence(run, expectedVersion, attemptId, child, record) {
      return write((db) => {
        const journal = readRun(db, run);
        expectVersion(journal.snapshot.view.state_version, expectedVersion);
        const reservation = current(journal, child.owner.reservation_id);
        if (!reservation.child || reservation.child.request.request.attempt_id !== attemptId)
          rejected('attempt_mismatch', 'The enrolled Attempt differs from the requested expiry.');
        verifyChild(journal.snapshot, reservation, child);
        return syncResult(record(journal.snapshot, now()));
      });
    },
    withExecutionFence(run, id, phase, guard, commit) {
      return write((db) => {
        const journal = readRun(db, run),
          reservation = inAuthority(journal, id, guard, now);
        if (
          phase === 'register'
            ? reservation.child !== null
            : !reservation.child ||
              (phase === 'start' &&
                (reservation.child.launch_count !== 0 ||
                  reservation.child.projection.attempts[0]?.status !== 'pending'))
        )
          rejected('child_phase_mismatch', 'This execution phase differs from the enrolled child state.');
        return syncResult(commit());
      });
    },
    importExecution(run, version, correlation, child) {
      return write((db) => {
        const journal = readRun(db, run),
          state = managed(journal);
        const reservation = state.reservations.find((candidate) => candidate.request_key === correlation.request_key);
        if (!reservation?.child || !equal(workflowCorrelation(reservation, correlation.observation_id), correlation))
          rejected('correlation_conflict', 'The named child or Attempt differs from this run.');
        if (reservation.imported) {
          verifyChild(journal.snapshot, reservation, child);
          const fact = child.admitted.find((admission) => admission.observation_id === correlation.observation_id);
          if (
            !fact ||
            reservation.imported.observation_id !== correlation.observation_id ||
            fact.admission.admission_digest !== reservation.imported.admission_digest ||
            fact.source_digest !== reservation.imported.source_digest
          )
            conflict('The imported evidence identity already has different content.');
          return reservation.imported;
        }
        expectVersion(journal.snapshot.view.state_version, version);
        if (
          state.active !== reservation ||
          !child.admitted.some((admission) => admission.observation_id === correlation.observation_id)
        )
          rejected('admission_unavailable', 'The child has no matching admitted observation.');
        appendExecution(db, journal, reservation.request_key, { kind: 'import', child, correlation });
        return reservation.imported!;
      });
    },
  };
}
