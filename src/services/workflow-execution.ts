import { verifyChild } from '../adapters/fs/workflow-execution-journal.js';
import { guardWorkflowCollections } from '../adapters/fs/workflow-collection-store.js';
import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readGaapFile, requireGaapDirectory } from '../adapters/fs/gaap-files.js';
import { GaapState } from '../adapters/fs/gaap-state.js';
import { ThreadloopError } from '../contracts/errors.js';
import { canonicalJson } from '../domain/canonical-json.js';
import { parseGaapJson, GaapEvidenceError } from '../domain/gaap-json.js';
import { selectWorkflowDecision } from '../domain/workflow-controller.js';
import {
  workflowCorrelation,
  type WorkflowCorrelation,
  type WorkflowReservation,
  type WorkflowExecutionImport,
} from '../domain/workflow-execution.js';
import { createWorkflowStore } from '../adapters/fs/workflow-store.js';
import type { DecisionReply, RunSnapshot } from '../domain/workflow-run.js';
import { workflowDigest } from '../domain/workflow-selection-types.js';
import {
  admitManagedGaapOutput,
  expireManagedGaapClaim,
  inspectManagedGaapExecutor,
  registerManagedGaapExecutor,
  runManagedGaapExecutor,
  type ManagedGaapInspection,
} from './gaap-executor.js';
import { assertWorkflowGaapExecutable } from './workflow-gaap-adapter.js';
import {
  decideWorkflow,
  observeWorkflow,
  workflowControllerInput,
  workflowGaapBinding,
} from './workflow-evaluation.js';
import { readWorkflowDecision, workflowStoreFor } from './workflow-access.js';

type WorkflowStore = ReturnType<typeof createWorkflowStore>;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const correlationSchema = z.strictObject({
  workflow_run_id: z.string().min(1),
  request_key: z.string().min(1),
  request_digest: digest,
  executor_request_digest: digest,
  attempt_id: z.string().min(1),
  observation_id: z.number().int().positive().nullable(),
});

function refused(
  reason: string,
  message: string,
  run: string,
  correlation?: WorkflowCorrelation,
  childFailure?: { phase: 'start' | 'transport' | 'admission'; child_reason: string },
): never {
  throw new ThreadloopError('EXECUTOR_REJECTED', message, {
    details: {
      reason,
      ...(correlation ? { correlation } : {}),
      ...childFailure,
      hint: 'Run threadloop workflow inspect ' + run + ' to check the retained request and its recovery operation.',
    },
  });
}

function reserve(snapshot: RunSnapshot, proposal: DecisionReply, now: string) {
  const run = snapshot.view.workflow_run_id;
  if (!snapshot.genesis.gaap) refused('executor_unavailable', 'This run has no enrolled executor.', run);
  const at = proposal.expectation.evaluation_time;
  const observed = observeWorkflow(snapshot);
  if (at > now || canonicalJson(decideWorkflow(snapshot, observed, at)) !== canonicalJson(proposal))
    refused('stale_decision', 'The saved decision differs from the current run, evidence or subject.', run);
  const previous = proposal.controller_decision.decision;
  const input = workflowControllerInput(snapshot, observed, now);
  const fresh = selectWorkflowDecision(input);
  if (
    previous.outcome !== 'engineering_action_required' ||
    !fresh.ok ||
    fresh.value.decision.outcome !== 'engineering_action_required' ||
    canonicalJson(fresh.value.decision.action_request) !== canonicalJson(previous.action_request)
  )
    refused('engineering_action_unavailable', 'The current run must select the same engineering action.', run);
  assertWorkflowGaapExecutable(snapshot.genesis);
  return { observed, binding: workflowGaapBinding(snapshot, input, previous.action_request) };
}

function checkAuthority(snapshot: RunSnapshot, reservation: WorkflowReservation, now: string, admitting: boolean) {
  const run = snapshot.view.workflow_run_id;
  const { binding, observed, proposal } = reservation;
  const current = observeWorkflow(snapshot);
  if (
    current.facts.status !== 'verified' ||
    current.subject.kind !== 'repository' ||
    observed.subject.kind !== 'repository' ||
    !current.physical ||
    !observed.physical ||
    current.subject.repository_id !== observed.subject.repository_id ||
    current.subject.revision !== observed.subject.revision ||
    current.physical.branch !== observed.physical.branch ||
    current.origin !== observed.origin ||
    (!admitting && canonicalJson(current.facts) !== canonicalJson(observed.facts)) ||
    snapshot.view.history_digest !== proposal.expectation.history_digest ||
    snapshot.view.evidence_revision !== proposal.expectation.evidence_revision
  )
    refused('execution_authority_changed', 'The run, evidence or bound workspace changed since reservation.', run);
  const input = workflowControllerInput(snapshot, admitting ? observed : current, now, {
    execution: binding.snapshot.execution,
    existing_requests: binding.snapshot.existing_requests,
    invalidated_claims: binding.snapshot.invalidated_claims,
  });
  const result = selectWorkflowDecision(input);
  if (
    !result.ok ||
    result.value.decision.outcome !== 'engineering_action_required' ||
    canonicalJson(result.value.decision.action_request) !== canonicalJson(binding.action_request)
  )
    refused('execution_authority_changed', 'The current authority no longer selects the reserved request.', run);
  if (!admitting) assertWorkflowGaapExecutable(snapshot.genesis);
}

function checkedChild(reservation: WorkflowReservation, hostDigest: string, child: ManagedGaapInspection) {
  if (
    child.binding_digest !== workflowDigest(reservation.binding) ||
    child.host_digest !== hostDigest ||
    canonicalJson(child.request.request.action_request) !== canonicalJson(reservation.binding.action_request)
  )
    refused(
      'child_binding_conflict',
      'The child belongs to a different registration.',
      reservation.owner.workflow_run_id,
    );
  return child;
}

type ManagedPhase = 'register' | 'start' | 'admit';
function childFence(store: WorkflowStore, reservation: WorkflowReservation) {
  return <T>(phase: ManagedPhase, commit: () => T) =>
    store.withExecutionFence(
      reservation.owner.workflow_run_id,
      reservation.owner.reservation_id,
      phase,
      (snapshot, current, now) => checkAuthority(snapshot, current, now, phase === 'admit'),
      commit,
    );
}

function importedReply(result: WorkflowExecutionImport) {
  const { workflow_run_id, request_key, request_digest, executor_request_digest, attempt_id, observation_id } = result;
  return {
    ...result,
    disposition: 'imported' as const,
    correlation: { workflow_run_id, request_key, request_digest, executor_request_digest, attempt_id, observation_id },
  };
}

async function childFact(reservation: WorkflowReservation, store: GaapState, hostDigest: string) {
  const child = await inspectManagedGaapExecutor(store, reservation.owner);
  return checkedChild(reservation, hostDigest, child);
}

async function reconcile(
  store: WorkflowStore,
  reservation: WorkflowReservation,
  expectedVersion: number,
  hostDigest: string,
  correlation: WorkflowCorrelation,
  allowAdmission: boolean,
  admissionFailure?: string,
) {
  const run = reservation.owner.workflow_run_id;
  if (reservation.imported) {
    const previous = importedReply(reservation.imported);
    if (
      canonicalJson(previous.correlation) !==
      canonicalJson({ ...correlation, observation_id: correlation.observation_id ?? previous.observation_id })
    )
      refused('correlation_conflict', 'The named child or observation differs from the imported receipt.', run);
    return previous;
  }
  const state = new GaapState(reservation.child_directory);
  let child = await childFact(reservation, state, hostDigest);
  const local = workflowCorrelation(reservation, correlation.observation_id);
  if (canonicalJson(local) !== canonicalJson(correlation))
    refused('correlation_conflict', 'The supplied correlation differs from the retained request.', run);
  const observation =
    correlation.observation_id === null
      ? child.observations.at(-1)
      : child.observations.find((o) => o.id === correlation.observation_id);
  if (correlation.observation_id !== null && !observation)
    refused('unknown_observation', 'The child has no matching observation.', run);
  if (observation && observation.status === 'ok' && !child.admitted.length && allowAdmission) {
    await admitManagedGaapOutput(state, reservation.owner, observation.id, childFence(store, reservation));
    child = await childFact(reservation, state, hostDigest);
  }
  const admitted = child.admitted.find((f) => f.observation_id === observation?.id);
  if (!admitted) {
    store.observeExecution(run, reservation.owner.reservation_id, child);
    refused(
      'execution_outstanding',
      'The child has no verified admission. Inspect the retained Attempt before recovery.',
      run,
      workflowCorrelation(reservation, observation?.id),
      !observation
        ? { phase: 'start', child_reason: 'no_observation' }
        : observation.status !== 'ok'
          ? { phase: 'transport', child_reason: observation.status }
          : { phase: 'admission', child_reason: admissionFailure ?? 'admission_unverified' },
    );
  }
  return importedReply(
    store.importExecution(run, expectedVersion, workflowCorrelation(reservation, admitted.observation_id), child),
  );
}

async function reportChildError<T>(run: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GaapEvidenceError) refused(error.code, error.message, run);
    if (error instanceof Error && 'code' in error && ['ENOENT', 'ELOOP', 'ENOTDIR'].includes(String(error.code)))
      refused(
        'child_unavailable',
        'The enrolled child is missing or unreadable. Restore its original state before reconciliation.',
        run,
      );
    throw error;
  }
}

export async function executeWorkflowRun(cwd: string, run: string, filename: string, signal?: AbortSignal) {
  const { root, store } = await workflowStoreFor(cwd, run);
  const proposal = readWorkflowDecision(path.resolve(cwd, filename), run);
  const handed = proposal.controller_decision.decision;
  if (handed.outcome === 'human_action_required') {
    const snapshot = store.read(run);
    const now = new Date().toISOString();
    const observed = observeWorkflow(snapshot);
    const fresh = decideWorkflow(snapshot, observed, now).controller_decision.decision;
    if (
      proposal.expectation.evaluation_time > now ||
      canonicalJson(decideWorkflow(snapshot, observed, proposal.expectation.evaluation_time)) !==
        canonicalJson(proposal) ||
      fresh.outcome !== 'human_action_required' ||
      canonicalJson(handed.action_request) !== canonicalJson(fresh.action_request)
    )
      refused('stale_decision', 'This human handoff is stale.', run);
    return {
      disposition: 'human_handoff' as const,
      workflow_run_id: run,
      state_version: snapshot.view.state_version,
      action_request: fresh.action_request,
    };
  }
  if (handed.outcome !== 'engineering_action_required')
    refused('engineering_action_unavailable', 'Only a selected engineering request can launch.', run);
  let reservation = store.reserveExecution(run, proposal, (snapshot, now) => {
    guardWorkflowCollections(root, run);
    return reserve(snapshot, proposal, now);
  });
  if (reservation.imported) return importedReply(reservation.imported);
  const enrollment = store.read(run).genesis.gaap;
  if (!enrollment) refused('executor_unavailable', 'This run has no enrolled executor.', run);
  return reportChildError(run, async () => {
    const state = new GaapState(reservation.child_directory);
    if (!reservation.child) {
      childFence(store, reservation)('register', () => {
        const parent = path.dirname(state.directory);
        requireGaapDirectory(parent);
        const directory = lstatSync(parent);
        if (directory.uid !== process.getuid?.() || (directory.mode & 0o022) !== 0)
          refused('child_directory', 'The execution directory must be owned by the host.', run);
        if (!existsSync(path.join(state.directory, 'executor.sqlite'))) {
          if (lstatSync(state.directory, { throwIfNoEntry: false }))
            refused(
              'child_collision',
              'The reserved path is occupied. Preserve the directory and inspect the collision.',
              run,
            );
          registerManagedGaapExecutor(state, reservation.owner, reservation.binding, enrollment.host);
        }
      });
      const pending = await childFact(reservation, state, enrollment.host_digest);
      reservation = store.enrollExecution(run, reservation.owner.reservation_id, pending, (snapshot, current, now) =>
        checkAuthority(snapshot, current, now, false),
      );
    }
    let child = await childFact(reservation, state, enrollment.host_digest);
    let admissionFailure: string | undefined;
    if (!child.launch_count && child.projection.attempts.at(-1)?.status === 'pending') {
      const attempted = await runManagedGaapExecutor(state, reservation.owner, childFence(store, reservation), signal);
      if ('reason_code' in attempted && typeof attempted.reason_code === 'string')
        admissionFailure = attempted.reason_code;
      child = await childFact(reservation, state, enrollment.host_digest);
    }
    return reconcile(
      store,
      reservation,
      proposal.expectation.state_version,
      enrollment.host_digest,
      workflowCorrelation(reservation, child.observations.at(-1)?.id),
      false,
      admissionFailure,
    );
  });
}

export async function importWorkflowGaap(cwd: string, run: string, filename: string, version: number) {
  const parsed = correlationSchema.safeParse(parseGaapJson(readGaapFile(path.resolve(cwd, filename), 64 * 1024)));
  if (!parsed.success || parsed.data.workflow_run_id !== run)
    refused('invalid_correlation', 'Supply the correlation for this run.', run);
  const { store } = await workflowStoreFor(cwd, run);
  const snapshot = store.read(run);
  const reservation = snapshot.managed_execution?.reservations.find(
    (r) => r.request_key === parsed.data.request_key && r.owner.request_digest === parsed.data.request_digest,
  );
  if (!reservation?.child || !snapshot.genesis.gaap)
    refused('unknown_reservation', 'No enrolled child matches this correlation.', run);
  const digest = snapshot.genesis.gaap.host_digest;
  if (!reservation.imported && snapshot.view.state_version !== version)
    refused('stale_version', 'The expected lifecycle version has changed.', run);
  return reportChildError(run, () => reconcile(store, reservation, version, digest, parsed.data, true));
}

function expiredClaimRecovery(reservation: WorkflowReservation, child: ManagedGaapInspection) {
  const attempt = child.projection.attempts[0]!;
  const { max_attempts, retry_safety } = reservation.binding.execution_policy.rules;
  let recovery: string;
  if (attempt.started_at !== null) {
    recovery =
      'Preserve the output and obtain independent evidence that this executor stopped. A current human authority can abandon the Attempt with stop evidence or confirm whether the effect occurred with corroborating evidence.';
  } else if (child.projection.attempts.length >= max_attempts) {
    recovery =
      'This Attempt never started. Its request has exhausted its Attempt budget. Inspect the retained claim and seek a policy decision for the interrupted work.';
  } else {
    recovery =
      'This Attempt never started. Inspect its remaining Attempt budget and seek a separately authorized replacement under the bound ' +
      retry_safety +
      ' policy. This bridge retains one Attempt per request.';
  }
  return {
    attempts_used: child.projection.attempts.length,
    attempts_remaining: max_attempts - child.projection.attempts.length,
    max_attempts,
    retry_safety,
    recovery,
    recovery_argv: ['threadloop', 'executor', 'inspect', '--state', reservation.child_directory, '--json'],
  };
}

export async function expireWorkflowClaim(cwd: string, run: string, attemptId: string, expectedVersion: number) {
  const { store } = await workflowStoreFor(cwd, run);
  const snapshot = store.read(run);
  const reservation = snapshot.managed_execution?.active;
  if (!snapshot.genesis.gaap || !reservation?.child || reservation.child.request.request.attempt_id !== attemptId)
    refused('attempt_mismatch', 'Expiry requires the exact enrolled outstanding Attempt.', run);
  const hostDigest = snapshot.genesis.gaap.host_digest;
  return reportChildError(run, async () => {
    const state = new GaapState(reservation.child_directory);
    let child = await childFact(reservation, state, hostDigest);
    store.withClaimExpiryFence(run, expectedVersion, attemptId, child, (current, at) => {
      const claim = child.projection.claims[0]!;
      if (claim.status === 'expired') return;
      if (claim.status !== 'active' || child.admitted.length)
        refused('claim_closed', 'The child already closed this claim. Inspect its retained admission.', run);
      if (at < claim.valid_until) refused('claim_not_expired', 'The enrolled claim is still within its lease.', run);
      const managed = current.managed_execution!;
      const verified = { ...current, managed_execution: { ...managed, active: { ...managed.active!, child } } };
      const input = workflowControllerInput(verified, observeWorkflow(verified), at);
      expireManagedGaapClaim(state, child, input);
    });
    child = await childFact(reservation, state, hostDigest);
    const claim = child.projection.claims[0]!;
    if (claim.status !== 'expired' || !claim.closed_at)
      refused('expiry_unconfirmed', 'The child journal has no verified expiry for this claim.', run);
    store.observeExecution(run, reservation.owner.reservation_id, child);
    const attempt = child.projection.attempts[0]!;
    return {
      disposition: 'claim_expired' as const,
      workflow_run_id: run,
      state_version: expectedVersion,
      claim: attempt.claim,
      claim_status: claim.status,
      closed_at: claim.closed_at,
      attempt_id: attempt.id,
      attempt_status: attempt.status,
      effect: attempt.effect,
      launch_count: child.launch_count,
      child_journal_revision: child.projection.revision,
      ...expiredClaimRecovery(reservation, child),
    };
  });
}

export async function observeWorkflowExecution(snapshot: RunSnapshot) {
  const managed = snapshot.managed_execution;
  const reservation = managed?.active ?? managed?.reservations.at(-1);
  if (!reservation || !snapshot.genesis.gaap || !managed) return { snapshot, inspection: null };
  const state = new GaapState(reservation.child_directory);
  let child = reservation.child;
  if (child || existsSync(path.join(state.directory, 'executor.sqlite'))) {
    const hostDigest = snapshot.genesis.gaap.host_digest;
    const live = await reportChildError(snapshot.view.workflow_run_id, () => childFact(reservation, state, hostDigest));
    verifyChild(snapshot, reservation, live);
    child = live;
  }
  const effective =
    managed.active?.child && child
      ? { ...snapshot, managed_execution: { ...managed, active: { ...reservation, child } } }
      : snapshot;
  const observation = child?.observations.at(-1);
  const pending = reservation.child === null;
  const correlation = workflowCorrelation(reservation, observation?.id);
  let recovery = 'Resume workflow execute with the original decision.';
  let recoveryArgv: string[] = [
    'threadloop',
    'workflow',
    'execute',
    snapshot.view.workflow_run_id,
    '--decision',
    '<original-decision.json>',
  ];
  const claim = child?.projection.claims[0];
  const expiryRecorded = reservation.child?.projection.claims[0]?.status === 'expired';
  if (!pending && child && claim?.status === 'expired' && expiryRecorded) {
    ({ recovery, recovery_argv: recoveryArgv } = expiredClaimRecovery(reservation, child));
  } else if (
    !pending &&
    child &&
    claim &&
    (claim.status === 'expired' || (claim.status === 'active' && new Date().toISOString() >= claim.valid_until))
  ) {
    recovery = 'Record the enrolled claim expiry and inspect the resulting Attempt.';
    recoveryArgv = [
      'threadloop',
      'workflow',
      'expire-claim',
      snapshot.view.workflow_run_id,
      '--attempt',
      claim.attempt_id,
      '--expected-state-version',
      String(snapshot.view.state_version),
      '--json',
    ];
  } else if (reservation.imported && !managed.active) {
    recovery = 'Run workflow decide to evaluate the authenticated result against current outer facts.';
    recoveryArgv = ['threadloop', 'workflow', 'decide', snapshot.view.workflow_run_id, '--json'];
  } else if (!pending && (reservation.imported || (child?.launch_count && observation?.status !== 'ok'))) {
    recovery =
      'Inspect the retained child evidence and reconcile the unknown effect under the bound authority. This Attempt stays held.';
    recoveryArgv = ['threadloop', 'executor', 'inspect', '--state', reservation.child_directory, '--json'];
  } else if (!pending && (child?.admitted.length || observation?.status === 'ok')) {
    recovery = 'Save the correlation and use workflow evidence import gaap to verify the retained result.';
    recoveryArgv = [
      'threadloop',
      'workflow',
      'evidence',
      'import',
      'gaap',
      '--run',
      snapshot.view.workflow_run_id,
      '--source',
      '<correlation.json>',
      '--expected-state-version',
      String(snapshot.view.state_version),
      '--json',
    ];
  }
  return {
    snapshot: effective,
    inspection: {
      correlation,
      disposition: reservation.imported
        ? 'imported'
        : claim?.status === 'expired'
          ? 'expired'
          : pending
            ? 'reserved'
            : child?.admitted.length
              ? 'admitted'
              : child?.launch_count
                ? 'started'
                : 'enrolled',
      child_revision: child?.revision ?? null,
      claim_status: claim?.status ?? null,
      attempts_used: child?.projection.attempts.length ?? 0,
      max_attempts: reservation.binding.execution_policy.rules.max_attempts,
      attempts_remaining:
        reservation.binding.execution_policy.rules.max_attempts - (child?.projection.attempts.length ?? 0),
      retry_safety: reservation.binding.execution_policy.rules.retry_safety,
      valid_until: claim?.valid_until ?? null,
      effect: child?.projection.attempts[0]?.effect ?? null,
      claim: child?.request.request.claim ?? null,
      attempt: child?.projection.attempts.at(-1)?.status ?? null,
      launch_count: child?.launch_count ?? 0,
      observation: observation ?? null,
      source_id: child?.admitted.at(-1)?.source_id ?? null,
      recovery,
      recovery_argv: recoveryArgv,
    },
  };
}
