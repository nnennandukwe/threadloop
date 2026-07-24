import { canonicalJson } from './canonical-json.js';
import {
  GATE_RECEIPT_RESULTS,
  hasCiTrustPolicy,
  type BoundProofPlan,
  type CiTrustPolicy,
  type GateReceiptResult,
  type ProofDigest,
  type ProofGate,
} from './proof.js';

export const SIGNED_RECEIPT_MEDIA_TYPE = 'application/vnd.threadloop.signed-receipt.v1+json';
export const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
export const THREADLOOP_RECEIPT_PREDICATE_TYPE = 'https://threadloop.dev/attestations/receipt/v1';

export interface SignedGateReceiptArtifact {
  schema_version: 1;
  receipt_id: string;
  session_id: string;
  plan_sha256: string;
  gate: ProofGate;
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
  source: {
    repository: string;
    ref: string;
    head_sha: string;
    run_invocation_uri: string;
  };
  environment: {
    runner_environment: 'github-hosted';
    runner_os: string;
    runner_arch: string;
    node_version: string;
  };
  sensor: {
    name: 'threadloop-github-actions-gate';
    contract_version: 1;
  };
}

export interface InTotoReceiptStatement {
  _type: typeof IN_TOTO_STATEMENT_TYPE;
  subject: [
    { name: string; digest: { gitCommit: string } },
    { name: 'threadloop-gate-receipt.json'; digest: { sha256: string } },
  ];
  predicateType: typeof THREADLOOP_RECEIPT_PREDICATE_TYPE;
  predicate: {
    schema_version: 1;
    receipt_type: 'gate';
    session_id: string;
    plan_sha256: string;
    gate_id: string;
    result: GateReceiptResult;
    subject_head_sha: string;
    artifact: {
      name: 'threadloop-gate-receipt.json';
      sha256: string;
    };
    sensor: {
      name: 'threadloop-github-actions-gate';
      contract_version: 1;
    };
  };
}

export class AttestationValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field} ${message}.`);
    this.name = 'AttestationValidationError';
    this.field = field;
  }
}

export interface CanonicalSignedGateReceiptArtifact {
  artifact: SignedGateReceiptArtifact;
  json: string;
  sha256: string;
}

export type GitHubGateJobResult = 'success' | 'failure' | 'cancelled';

export interface GateReportSigningContext {
  receiptId: string;
  sessionId: string;
  planSha256: string;
  gate: ProofGate;
  sourceRepository: string;
  sourceRef: string;
  sourceHeadSha: string;
  runInvocationUri: string;
  runnerOs: string;
  runnerArch: string;
  nodeVersion: string;
  jobResult: GitHubGateJobResult;
}

export interface SignedReceiptEnvelope extends CanonicalSignedGateReceiptArtifact {
  artifactJson: string;
  artifactSha256: string;
  statementJson: string;
  statementSha256: string;
  bundle: Record<string, unknown>;
  packageJson: string;
  packageSha256: string;
}

export interface ParsedSignedReceiptPackage extends SignedReceiptEnvelope {
  statement: InTotoReceiptStatement;
}

export interface StoredSignedGateReceipt {
  sequence: number;
  id: string;
  sessionId: string;
  gateId: string;
  planSha256: string;
  subjectHeadSha: string;
  result: 'passed';
  packagePath: string;
  packageSha256: string;
  artifactJson: string;
  artifactSha256: string;
  statementJson: string;
  statementSha256: string;
  issuer: string;
  certificateIdentity: string;
  buildSignerUri: string;
  buildSignerSha: string;
  sourceRepository: string;
  sourceRef: string;
  runInvocationUri: string;
  stateVersion: number;
  verifiedAt: string;
}

export type CiProofGateStatus = 'missing' | 'passed' | 'stale' | 'corrupt';
export type CiProofStatus = 'policy_missing' | CiProofGateStatus;

export interface CiProofGateEvidence {
  gate_id: string;
  status: CiProofGateStatus;
  receipt_id: string | null;
  sequence: number | null;
  subject_head_sha: string | null;
  package_sha256: string | null;
  verified_at: string | null;
}

export interface CiProofEvidence {
  status: CiProofStatus;
  policy: CiTrustPolicy | null;
  gates: CiProofGateEvidence[];
}

export function canonicalizeSignedGateReceiptArtifact(
  value: unknown,
  digest: ProofDigest,
): CanonicalSignedGateReceiptArtifact {
  const artifact = validateSignedGateReceiptArtifact(value);
  const json = canonicalJson(artifact);
  return { artifact, json, sha256: digest(json) };
}

export function authorizeGateReportForSigning(
  value: unknown,
  context: GateReportSigningContext,
): SignedGateReceiptArtifact {
  const report = validateSignedGateReceiptArtifact(value);
  const expected = {
    session_id: context.sessionId,
    plan_sha256: context.planSha256,
    gate: context.gate,
    source: {
      repository: context.sourceRepository,
      ref: context.sourceRef,
      head_sha: context.sourceHeadSha,
      run_invocation_uri: context.runInvocationUri,
    },
  };
  for (const [field, actual, wanted] of [
    ['package.artifact.session_id', report.session_id, expected.session_id],
    ['package.artifact.plan_sha256', report.plan_sha256, expected.plan_sha256],
    ['package.artifact.gate', canonicalJson(report.gate), canonicalJson(expected.gate)],
    ['package.artifact.source.repository', report.source.repository, expected.source.repository],
    ['package.artifact.source.ref', report.source.ref, expected.source.ref],
    ['package.artifact.source.head_sha', report.source.head_sha, expected.source.head_sha],
    [
      'package.artifact.source.run_invocation_uri',
      report.source.run_invocation_uri,
      expected.source.run_invocation_uri,
    ],
  ] as const) {
    if (actual !== wanted) {
      throw invalid(field, 'does not match the trusted signing context');
    }
  }

  const result = authoritativeGateResult(report, context.jobResult);
  return {
    ...report,
    receipt_id: requireIdentifier(context.receiptId, 'signing.receipt_id', 160),
    result,
    exit_status:
      result === 'passed' ? 0 : report.exit_status === 0 || report.exit_status === null ? 1 : report.exit_status,
    signal: result === 'passed' ? null : report.signal,
    environment: {
      runner_environment: 'github-hosted',
      runner_os: requireText(context.runnerOs, 'signing.runner_os', 128),
      runner_arch: requireText(context.runnerArch, 'signing.runner_arch', 128),
      node_version: requireText(context.nodeVersion, 'signing.node_version', 128),
    },
  };
}

export function buildInTotoReceiptStatement(
  artifact: SignedGateReceiptArtifact,
  artifactSha256: string,
): InTotoReceiptStatement {
  requireSha256(artifactSha256, 'statement.subject[1].digest.sha256');
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [
      {
        name: artifact.source.repository,
        digest: { gitCommit: artifact.source.head_sha },
      },
      {
        name: 'threadloop-gate-receipt.json',
        digest: { sha256: artifactSha256 },
      },
    ],
    predicateType: THREADLOOP_RECEIPT_PREDICATE_TYPE,
    predicate: {
      schema_version: 1,
      receipt_type: 'gate',
      session_id: artifact.session_id,
      plan_sha256: artifact.plan_sha256,
      gate_id: artifact.gate.id,
      result: artifact.result,
      subject_head_sha: artifact.source.head_sha,
      artifact: {
        name: 'threadloop-gate-receipt.json',
        sha256: artifactSha256,
      },
      sensor: {
        name: 'threadloop-github-actions-gate',
        contract_version: 1,
      },
    },
  };
}

export function parseSignedReceiptPackage(value: unknown, digest: ProofDigest): ParsedSignedReceiptPackage {
  return validateSignedReceiptStatement(parseSignedReceiptEnvelope(value, digest));
}

export function parseSignedReceiptEnvelope(value: unknown, digest: ProofDigest): SignedReceiptEnvelope {
  const receiptPackage = requireExactObject(value, 'package', ['media_type', 'artifact', 'bundle']);
  if (receiptPackage.media_type !== SIGNED_RECEIPT_MEDIA_TYPE) {
    throw invalid('package.media_type', `must be ${SIGNED_RECEIPT_MEDIA_TYPE}`);
  }
  const canonicalArtifact = canonicalizeSignedGateReceiptArtifact(receiptPackage.artifact, digest);
  const bundle = requireObject(receiptPackage.bundle, 'package.bundle');
  const envelope = requireObject(bundle.dsseEnvelope, 'package.bundle.dsseEnvelope');
  if (envelope.payloadType !== IN_TOTO_PAYLOAD_TYPE) {
    throw invalid('package.bundle.dsseEnvelope.payloadType', `must be ${IN_TOTO_PAYLOAD_TYPE}`);
  }
  const payload = requireText(envelope.payload, 'package.bundle.dsseEnvelope.payload', 16_000_000);
  if (!isCanonicalBase64(payload)) {
    throw invalid('package.bundle.dsseEnvelope.payload', 'must be canonical base64');
  }
  const statementJson = Buffer.from(payload, 'base64').toString('utf8');
  const packageValue = {
    media_type: SIGNED_RECEIPT_MEDIA_TYPE,
    artifact: canonicalArtifact.artifact,
    bundle,
  };
  const packageJson = canonicalJson(packageValue);
  return {
    ...canonicalArtifact,
    artifactJson: canonicalArtifact.json,
    artifactSha256: canonicalArtifact.sha256,
    statementJson,
    statementSha256: digest(statementJson),
    bundle,
    packageJson,
    packageSha256: digest(packageJson),
  };
}

export function validateSignedReceiptStatement(envelope: SignedReceiptEnvelope): ParsedSignedReceiptPackage {
  let statementValue: unknown;
  try {
    statementValue = JSON.parse(envelope.statementJson) as unknown;
  } catch {
    throw invalid('package.bundle.dsseEnvelope.payload', 'must encode a JSON statement');
  }
  if (canonicalJson(statementValue) !== envelope.statementJson) {
    throw invalid('package.bundle.dsseEnvelope.payload', 'must encode canonical JSON');
  }
  return {
    ...envelope,
    statement: validateInTotoReceiptStatement(statementValue, envelope),
  };
}

export function evaluateCiProofEvidence(input: {
  sessionId: string;
  plan: BoundProofPlan;
  receipts: StoredSignedGateReceipt[];
  currentHead: string | null;
  packageContents: ReadonlyMap<string, string | null>;
  digest: ProofDigest;
}): CiProofEvidence {
  const proofPlan = input.plan.plan;
  if (!hasCiTrustPolicy(proofPlan)) {
    return {
      status: 'policy_missing',
      policy: null,
      gates: input.plan.plan.gates.map((gate) => emptyCiGate(gate.id)),
    };
  }
  const policy = proofPlan.ci;

  const latestByGate = new Map<string, StoredSignedGateReceipt>();
  for (const receipt of [...input.receipts].sort((left, right) => left.sequence - right.sequence)) {
    latestByGate.set(receipt.gateId, receipt);
  }
  const gates = input.plan.plan.gates.map((gate): CiProofGateEvidence => {
    const receipt = latestByGate.get(gate.id);
    if (!receipt) {
      return emptyCiGate(gate.id);
    }
    const common = {
      gate_id: gate.id,
      receipt_id: receipt.id,
      sequence: receipt.sequence,
      subject_head_sha: receipt.subjectHeadSha,
      package_sha256: receipt.packageSha256,
      verified_at: receipt.verifiedAt,
    };
    const packageJson = input.packageContents.get(receipt.id);
    if (!packageJson || input.digest(packageJson) !== receipt.packageSha256) {
      return { ...common, status: 'corrupt' };
    }
    let parsed: ParsedSignedReceiptPackage;
    try {
      parsed = parseSignedReceiptPackage(JSON.parse(packageJson) as unknown, input.digest);
    } catch {
      return { ...common, status: 'corrupt' };
    }
    if (
      parsed.packageJson !== packageJson ||
      parsed.packageSha256 !== receipt.packageSha256 ||
      parsed.artifactJson !== receipt.artifactJson ||
      parsed.artifactSha256 !== receipt.artifactSha256 ||
      parsed.statementJson !== receipt.statementJson ||
      parsed.statementSha256 !== receipt.statementSha256 ||
      parsed.artifact.receipt_id !== receipt.id ||
      parsed.artifact.session_id !== input.sessionId ||
      parsed.artifact.gate.id !== receipt.gateId ||
      parsed.artifact.plan_sha256 !== receipt.planSha256 ||
      parsed.artifact.source.head_sha !== receipt.subjectHeadSha ||
      receipt.result !== 'passed' ||
      parsed.artifact.result !== 'passed' ||
      parsed.artifact.exit_status !== 0 ||
      parsed.artifact.signal !== null ||
      !parsed.artifact.clean_before ||
      !parsed.artifact.clean_after ||
      parsed.artifact.head_before !== receipt.subjectHeadSha ||
      parsed.artifact.head_after !== receipt.subjectHeadSha ||
      canonicalJson(parsed.artifact.gate) !== canonicalJson(gate) ||
      receipt.issuer !== policy.issuer ||
      receipt.certificateIdentity !== policy.certificate_identity ||
      receipt.buildSignerUri !== policy.build_signer_uri ||
      receipt.buildSignerSha !== policy.build_signer_sha ||
      receipt.sourceRepository !== policy.source_repository ||
      parsed.artifact.source.repository !== receipt.sourceRepository ||
      parsed.artifact.source.ref !== receipt.sourceRef ||
      parsed.artifact.source.run_invocation_uri !== receipt.runInvocationUri
    ) {
      return { ...common, status: 'corrupt' };
    }
    if (
      receipt.planSha256 !== input.plan.sha256 ||
      !input.currentHead ||
      receipt.subjectHeadSha !== input.currentHead
    ) {
      return { ...common, status: 'stale' };
    }
    return { ...common, status: 'passed' };
  });

  return {
    status: aggregateCiProofStatus(gates),
    policy,
    gates,
  };
}

function emptyCiGate(gateId: string): CiProofGateEvidence {
  return {
    gate_id: gateId,
    status: 'missing',
    receipt_id: null,
    sequence: null,
    subject_head_sha: null,
    package_sha256: null,
    verified_at: null,
  };
}

function aggregateCiProofStatus(gates: CiProofGateEvidence[]): CiProofStatus {
  if (gates.every((gate) => gate.status === 'passed')) {
    return 'passed';
  }
  for (const status of ['corrupt', 'stale', 'missing'] as const) {
    if (gates.some((gate) => gate.status === status)) {
      return status;
    }
  }
  return 'missing';
}

function validateSignedGateReceiptArtifact(value: unknown): SignedGateReceiptArtifact {
  const field = 'package.artifact';
  const artifact = requireExactObject(value, field, [
    'schema_version',
    'receipt_id',
    'session_id',
    'plan_sha256',
    'gate',
    'result',
    'started_at',
    'ended_at',
    'duration_ms',
    'exit_status',
    'signal',
    'head_before',
    'head_after',
    'clean_before',
    'clean_after',
    'output',
    'source',
    'environment',
    'sensor',
  ]);
  if (artifact.schema_version !== 1) {
    throw invalid(`${field}.schema_version`, 'must be 1');
  }
  const receiptId = requireIdentifier(artifact.receipt_id, `${field}.receipt_id`, 160);
  const sessionId = requireIdentifier(artifact.session_id, `${field}.session_id`, 160);
  const planSha256 = requireSha256(artifact.plan_sha256, `${field}.plan_sha256`);
  const gate = validateGate(artifact.gate, `${field}.gate`);
  if (!GATE_RECEIPT_RESULTS.includes(artifact.result as GateReceiptResult)) {
    throw invalid(`${field}.result`, `must be one of: ${GATE_RECEIPT_RESULTS.join(', ')}`);
  }
  const result = artifact.result as GateReceiptResult;
  const startedAt = requireTimestamp(artifact.started_at, `${field}.started_at`);
  const endedAt = requireTimestamp(artifact.ended_at, `${field}.ended_at`);
  const durationMs = requireSafeInteger(artifact.duration_ms, `${field}.duration_ms`, 0, 86_400_000);
  const exitStatus =
    artifact.exit_status === null
      ? null
      : requireSafeInteger(artifact.exit_status, `${field}.exit_status`, -2_147_483_648, 2_147_483_647);
  const signal = artifact.signal === null ? null : requireText(artifact.signal, `${field}.signal`, 128);
  const headBefore = requireCommitSha(artifact.head_before, `${field}.head_before`);
  const headAfter = requireCommitSha(artifact.head_after, `${field}.head_after`);
  if (typeof artifact.clean_before !== 'boolean') {
    throw invalid(`${field}.clean_before`, 'must be a boolean');
  }
  if (typeof artifact.clean_after !== 'boolean') {
    throw invalid(`${field}.clean_after`, 'must be a boolean');
  }

  const output = requireExactObject(artifact.output, `${field}.output`, ['stdout_sha256', 'stderr_sha256']);
  const stdoutSha256 = requireSha256(output.stdout_sha256, `${field}.output.stdout_sha256`);
  const stderrSha256 = requireSha256(output.stderr_sha256, `${field}.output.stderr_sha256`);

  const source = requireExactObject(artifact.source, `${field}.source`, [
    'repository',
    'ref',
    'head_sha',
    'run_invocation_uri',
  ]);
  const repository = requireGitHubRepository(source.repository, `${field}.source.repository`);
  const sourceRef = requireText(source.ref, `${field}.source.ref`, 1_024);
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(sourceRef)) {
    throw invalid(`${field}.source.ref`, 'must be an exact branch ref');
  }
  const sourceHeadSha = requireCommitSha(source.head_sha, `${field}.source.head_sha`);
  const runInvocationUri = requireText(source.run_invocation_uri, `${field}.source.run_invocation_uri`, 1_024);
  if (
    !new RegExp(`^${escapeRegExp(repository)}/actions/runs/[1-9][0-9]*/attempts/[1-9][0-9]*$`).test(runInvocationUri)
  ) {
    throw invalid(`${field}.source.run_invocation_uri`, 'must identify an exact GitHub Actions run attempt');
  }

  const environment = requireExactObject(artifact.environment, `${field}.environment`, [
    'runner_environment',
    'runner_os',
    'runner_arch',
    'node_version',
  ]);
  if (environment.runner_environment !== 'github-hosted') {
    throw invalid(`${field}.environment.runner_environment`, 'must be github-hosted');
  }
  const runnerOs = requireText(environment.runner_os, `${field}.environment.runner_os`, 128);
  const runnerArch = requireText(environment.runner_arch, `${field}.environment.runner_arch`, 128);
  const nodeVersion = requireText(environment.node_version, `${field}.environment.node_version`, 128);

  const sensor = requireExactObject(artifact.sensor, `${field}.sensor`, ['name', 'contract_version']);
  if (sensor.name !== 'threadloop-github-actions-gate') {
    throw invalid(`${field}.sensor.name`, 'must be threadloop-github-actions-gate');
  }
  if (sensor.contract_version !== 1) {
    throw invalid(`${field}.sensor.contract_version`, 'must be 1');
  }

  return {
    schema_version: 1,
    receipt_id: receiptId,
    session_id: sessionId,
    plan_sha256: planSha256,
    gate,
    result,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs,
    exit_status: exitStatus,
    signal,
    head_before: headBefore,
    head_after: headAfter,
    clean_before: artifact.clean_before,
    clean_after: artifact.clean_after,
    output: {
      stdout_sha256: stdoutSha256,
      stderr_sha256: stderrSha256,
    },
    source: {
      repository,
      ref: sourceRef,
      head_sha: sourceHeadSha,
      run_invocation_uri: runInvocationUri,
    },
    environment: {
      runner_environment: 'github-hosted',
      runner_os: runnerOs,
      runner_arch: runnerArch,
      node_version: nodeVersion,
    },
    sensor: {
      name: 'threadloop-github-actions-gate',
      contract_version: 1,
    },
  };
}

function authoritativeGateResult(report: SignedGateReceiptArtifact, jobResult: GitHubGateJobResult): GateReceiptResult {
  if (jobResult === 'cancelled') {
    return 'aborted';
  }
  if (jobResult === 'failure') {
    return report.result === 'passed' ? 'failed' : report.result;
  }
  if (
    report.result !== 'passed' ||
    report.exit_status !== 0 ||
    report.signal !== null ||
    !report.clean_before ||
    !report.clean_after ||
    report.head_before !== report.source.head_sha ||
    report.head_after !== report.source.head_sha
  ) {
    throw invalid('package.artifact.result', 'cannot be passed because the captured gate report is not a clean pass');
  }
  return 'passed';
}

function validateInTotoReceiptStatement(
  value: unknown,
  artifact: CanonicalSignedGateReceiptArtifact,
): InTotoReceiptStatement {
  const statement = requireExactObject(value, 'statement', ['_type', 'subject', 'predicateType', 'predicate']);
  if (statement._type !== IN_TOTO_STATEMENT_TYPE) {
    throw invalid('statement._type', `must be ${IN_TOTO_STATEMENT_TYPE}`);
  }
  if (statement.predicateType !== THREADLOOP_RECEIPT_PREDICATE_TYPE) {
    throw invalid('statement.predicateType', `must be ${THREADLOOP_RECEIPT_PREDICATE_TYPE}`);
  }
  if (!Array.isArray(statement.subject) || statement.subject.length !== 2) {
    throw invalid('statement.subject', 'must contain exactly the repository HEAD and receipt artifact');
  }
  const sourceSubject = requireExactObject(statement.subject[0], 'statement.subject[0]', ['name', 'digest']);
  if (sourceSubject.name !== artifact.artifact.source.repository) {
    throw invalid('statement.subject[0].name', 'must match package.artifact.source.repository');
  }
  const sourceDigest = requireExactObject(sourceSubject.digest, 'statement.subject[0].digest', ['gitCommit']);
  if (sourceDigest.gitCommit !== artifact.artifact.source.head_sha) {
    throw invalid('statement.subject[0].digest.gitCommit', 'must match package.artifact.source.head_sha');
  }
  const artifactSubject = requireExactObject(statement.subject[1], 'statement.subject[1]', ['name', 'digest']);
  if (artifactSubject.name !== 'threadloop-gate-receipt.json') {
    throw invalid('statement.subject[1].name', 'must be threadloop-gate-receipt.json');
  }
  const artifactDigest = requireExactObject(artifactSubject.digest, 'statement.subject[1].digest', ['sha256']);
  if (artifactDigest.sha256 !== artifact.sha256) {
    throw invalid('statement.subject[1].digest.sha256', 'must match the canonical package artifact digest');
  }

  const predicate = requireExactObject(statement.predicate, 'statement.predicate', [
    'schema_version',
    'receipt_type',
    'session_id',
    'plan_sha256',
    'gate_id',
    'result',
    'subject_head_sha',
    'artifact',
    'sensor',
  ]);
  if (predicate.schema_version !== 1) {
    throw invalid('statement.predicate.schema_version', 'must be 1');
  }
  if (predicate.receipt_type !== 'gate') {
    throw invalid('statement.predicate.receipt_type', 'must be gate');
  }
  assertEqual(predicate.session_id, artifact.artifact.session_id, 'statement.predicate.session_id');
  assertEqual(predicate.plan_sha256, artifact.artifact.plan_sha256, 'statement.predicate.plan_sha256');
  assertEqual(predicate.gate_id, artifact.artifact.gate.id, 'statement.predicate.gate_id');
  assertEqual(predicate.result, artifact.artifact.result, 'statement.predicate.result');
  assertEqual(predicate.subject_head_sha, artifact.artifact.source.head_sha, 'statement.predicate.subject_head_sha');

  const predicateArtifact = requireExactObject(predicate.artifact, 'statement.predicate.artifact', ['name', 'sha256']);
  assertEqual(predicateArtifact.name, 'threadloop-gate-receipt.json', 'statement.predicate.artifact.name');
  assertEqual(predicateArtifact.sha256, artifact.sha256, 'statement.predicate.artifact.sha256');
  const sensor = requireExactObject(predicate.sensor, 'statement.predicate.sensor', ['name', 'contract_version']);
  assertEqual(sensor.name, 'threadloop-github-actions-gate', 'statement.predicate.sensor.name');
  assertEqual(sensor.contract_version, 1, 'statement.predicate.sensor.contract_version');

  return value as InTotoReceiptStatement;
}

function validateGate(value: unknown, field: string): ProofGate {
  const gate = requireExactObject(value, field, ['id', 'command', 'working_directory', 'timeout_ms']);
  const id = requireIdentifier(gate.id, `${field}.id`, 128);
  if (!Array.isArray(gate.command) || gate.command.length === 0 || gate.command.length > 128) {
    throw invalid(`${field}.command`, 'must contain 1-128 exact argv strings');
  }
  const command = gate.command.map((argument, index) => requireText(argument, `${field}.command[${index}]`, 32_768));
  const workingDirectory = requireText(gate.working_directory, `${field}.working_directory`, 4_096);
  if (
    workingDirectory.startsWith('/') ||
    workingDirectory === '..' ||
    workingDirectory.startsWith('../') ||
    workingDirectory.includes('\0')
  ) {
    throw invalid(`${field}.working_directory`, 'must be repository-relative and must not escape the repository');
  }
  const timeoutMs = requireSafeInteger(gate.timeout_ms, `${field}.timeout_ms`, 1, 86_400_000);
  return { id, command, working_directory: workingDirectory, timeout_ms: timeoutMs };
}

function requireObject(value: unknown, field: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(field, 'must be an object');
  }
  return value as Record<string, unknown>;
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

function requireText(value: unknown, field: string, maximumLength: number) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximumLength || value.includes('\0')) {
    throw invalid(field, `must be a non-empty string no longer than ${maximumLength} characters`);
  }
  return value;
}

function requireIdentifier(value: unknown, field: string, maximumLength: number) {
  const text = requireText(value, field, maximumLength);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) {
    throw invalid(field, 'must match [A-Za-z0-9][A-Za-z0-9._-]*');
  }
  return text;
}

function requireSha256(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw invalid(field, 'must be a lowercase SHA-256 digest');
  }
  return value;
}

function requireCommitSha(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw invalid(field, 'must be a full lowercase Git commit SHA');
  }
  return value;
}

function requireTimestamp(value: unknown, field: string) {
  const text = requireText(value, field, 64);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== text) {
    throw invalid(field, 'must be a canonical UTC ISO-8601 timestamp');
  }
  return text;
}

function requireSafeInteger(value: unknown, field: string, minimum: number, maximum: number) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalid(field, `must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function requireGitHubRepository(value: unknown, field: string) {
  const repository = requireText(value, field, 512);
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw invalid(field, 'must be an exact GitHub repository URI without a .git suffix');
  }
  return repository;
}

function isCanonicalBase64(value: string) {
  if (value.length % 4 !== 0) {
    return false;
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const body = value.slice(0, padding === 0 ? undefined : -padding);
  if (
    body.includes('=') ||
    !Array.from(body).every((character) => {
      const code = character.charCodeAt(0);
      return (
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        character === '+' ||
        character === '/'
      );
    })
  ) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function assertEqual(actual: unknown, expected: unknown, field: string) {
  if (actual !== expected) {
    throw invalid(field, 'does not match the canonical receipt artifact');
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function invalid(field: string, message: string) {
  return new AttestationValidationError(field, message);
}
