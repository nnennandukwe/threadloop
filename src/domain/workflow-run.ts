import type { ControllerDecision, ControllerInput } from 'threadloop-contracts/controller';
import type { CompiledGraph } from 'threadloop-contracts/workflow';
import type { BoundProofPlan, StoredGateReceipt } from './proof.js';
import type { PrePrReviewEvidence } from './session-transition.js';
import type { ParsedSignedReceiptPackage } from './attestation.js';
import type { ParsedSignedReviewReceiptPackage } from './review.js';
import type { VerifiedSigstoreSigner } from '../adapters/crypto/sigstore.js';
import type { observeGaapWorkspace } from '../adapters/fs/gaap-files.js';

export type Binding = ControllerInput['binding'];
export type Subject = Binding['subject'];
export type RepositorySubject = Extract<Subject, { kind: 'repository' }>;
export type Policy = ControllerInput['policy'];
export type Receipt = ControllerInput['receipts'][number];
export type Identity = Receipt['policy'];
export type History = Extract<ControllerInput['history'], { status: 'verified' }>;
export type Physical = ReturnType<typeof observeGaapWorkspace>;
export type Transition = Extract<ControllerDecision['decision'], { outcome: 'transition_available' }>;

export interface WorkflowSetup {
  schema_version: 'threadloop.workflow-setup/1';
  subject_workspace: string;
  repository_id: string;
  policy: Pick<
    Policy['rules'],
    'proof_binding_transition_id' | 'local_gate_ids' | 'independent_gate_ids' | 'publication_destination'
  > & { id: string };
  proof_plan: string | null;
  trusted_sources: string | null;
  allowed_change_paths: string[];
}
export interface WorkflowSources {
  schema_version: 'threadloop.workflow-sources/1';
  host_producers: ('local-gate' | 'pre-pr-review')[];
  github: { base_ref: string; human_node_id: string; preparation_ttl_ms: number; evidence_ttl_ms: number } | null;
}
export interface WorkflowGenesis {
  run_id: string;
  compiled: CompiledGraph;
  graph_json: string;
  setup: WorkflowSetup;
  setup_sha256: string;
  change_scope_digest: string;
  subject_root: string;
  baseline: RepositorySubject;
  baseline_manifest: Physical['manifest'];
  baseline_branch: string;
  proof_plan: BoundProofPlan | null;
  sources: WorkflowSources | null;
  source_policies: Partial<
    Record<
      'host-plan' | 'local-gate' | 'pre-pr-review' | 'signed-gate' | 'signed-review' | 'signed-instruction',
      Identity
    >
  >;
  policy: Policy;
  created_at: string;
}

export interface RunView {
  contract_version: 1;
  workflow_run_id: string;
  graph_schema_version: '0.1';
  graph_digest: string;
  policy: Identity;
  state: string;
  state_version: number;
  history_digest: string;
  evidence_revision: number;
}
export type Expectation = Omit<RunView, 'contract_version'> & {
  subject: Subject;
  evaluation_time: string;
  input_digest: string;
  decision_digest: string;
};
export interface DecisionReply {
  controller_decision: ControllerDecision;
  expectation: Expectation;
}
export interface ApplyReply {
  contract_version: 1;
  workflow_run_id: string;
  graph_digest: string;
  transition_id: string;
  from: string;
  to: string;
  previous_version: number;
  state_version: number;
  event_digest: string;
  decision_digest: string;
}
export interface PullTarget {
  number: number;
  url: string;
  base_ref: string;
}
export type Instruction =
  | { purpose: 'request_stop'; reason: string }
  | {
      purpose: 'block_run';
      transition_id: string;
      reason: string;
      stop_code: string;
      evidence_ref: string;
      recovery: string;
      request_stop: boolean;
    }
  | { purpose: 'recover_run'; transition_id: string; reason: string };
export type PrepareTarget =
  | { kind: 'signed-gate'; gate_id: string }
  | { kind: 'signed-review'; pr: number }
  | { kind: 'signed-instruction'; pr: number; instruction: Instruction };
export type SignedKind = PrepareTarget['kind'];
export interface SourceBinding {
  binding: Binding;
  branch: string;
  workflow_policy: Identity;
  evidence_policy: Identity;
}
export type SensorInputs = {
  session_id: string;
  plan_sha256: string;
  prepared_receipt_id: string;
} & ({ gate_id: string; gate_json: string } | { pull_request_number: number });
export interface Preparation extends SourceBinding {
  observation_valid_until?: string;
  prepared_id: string;
  prepared_at: string;
  valid_until: string;
  target: PrepareTarget;
  pull_request: PullTarget | null;
  manifest_json: string | null;
  sensor_inputs: SensorInputs;
}
export type EvidenceStream =
  | { kind: 'host-plan' | 'pre-pr-review' }
  | { kind: 'local-gate' | 'signed-gate'; gate_id: string }
  | { kind: 'signed-review'; pr: number }
  | { kind: 'signed-instruction'; pr: number; version: number; purpose: Instruction['purpose'] };
export interface AdmittedObservation extends SourceBinding {
  source_id: string;
  stream: EvidenceStream;
  measured_at: string;
  valid_until: string | null;
  applicable_version: number | null;
  authorized_edge: string | null;
  receipts: Receipt[];
}
export interface RunSnapshot {
  genesis: WorkflowGenesis;
  view: RunView;
  history: History;
  last_subject: Subject;
  implementation_manifest: Physical['manifest'] | null;
  product_pr: PullTarget | null;
  observations: readonly AdmittedObservation[];
}
export interface PhysicalObservation {
  subject: Subject;
  facts: ControllerInput['observation'];
  physical: Physical | null;
  origin: string | null;
}
export interface AppliedTransition {
  selected: Transition;
  fresh_decision_digest: string;
  observed: PhysicalObservation;
  next_history: Omit<History, 'digest'>;
  implementation_manifest: Physical['manifest'] | null;
}

export type RawSource = { bytes: Uint8Array; sha256: string };
export type GitObject = { oid: string; kind: 'commit' | 'tree' | 'blob'; bytes: Uint8Array };
export type SignedSource = { raw: RawSource; signer: VerifiedSigstoreSigner } & (
  | { kind: 'signed-gate'; parsed: ParsedSignedReceiptPackage }
  | { kind: 'signed-review'; parsed: ParsedSignedReviewReceiptPackage }
  | { kind: 'signed-instruction'; parsed: ParsedSignedReviewReceiptPackage; objects: readonly GitObject[] }
);
export type HostSource =
  | {
      kind: 'local-gate';
      producing: SourceBinding;
      producer_id: Identity;
      receipt: StoredGateReceipt;
      artifact: RawSource;
      outputs: readonly { path: string; content: RawSource }[];
    }
  | {
      kind: 'pre-pr-review';
      producing: SourceBinding;
      producer_id: Identity;
      reviewer_id: string;
      observed_at: string;
      review: PrePrReviewEvidence;
      artifact: RawSource;
      findings: Extract<Receipt['payload'], { type: 'pre_pr_review' }>['findings'];
    };
export type VerifiedSource = SignedSource | HostSource;
export type Batch = Omit<AdmittedObservation, 'source_id' | 'receipts'> & { payloads: Receipt['payload'][] };
export interface AdmissionReply {
  contract_version: 1;
  workflow_run_id: string;
  state: string;
  state_version: number;
  admission_id: string;
  raw_source_sha256: string;
  canonical_source_sha256: string;
  receipt_ids: string[];
  evidence_revision: number;
}
export type AdmissionLookup =
  { kind: 'replay'; result: AdmissionReply } | { kind: 'verify'; genesis: WorkflowGenesis; prepared: Preparation };
export interface WorkflowStore {
  read(run: string): RunSnapshot;
  create(run: string, requestJson: string, build: (now: string) => WorkflowGenesis): RunView;
  prepare(
    run: string,
    key: string,
    version: number,
    target: PrepareTarget,
    build: (snapshot: RunSnapshot, id: string, now: string) => Preparation,
  ): Preparation;
  lookupSigned(run: string, kind: SignedKind, raw: RawSource, preparedId: string): AdmissionLookup;
  admit(
    run: string,
    version: number,
    verified: VerifiedSource,
    check: (snapshot: RunSnapshot, prepared: Preparation | null, now: string) => Batch,
  ): AdmissionReply;
  apply(
    run: string,
    key: string,
    proposal: DecisionReply,
    check: (snapshot: RunSnapshot, now: string) => AppliedTransition,
  ): ApplyReply;
}
