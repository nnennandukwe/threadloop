import type { Evidence, ExecutorRequest, ExecutorResult } from './contracts.js';

// Type projections of the pinned upstream JSON schemas, not a shared runtime dependency.
type Parameters = ExecutorRequest['request']['parameters'];
export interface GaapRequest {
  schema_version: 'gaap.agent-run-request/0.1.0';
  request_id: string;
  run_id: string;
  subject: { kind: 'repository' | 'artifact'; locator: string; digest: string };
  requested_capability: Parameters['capability'];
  task: Parameters['task'];
  policies: Parameters['policies'];
  resource_budget: Parameters['resource_budget'];
  approval_context: Parameters['approval_context'];
  required_verification: Parameters['required_verification'];
}
type Status =
  | 'accepted'
  | 'planning'
  | 'awaiting_authority'
  | 'executing'
  | 'verifying'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'interrupted';
type Usage = ExecutorResult['result']['usage'];
export type GaapEvent = { sequence: number } & (
  | { event_type: 'status_transition'; from: Status; to: Status; reason: string | null }
  | { event_type: 'plan_recorded'; plan_digest: string }
  | { event_type: 'approval_recorded'; approval: Parameters['approval_context'][number] }
  | {
      event_type: 'protected_effect_decision';
      decision_id: string;
      gate: string;
      protected_effect_digest: string;
      subject_digest: string;
      decision: { outcome: 'allow' | 'ask' | 'block'; code: string; effects: string[] };
    }
  | {
      event_type: 'tool_execution';
      decision_id: string;
      protected_effect_digest: string;
      action_digest: string;
      capability_digest: string;
      evidence: Evidence[];
    }
  | {
      event_type: 'mutation';
      decision_id: string;
      protected_effect_digest: string;
      before_subject_digest: string;
      after_subject_digest: string;
      evidence: Evidence[];
    }
  | {
      event_type: 'verification';
      subject_digest: string;
      implementer_id: string;
      verifier_id: string;
      verdict: 'PASS' | 'FAIL';
      evidence: Evidence[];
    }
  | { event_type: 'usage'; usage: Usage }
  | { event_type: 'interruption'; actor_id: string | null; reason: string; evidence: Evidence }
);
export interface GaapReceipt {
  receipt_digest: string;
  body: {
    schema_version: 'gaap.terminal-run-receipt/0.1.0';
    request_id: string;
    run_id: string;
    request_digest: string;
    initial_subject_digest: string;
    resulting_subject_digest: string;
    terminal_status: Status;
    terminal_reason: string;
    usage: Usage;
    events: GaapEvent[];
  };
}
