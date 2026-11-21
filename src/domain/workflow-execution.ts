import type { ControllerInput } from 'threadloop-contracts/controller';
import type { ManagedGaapInspection } from '../services/gaap-executor.js';
import type { GaapBinding } from './gaap-binding.js';
import type { DecisionReply, PhysicalObservation, RunSnapshot } from './workflow-run.js';

export interface WorkflowCorrelation {
  workflow_run_id: string;
  request_key: string;
  request_digest: string;
  executor_request_digest: string | null;
  attempt_id: string | null;
  observation_id: number | null;
}
export interface WorkflowExecutionImport extends WorkflowCorrelation {
  contract_version: 1;
  state: string;
  state_version: number;
  evidence_revision: number;
  execution_revision: number;
  execution_digest: string;
  source_id: string;
  source_digest: string;
  admission_digest: string;
  child_revision: number;
  claim: ManagedGaapInspection['request']['request']['claim'];
  attempt_status: ManagedGaapInspection['projection']['attempts'][number]['status'];
}
export interface WorkflowReservation {
  owner: { workflow_run_id: string; reservation_id: string; request_digest: string };
  request_key: string;
  child_directory: string;
  reserved_at: string;
  proposal: DecisionReply;
  observed: PhysicalObservation;
  binding: GaapBinding;
  child: ManagedGaapInspection | null;
  imported: WorkflowExecutionImport | null;
}
export interface ManagedExecutionState {
  revision: number;
  digest: string;
  existing_requests: ControllerInput['existing_requests'];
  invalidated_claims: ControllerInput['invalidated_claims'];
  active: WorkflowReservation | null;
  reservations: WorkflowReservation[];
}
export type WorkflowExecutionGuard = (snapshot: RunSnapshot, reservation: WorkflowReservation, now: string) => void;
export interface WorkflowExecutionStore {
  reserveExecution(
    run: string,
    proposal: DecisionReply,
    check: (snapshot: RunSnapshot, now: string) => { observed: PhysicalObservation; binding: GaapBinding },
  ): WorkflowReservation;
  enrollExecution(
    run: string,
    reservationId: string,
    child: ManagedGaapInspection,
    guard: WorkflowExecutionGuard,
  ): WorkflowReservation;
  observeExecution(run: string, reservationId: string, child: ManagedGaapInspection): WorkflowReservation;
  withExecutionFence<T>(
    run: string,
    reservationId: string,
    phase: 'register' | 'start' | 'admit',
    guard: WorkflowExecutionGuard,
    commit: () => T,
  ): T;
  importExecution(
    run: string,
    version: number,
    correlation: WorkflowCorrelation,
    child: ManagedGaapInspection,
  ): WorkflowExecutionImport;
}

export function workflowCorrelation(
  reservation: WorkflowReservation,
  observationId: number | null = null,
): WorkflowCorrelation {
  return {
    workflow_run_id: reservation.owner.workflow_run_id,
    request_key: reservation.request_key,
    request_digest: reservation.owner.request_digest,
    executor_request_digest: reservation.child?.request.request_digest ?? null,
    attempt_id: reservation.child?.request.request.attempt_id ?? null,
    observation_id: observationId,
  };
}
