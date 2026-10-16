import type { GaapEvent, GaapReceipt, GaapRequest } from 'threadloop-contracts/executor';

type Identity = GaapRequest['requested_capability'];
type Subject = GaapRequest['subject'];
type DecisionEvent = Extract<GaapEvent, { event_type: 'protected_effect_decision' }>;

export interface GaapEvidenceReference {
  evidence_type: string;
  digest: string;
  locator: string | null;
}
export interface GaapEffectRequest {
  schema_version: string;
  effect_id: string;
  effect_sequence: number;
  run_id: string;
  agent_run_request_digest: string;
  subject: Subject;
  capability: Identity;
  tool_schema_digest: string | null;
  input_digest: string;
  input_metadata: Array<{ name: string; value: string }>;
  normalized_operation: string;
  operation_family: string;
  repeatability: string;
  requested_scopes: Array<Record<string, unknown>>;
  policies: GaapRequest['policies'];
  approval_context: GaapRequest['approval_context'];
  resource_budget_digest: string;
  expected_effect_class: 'observation' | 'mutation';
  sandbox_profile: Identity;
  idempotency_key: string;
}
export interface GaapEffectBody {
  schema_version: string;
  effect_id: string;
  effect_sequence: number;
  run_id: string;
  agent_run_request_digest: string;
  effect_request_digest: string;
  decision: {
    decision_id: string;
    effect_request_digest: string;
    gate: DecisionEvent['gate'];
    subject_digest: string;
    decision: DecisionEvent['decision'];
  };
  execution_status: 'executed' | 'failed' | 'interrupted' | 'unknown_outcome' | 'denied' | 'awaiting_authority';
  executor: Identity | null;
  sandbox_profile: Identity | null;
  exit: { exit_type: 'code'; code: number } | { exit_type: 'signal'; signal: string } | null;
  observed_pre_effect_subject: Subject;
  observed_post_effect_subject: Subject | null;
  observed_capability: Identity;
  observed_tool_schema_digest: string | null;
  evidence: GaapEvidenceReference[];
  usage: GaapReceipt['body']['usage'];
  reason: string | null;
}
export interface GaapEffect {
  request: GaapEffectRequest;
  result: { body: GaapEffectBody; result_digest: string };
}
export interface GaapStatement {
  _type: string;
  subject: Array<{ name: string; digest: Record<string, string> }>;
  predicateType: string;
  predicate: {
    implementation: Identity;
    contract_versions: string[];
    request: GaapRequest;
    receipt: GaapReceipt;
    effects: GaapEffect[];
    observed_subject: Subject;
    snapshot_profile: string;
    snapshot_digests: string[];
    blob_digests: string[];
  };
}
