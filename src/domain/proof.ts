import path from 'node:path';
import { canonicalJson } from './canonical-json.js';

export const GATE_RECEIPT_RESULTS = [
  'passed',
  'failed',
  'timed_out',
  'aborted',
  'invalidated',
  'execution_error',
  'cleanup_failed',
] as const;

export type GateReceiptResult = (typeof GATE_RECEIPT_RESULTS)[number];

export interface ProofGate {
  id: string;
  command: string[];
  working_directory: string;
  timeout_ms: number;
}

export interface LegacyProofPlan {
  acceptance_criteria: string[];
  gates: ProofGate[];
}

export interface GitHubActionsTrustPolicy {
  provider: 'github-actions';
  issuer: 'https://token.actions.githubusercontent.com';
  certificate_identity: string;
  source_repository: string;
  build_signer_uri: string;
  build_signer_sha: string;
}

export interface CiProofPlan {
  contract_version: 2;
  acceptance_criteria: string[];
  ci: GitHubActionsTrustPolicy;
  gates: ProofGate[];
}

export interface ReviewProofPlan {
  contract_version: 3;
  acceptance_criteria: string[];
  ci: GitHubActionsTrustPolicy;
  review: GitHubActionsTrustPolicy;
  gates: ProofGate[];
}

export type ProofPlan = LegacyProofPlan | CiProofPlan | ReviewProofPlan;

export interface CanonicalProofPlan {
  plan: ProofPlan;
  json: string;
  sha256: string;
}

export interface BoundProofPlan extends CanonicalProofPlan {
  baselineBranch: string;
  baselineHeadSha: string;
  createdAt: string;
}

export interface GateReceiptPayload {
  id: string;
  session_id: string;
  gate_id: string;
  plan_sha256: string;
  result: GateReceiptResult;
  command: string[];
  working_directory: string;
  timeout_ms: number;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  exit_status: number | null;
  signal: string | null;
  head_before: string;
  head_after: string;
  clean_before: boolean;
  clean_after: boolean;
  artifact: {
    path: string;
    sha256: string;
  };
  sensor: {
    name: 'threadloop-local-gate';
    contract_version: 1;
  };
}

export interface StoredGateReceipt {
  sequence: number;
  id: string;
  sessionId: string;
  gateId: string;
  planSha256: string;
  headBefore: string;
  headAfter: string;
  result: GateReceiptResult;
  artifactPath: string;
  artifactSha256: string;
  receiptJson: string;
  receiptSha256: string;
  stateVersion: number;
  createdAt: string;
}

export type ProofGateEvidenceStatus = 'missing' | 'passed' | 'failed' | 'stale' | 'corrupt';
export type ProofEvidenceStatus = ProofGateEvidenceStatus;

export interface ProofGateEvidence {
  gate_id: string;
  status: ProofGateEvidenceStatus;
  receipt_id: string | null;
  sequence: number | null;
  result: GateReceiptResult | null;
}

export interface ProofEvidence {
  status: ProofEvidenceStatus;
  gates: ProofGateEvidence[];
  staleReceiptIds: string[];
  failedReceiptIds: string[];
  corruptReceiptIds: string[];
}

export type ProofDigest = (value: string) => string;

export class ProofValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'ProofValidationError';
    this.field = field;
  }
}

export function canonicalizeProofPlan(
  value: unknown,
  digest: ProofDigest,
  options: { requireCiPolicy?: boolean; requireReviewPolicy?: boolean } = {},
): CanonicalProofPlan {
  const plan = validateProofPlan(value, options);
  const json = canonicalJson(plan);
  return { plan, json, sha256: digest(json) };
}

export function validateProofPlan(
  value: unknown,
  options: { requireCiPolicy?: boolean; requireReviewPolicy?: boolean } = {},
): ProofPlan {
  const candidate = requireObject(value, 'proof_plan');
  const isVersionTwo = candidate.contract_version === 2;
  const isVersionThree = candidate.contract_version === 3;
  if (!isVersionTwo && !isVersionThree && options.requireCiPolicy) {
    throw invalid('proof_plan.contract_version', 'must be 2 or 3 for newly recorded proof plans');
  }
  if (!isVersionThree && options.requireReviewPolicy) {
    throw invalid('proof_plan.contract_version', 'must be 3 for newly recorded proof plans');
  }
  const plan = requireExactObject(
    candidate,
    'proof_plan',
    isVersionThree
      ? ['contract_version', 'acceptance_criteria', 'ci', 'review', 'gates']
      : isVersionTwo
        ? ['contract_version', 'acceptance_criteria', 'ci', 'gates']
        : ['acceptance_criteria', 'gates'],
  );
  const acceptanceCriteria = plan.acceptance_criteria;
  if (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.length === 0) {
    throw invalid('proof_plan.acceptance_criteria', 'must be a non-empty array of strings');
  }
  const normalizedCriteria = acceptanceCriteria.map((criterion, index) =>
    requireNonEmptyText(criterion, `proof_plan.acceptance_criteria[${index}]`, 4_096),
  );

  if (!Array.isArray(plan.gates) || plan.gates.length === 0) {
    throw invalid('proof_plan.gates', 'must be a non-empty array');
  }

  const gateIds = new Set<string>();
  const gates = plan.gates.map((value, index) => {
    const field = `proof_plan.gates[${index}]`;
    const gate = requireExactObject(value, field, ['id', 'command', 'working_directory', 'timeout_ms']);
    const id = requireNonEmptyText(gate.id, `${field}.id`, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      throw invalid(`${field}.id`, 'must match [A-Za-z0-9][A-Za-z0-9._-]*');
    }
    if (gateIds.has(id)) {
      throw invalid(`${field}.id`, `duplicates declared gate ${id}`);
    }
    gateIds.add(id);

    if (!Array.isArray(gate.command) || gate.command.length === 0 || gate.command.length > 128) {
      throw invalid(`${field}.command`, 'must contain 1-128 exact argv strings');
    }
    const command = gate.command.map((argument, argumentIndex) =>
      requireNonEmptyText(argument, `${field}.command[${argumentIndex}]`, 32_768),
    );

    const workingDirectory = requireNonEmptyText(gate.working_directory, `${field}.working_directory`, 4_096);
    if (workingDirectory.includes('\0') || path.isAbsolute(workingDirectory)) {
      throw invalid(`${field}.working_directory`, 'must be a repository-relative path');
    }
    const normalizedDirectory = path.normalize(workingDirectory);
    if (
      normalizedDirectory === '..' ||
      normalizedDirectory.startsWith(`..${path.sep}`) ||
      path.isAbsolute(normalizedDirectory)
    ) {
      throw invalid(`${field}.working_directory`, 'must not escape the repository');
    }

    if (
      typeof gate.timeout_ms !== 'number' ||
      !Number.isSafeInteger(gate.timeout_ms) ||
      gate.timeout_ms < 1 ||
      gate.timeout_ms > 86_400_000
    ) {
      throw invalid(`${field}.timeout_ms`, 'must be an integer from 1 through 86400000');
    }

    return {
      id,
      command,
      working_directory: workingDirectory,
      timeout_ms: gate.timeout_ms,
    };
  });

  if (!isVersionTwo && !isVersionThree) {
    return { acceptance_criteria: normalizedCriteria, gates };
  }

  if (isVersionThree) {
    return {
      contract_version: 3,
      acceptance_criteria: normalizedCriteria,
      ci: validateTrustPolicy(plan.ci, 'proof_plan.ci', 'threadloop-gate-sensor.yml'),
      review: validateTrustPolicy(plan.review, 'proof_plan.review', 'threadloop-review-sensor.yml'),
      gates,
    };
  }

  return {
    contract_version: 2,
    acceptance_criteria: normalizedCriteria,
    ci: validateTrustPolicy(plan.ci, 'proof_plan.ci', 'threadloop-gate-sensor.yml'),
    gates,
  };
}

export function hasCiTrustPolicy(plan: ProofPlan): plan is CiProofPlan | ReviewProofPlan {
  return 'contract_version' in plan && (plan.contract_version === 2 || plan.contract_version === 3);
}

export function hasReviewTrustPolicy(plan: ProofPlan): plan is ReviewProofPlan {
  return 'contract_version' in plan && plan.contract_version === 3;
}

export function evaluateProofEvidence(input: {
  sessionId: string;
  plan: BoundProofPlan;
  receipts: StoredGateReceipt[];
  currentHead: string | null;
  artifactDigests: ReadonlyMap<string, string | null>;
  digest: ProofDigest;
}): ProofEvidence {
  const latestByGate = new Map<string, StoredGateReceipt>();
  for (const receipt of [...input.receipts].sort((left, right) => left.sequence - right.sequence)) {
    latestByGate.set(receipt.gateId, receipt);
  }

  const gates = input.plan.plan.gates.map((gate): ProofGateEvidence => {
    const receipt = latestByGate.get(gate.id);
    if (!receipt) {
      return { gate_id: gate.id, status: 'missing', receipt_id: null, sequence: null, result: null };
    }
    const common = {
      gate_id: gate.id,
      receipt_id: receipt.id,
      sequence: receipt.sequence,
      result: receipt.result,
    };
    const payload = parseAndValidateReceipt(
      receipt,
      input.sessionId,
      gate,
      input.artifactDigests.get(receipt.id),
      input.digest,
    );
    if (!payload) {
      return { ...common, status: 'corrupt' };
    }
    if (
      receipt.planSha256 !== input.plan.sha256 ||
      payload.plan_sha256 !== input.plan.sha256 ||
      !input.currentHead ||
      receipt.headBefore !== input.currentHead ||
      receipt.headAfter !== input.currentHead
    ) {
      return { ...common, status: 'stale' };
    }
    if (receipt.result === 'passed' && payload.result === 'passed' && payload.clean_before && payload.clean_after) {
      return { ...common, status: 'passed' };
    }
    return { ...common, status: 'failed' };
  });

  const status = aggregateProofStatus(gates);
  return {
    status,
    gates,
    staleReceiptIds: gates
      .filter((gate) => gate.status === 'stale' && gate.receipt_id)
      .map((gate) => gate.receipt_id as string),
    failedReceiptIds: gates
      .filter((gate) => gate.status === 'failed' && gate.receipt_id)
      .map((gate) => gate.receipt_id as string),
    corruptReceiptIds: gates
      .filter((gate) => gate.status === 'corrupt' && gate.receipt_id)
      .map((gate) => gate.receipt_id as string),
  };
}

function parseAndValidateReceipt(
  receipt: StoredGateReceipt,
  sessionId: string,
  gate: ProofGate,
  artifactDigest: string | null | undefined,
  digest: ProofDigest,
) {
  if (
    !Number.isSafeInteger(receipt.sequence) ||
    receipt.sequence < 1 ||
    receipt.receiptSha256 !== digest(receipt.receiptJson)
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(receipt.receiptJson) as unknown;
  } catch {
    return null;
  }
  if (canonicalJson(parsed) !== receipt.receiptJson || !isGateReceiptPayload(parsed)) {
    return null;
  }
  if (
    parsed.id !== receipt.id ||
    parsed.session_id !== sessionId ||
    parsed.gate_id !== receipt.gateId ||
    parsed.plan_sha256 !== receipt.planSha256 ||
    parsed.result !== receipt.result ||
    parsed.head_before !== receipt.headBefore ||
    parsed.head_after !== receipt.headAfter ||
    parsed.artifact.path !== receipt.artifactPath ||
    parsed.artifact.sha256 !== receipt.artifactSha256 ||
    artifactDigest !== receipt.artifactSha256 ||
    parsed.working_directory !== gate.working_directory ||
    parsed.timeout_ms !== gate.timeout_ms ||
    JSON.stringify(parsed.command) !== JSON.stringify(gate.command)
  ) {
    return null;
  }
  return parsed;
}

function isGateReceiptPayload(value: unknown): value is GateReceiptPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const payload = value as Partial<GateReceiptPayload>;
  return (
    typeof payload.id === 'string' &&
    typeof payload.session_id === 'string' &&
    typeof payload.gate_id === 'string' &&
    typeof payload.plan_sha256 === 'string' &&
    GATE_RECEIPT_RESULTS.includes(payload.result as GateReceiptResult) &&
    Array.isArray(payload.command) &&
    payload.command.every((argument) => typeof argument === 'string') &&
    typeof payload.working_directory === 'string' &&
    typeof payload.timeout_ms === 'number' &&
    typeof payload.started_at === 'string' &&
    typeof payload.ended_at === 'string' &&
    typeof payload.duration_ms === 'number' &&
    (typeof payload.exit_status === 'number' || payload.exit_status === null) &&
    (typeof payload.signal === 'string' || payload.signal === null) &&
    typeof payload.head_before === 'string' &&
    typeof payload.head_after === 'string' &&
    typeof payload.clean_before === 'boolean' &&
    typeof payload.clean_after === 'boolean' &&
    typeof payload.artifact === 'object' &&
    payload.artifact !== null &&
    typeof payload.artifact.path === 'string' &&
    typeof payload.artifact.sha256 === 'string' &&
    payload.sensor?.name === 'threadloop-local-gate' &&
    payload.sensor.contract_version === 1
  );
}

function aggregateProofStatus(gates: ProofGateEvidence[]): ProofEvidenceStatus {
  if (gates.every((gate) => gate.status === 'passed')) {
    return 'passed';
  }
  for (const status of ['corrupt', 'failed', 'stale', 'missing'] as const) {
    if (gates.some((gate) => gate.status === status)) {
      return status;
    }
  }
  return 'missing';
}

function requireExactObject(value: unknown, field: string, expectedKeys: string[]) {
  const record = requireObject(value, field);
  const keys = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw invalid(field, `must contain exactly: ${expectedKeys.join(', ')}`);
  }
  return record;
}

function requireObject(value: unknown, field: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(field, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyText(value: unknown, field: string, maximumLength: number) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximumLength || value.includes('\0')) {
    throw invalid(field, `must be a non-empty string no longer than ${maximumLength} characters`);
  }
  return value;
}

function validateTrustPolicy(value: unknown, field: string, sensorWorkflow: string): GitHubActionsTrustPolicy {
  const policy = requireExactObject(value, field, [
    'provider',
    'issuer',
    'certificate_identity',
    'source_repository',
    'build_signer_uri',
    'build_signer_sha',
  ]);
  if (policy.provider !== 'github-actions') {
    throw invalid(`${field}.provider`, 'must be github-actions');
  }
  if (policy.issuer !== 'https://token.actions.githubusercontent.com') {
    throw invalid(`${field}.issuer`, 'must be https://token.actions.githubusercontent.com');
  }

  const sourceRepository = requireNonEmptyText(policy.source_repository, `${field}.source_repository`, 512);
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceRepository)) {
    throw invalid(`${field}.source_repository`, 'must be an exact GitHub repository URI without a .git suffix');
  }

  const certificateIdentity = requireNonEmptyText(policy.certificate_identity, `${field}.certificate_identity`, 1_024);
  const escapedSource = escapeRegExp(sourceRepository);
  if (
    !new RegExp(`^${escapedSource}/\\.github/workflows/[A-Za-z0-9._-]+\\.ya?ml@refs/heads/[A-Za-z0-9._/-]+$`).test(
      certificateIdentity,
    )
  ) {
    throw invalid(
      `${field}.certificate_identity`,
      'must identify an exact workflow and branch in the source repository',
    );
  }

  const buildSignerSha = requireNonEmptyText(policy.build_signer_sha, `${field}.build_signer_sha`, 40);
  if (!/^[0-9a-f]{40}$/.test(buildSignerSha)) {
    throw invalid(`${field}.build_signer_sha`, 'must be a full lowercase Git commit SHA');
  }
  const buildSignerUri = requireNonEmptyText(policy.build_signer_uri, `${field}.build_signer_uri`, 1_024);
  const expectedSignerUri = `https://github.com/nnennandukwe/threadloop/.github/workflows/${sensorWorkflow}@${buildSignerSha}`;
  if (buildSignerUri !== expectedSignerUri) {
    throw invalid(`${field}.build_signer_uri`, `must equal ${expectedSignerUri}`);
  }

  return {
    provider: 'github-actions',
    issuer: 'https://token.actions.githubusercontent.com',
    certificate_identity: certificateIdentity,
    source_repository: sourceRepository,
    build_signer_uri: buildSignerUri,
    build_signer_sha: buildSignerSha,
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function invalid(field: string, message: string) {
  return new ProofValidationError(field, `${field} ${message}.`);
}
