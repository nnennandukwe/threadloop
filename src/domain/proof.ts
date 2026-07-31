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
  'setup_failed',
] as const;

export type GateReceiptResult = (typeof GATE_RECEIPT_RESULTS)[number];

/** Bounds the declared provisioning sequence so a plan cannot describe unbounded pre-gate work. */
const MAXIMUM_SETUP_STEPS = 32;

/**
 * A declared provisioning step. Shares the gate's own execution shape so validation and execution reuse one
 * code path, and so a receipt describes a setup step exactly as it describes the gate command.
 */
export interface ProofSetupStep {
  id: string;
  command: string[];
  working_directory: string;
  timeout_ms: number;
}

export interface ProofGate {
  id: string;
  /**
   * Ordered provisioning steps run before `command`, declarable only by contract_version 4 plans. Absent
   * rather than empty when a gate needs no provisioning, so one canonical form means "no setup" and a
   * setup-free v4 gate canonicalizes identically to the same v3 gate.
   */
  setup?: ProofSetupStep[];
  command: string[];
  working_directory: string;
  timeout_ms: number;
}

/**
 * One declared setup step as it actually ran. Recorded identically by the local and CI execution paths, so a
 * local receipt and a signed receipt for the same HEAD describe provisioning the same way.
 */
export interface RecordedSetupStep {
  id: string;
  command: string[];
  working_directory: string;
  timeout_ms: number;
  result: GateReceiptResult;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  exit_status: number | null;
  signal: string | null;
  head_before: string;
  head_after: string;
  clean_before: boolean;
  clean_after: boolean;
  output: {
    stdout_sha256: string;
    stderr_sha256: string;
  };
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

export interface SetupProofPlan {
  contract_version: 4;
  acceptance_criteria: string[];
  ci: GitHubActionsTrustPolicy;
  review: GitHubActionsTrustPolicy;
  gates: ProofGate[];
}

export type ProofPlan = LegacyProofPlan | CiProofPlan | ReviewProofPlan | SetupProofPlan;

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
  /** Present on sensor contract_version 2 receipts; absent on stored v1 receipts, which predate setup. */
  setup?: RecordedSetupStep[];
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
    contract_version: 1 | 2;
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

/**
 * `setup_failed` is deliberately distinct from `failed`. A missing toolchain is a configuration problem, so
 * it must not select repair or consume post-PR repair budget the way a code failure does.
 */
export type ProofGateEvidenceStatus = 'missing' | 'passed' | 'failed' | 'setup_failed' | 'stale' | 'corrupt';
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
  setupFailedReceiptIds: string[];
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
  const isVersionFour = candidate.contract_version === 4;
  if (!isVersionTwo && !isVersionThree && !isVersionFour && options.requireCiPolicy) {
    throw invalid('proof_plan.contract_version', 'must be 2, 3, or 4 for newly recorded proof plans');
  }
  if (!isVersionFour && options.requireReviewPolicy) {
    throw invalid('proof_plan.contract_version', 'must be 4 for newly recorded proof plans');
  }
  const plan = requireExactObject(
    candidate,
    'proof_plan',
    isVersionThree || isVersionFour
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
    const gate = validateDeclaredGate(value, { field, allowSetup: isVersionFour });
    if (gateIds.has(gate.id)) {
      throw invalid(`${field}.id`, `duplicates declared gate ${gate.id}`);
    }
    gateIds.add(gate.id);
    return gate;
  });

  if (!isVersionTwo && !isVersionThree && !isVersionFour) {
    return { acceptance_criteria: normalizedCriteria, gates };
  }

  if (isVersionThree || isVersionFour) {
    return {
      contract_version: isVersionFour ? 4 : 3,
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

export function hasCiTrustPolicy(plan: ProofPlan): plan is CiProofPlan | ReviewProofPlan | SetupProofPlan {
  return (
    'contract_version' in plan &&
    (plan.contract_version === 2 || plan.contract_version === 3 || plan.contract_version === 4)
  );
}

export function hasReviewTrustPolicy(plan: ProofPlan): plan is ReviewProofPlan | SetupProofPlan {
  return 'contract_version' in plan && (plan.contract_version === 3 || plan.contract_version === 4);
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
    if (receipt.result === 'setup_failed' && payload.result === 'setup_failed') {
      return { ...common, status: 'setup_failed' };
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
    setupFailedReceiptIds: gates
      .filter((gate) => gate.status === 'setup_failed' && gate.receipt_id)
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
    JSON.stringify(parsed.command) !== JSON.stringify(gate.command) ||
    !recordedSetupMatchesDeclared(parsed.setup, gate.setup, parsed.result === 'passed')
  ) {
    return null;
  }
  return parsed;
}

/**
 * A receipt describes everything that ran, so recorded setup must correspond to declared setup step for step.
 * A short recorded sequence is legitimate: a failing step stops the run, so later steps never execute. What is
 * never legitimate is a recorded step the plan did not declare, or one whose argv, directory, or timeout
 * differs from the declaration.
 */
export function recordedSetupMatchesDeclared(
  recorded: readonly RecordedSetupStep[] | undefined,
  declared: readonly ProofSetupStep[] | undefined,
  requireComplete = false,
): boolean {
  const recordedSteps = recorded ?? [];
  const declaredSteps = declared ?? [];
  if (
    recordedSteps.length > declaredSteps.length ||
    (requireComplete && recordedSteps.length !== declaredSteps.length)
  ) {
    return false;
  }
  return recordedSteps.every((step, index) => {
    const expected = declaredSteps[index];
    return (
      expected !== undefined &&
      (!requireComplete || step.result === 'passed') &&
      step.id === expected.id &&
      step.working_directory === expected.working_directory &&
      step.timeout_ms === expected.timeout_ms &&
      JSON.stringify(step.command) === JSON.stringify(expected.command)
    );
  });
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
    // v1 receipts predate setup and carry no `setup` key; v2 always carries one, possibly empty.
    ((payload.sensor.contract_version === 1 && payload.setup === undefined) ||
      (payload.sensor.contract_version === 2 && isRecordedSetupStepArray(payload.setup)))
  );
}

function isRecordedSetupStepArray(value: unknown): value is RecordedSetupStep[] {
  return (
    Array.isArray(value) &&
    value.every((step: unknown) => {
      if (typeof step !== 'object' || step === null || Array.isArray(step)) {
        return false;
      }
      const candidate = step as Partial<RecordedSetupStep>;
      return (
        typeof candidate.id === 'string' &&
        Array.isArray(candidate.command) &&
        candidate.command.every((argument) => typeof argument === 'string') &&
        typeof candidate.working_directory === 'string' &&
        typeof candidate.timeout_ms === 'number' &&
        GATE_RECEIPT_RESULTS.includes(candidate.result as GateReceiptResult) &&
        typeof candidate.started_at === 'string' &&
        typeof candidate.ended_at === 'string' &&
        typeof candidate.duration_ms === 'number' &&
        (typeof candidate.exit_status === 'number' || candidate.exit_status === null) &&
        (typeof candidate.signal === 'string' || candidate.signal === null) &&
        typeof candidate.head_before === 'string' &&
        typeof candidate.head_after === 'string' &&
        typeof candidate.clean_before === 'boolean' &&
        typeof candidate.clean_after === 'boolean' &&
        typeof candidate.output === 'object' &&
        candidate.output !== null &&
        typeof candidate.output.stdout_sha256 === 'string' &&
        typeof candidate.output.stderr_sha256 === 'string'
      );
    })
  );
}

function aggregateProofStatus(gates: ProofGateEvidence[]): ProofEvidenceStatus {
  if (gates.every((gate) => gate.status === 'passed')) {
    return 'passed';
  }
  // `setup_failed` outranks `failed` because a broken environment is the actionable root cause: a gate that
  // never ran its command tells you nothing about the code.
  for (const status of ['corrupt', 'setup_failed', 'failed', 'stale', 'missing'] as const) {
    if (gates.some((gate) => gate.status === status)) {
      return status;
    }
  }
  return 'missing';
}

/**
 * Validates one declared gate. Exported because the CI sensor receives a single gate rather than a whole plan
 * and must apply exactly these rules: wrapping the gate in a synthetic legacy plan would silently reject
 * declared `setup`, since only contract_version 4 admits it.
 *
 * `allowSetup` is the version gate. When false, a gate carrying `setup` fails the exact-field check rather
 * than having the field ignored.
 */
export function validateDeclaredGate(
  value: unknown,
  options: { field?: string; allowSetup?: boolean } = {},
): ProofGate {
  const field = options.field ?? 'gate';
  const record = requireObject(value, field);
  const declaresSetup = (options.allowSetup ?? true) && 'setup' in record;
  const gate = requireExactObject(
    record,
    field,
    declaresSetup
      ? ['id', 'setup', 'command', 'working_directory', 'timeout_ms']
      : ['id', 'command', 'working_directory', 'timeout_ms'],
  );
  const id = requireGateIdentifier(gate.id, `${field}.id`);
  const execution = validateExecutionSpec(gate, field);
  const setup = declaresSetup ? validateSetupSteps(gate.setup, `${field}.setup`) : [];

  return {
    id,
    ...(setup.length > 0 ? { setup } : {}),
    ...execution,
  };
}

/**
 * The execution shape shared by a gate command and every declared setup step. Extracted so a setup step can
 * never be validated more loosely than the gate command it provisions for.
 */
function validateExecutionSpec(record: Record<string, unknown>, field: string) {
  if (!Array.isArray(record.command) || record.command.length === 0 || record.command.length > 128) {
    throw invalid(`${field}.command`, 'must contain 1-128 exact argv strings');
  }
  const command = record.command.map((argument, argumentIndex) =>
    requireNonEmptyText(argument, `${field}.command[${argumentIndex}]`, 32_768),
  );

  const workingDirectory = requireNonEmptyText(record.working_directory, `${field}.working_directory`, 4_096);
  if (path.isAbsolute(workingDirectory)) {
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
    typeof record.timeout_ms !== 'number' ||
    !Number.isSafeInteger(record.timeout_ms) ||
    record.timeout_ms < 1 ||
    record.timeout_ms > 86_400_000
  ) {
    throw invalid(`${field}.timeout_ms`, 'must be an integer from 1 through 86400000');
  }

  return {
    command,
    working_directory: workingDirectory,
    timeout_ms: record.timeout_ms,
  };
}

function validateSetupSteps(value: unknown, field: string): ProofSetupStep[] {
  if (!Array.isArray(value)) {
    throw invalid(field, 'must be an array of declared setup steps');
  }
  if (value.length > MAXIMUM_SETUP_STEPS) {
    throw invalid(field, `must declare no more than ${MAXIMUM_SETUP_STEPS} setup steps`);
  }

  const stepIds = new Set<string>();
  return value.map((step, index) => {
    const stepField = `${field}[${index}]`;
    const record = requireExactObject(step, stepField, ['id', 'command', 'working_directory', 'timeout_ms']);
    const id = requireGateIdentifier(record.id, `${stepField}.id`);
    if (stepIds.has(id)) {
      throw invalid(`${stepField}.id`, `duplicates declared setup step ${id}`);
    }
    stepIds.add(id);

    return { id, ...validateExecutionSpec(record, stepField) };
  });
}

function requireGateIdentifier(value: unknown, field: string) {
  const id = requireNonEmptyText(value, field, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw invalid(field, 'must match [A-Za-z0-9][A-Za-z0-9._-]*');
  }
  return id;
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
