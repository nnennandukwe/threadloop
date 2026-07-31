import { canonicalJson } from './canonical-json.js';
import {
  GATE_RECEIPT_RESULTS,
  hasCiTrustPolicy,
  recordedSetupMatchesDeclared,
  type BoundProofPlan,
  type GitHubActionsTrustPolicy,
  type GateReceiptResult,
  type ProofDigest,
  type ProofGate,
  type RecordedSetupStep,
} from './proof.js';

export const SIGNED_RECEIPT_MEDIA_TYPE_V1 = 'application/vnd.threadloop.signed-receipt.v1+json';
/** The version newly signed receipts use. Stored v1 packages stay readable. */
export const SIGNED_RECEIPT_MEDIA_TYPE_V2 = 'application/vnd.threadloop.signed-receipt.v2+json';
export const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
export const THREADLOOP_RECEIPT_PREDICATE_TYPE_V1 = 'https://threadloop.dev/attestations/receipt/v1';
export const THREADLOOP_RECEIPT_PREDICATE_TYPE_V2 = 'https://threadloop.dev/attestations/receipt/v2';

export type SignedReceiptSchemaVersion = 1 | 2;

/**
 * The media type, predicate type, and artifact schema_version move together. Pairing them explicitly stops a
 * v2 artifact carrying recorded setup from being presented under a v1 media type that predates it.
 */
export function signedReceiptMediaType(schemaVersion: SignedReceiptSchemaVersion) {
  return schemaVersion === 1 ? SIGNED_RECEIPT_MEDIA_TYPE_V1 : SIGNED_RECEIPT_MEDIA_TYPE_V2;
}

export function threadloopReceiptPredicateType(schemaVersion: SignedReceiptSchemaVersion) {
  return schemaVersion === 1 ? THREADLOOP_RECEIPT_PREDICATE_TYPE_V1 : THREADLOOP_RECEIPT_PREDICATE_TYPE_V2;
}

export interface SignedGateReceiptArtifact {
  /** 1 predates declared setup and carries no `setup` key; 2 always carries one, possibly empty. */
  schema_version: SignedReceiptSchemaVersion;
  receipt_id: string;
  session_id: string;
  plan_sha256: string;
  gate: ProofGate;
  result: GateReceiptResult;
  setup?: RecordedSetupStep[];
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
    contract_version: SignedReceiptSchemaVersion;
  };
}

export interface InTotoReceiptStatement {
  _type: typeof IN_TOTO_STATEMENT_TYPE;
  subject: [
    { name: string; digest: { gitCommit: string } },
    { name: 'threadloop-gate-receipt.json'; digest: { sha256: string } },
  ];
  predicateType: typeof THREADLOOP_RECEIPT_PREDICATE_TYPE_V1 | typeof THREADLOOP_RECEIPT_PREDICATE_TYPE_V2;
  predicate: {
    schema_version: SignedReceiptSchemaVersion;
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
      contract_version: SignedReceiptSchemaVersion;
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
  policy: GitHubActionsTrustPolicy | null;
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
    // Spreading `report` carries recorded setup through signing unchanged, so the signed artifact keeps
    // describing exactly what the sensor observed.
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
    predicateType: threadloopReceiptPredicateType(artifact.schema_version),
    predicate: {
      schema_version: artifact.schema_version,
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
        contract_version: artifact.schema_version,
      },
    },
  };
}

export function parseSignedReceiptPackage(value: unknown, digest: ProofDigest): ParsedSignedReceiptPackage {
  return validateSignedReceiptStatement(parseSignedReceiptEnvelope(value, digest));
}

export function parseSignedReceiptEnvelope(value: unknown, digest: ProofDigest): SignedReceiptEnvelope {
  const receiptPackage = requireExactObject(value, 'package', ['media_type', 'artifact', 'bundle']);
  const canonicalArtifact = canonicalizeSignedGateReceiptArtifact(receiptPackage.artifact, digest);
  // Pinned to the artifact's own version, so a v2 artifact cannot arrive under the v1 media type.
  const expectedMediaType = signedReceiptMediaType(canonicalArtifact.artifact.schema_version);
  if (receiptPackage.media_type !== expectedMediaType) {
    throw invalid('package.media_type', `must be ${expectedMediaType}`);
  }
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
    media_type: expectedMediaType,
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
      !recordedSetupMatchesDeclared(parsed.artifact.setup, gate.setup, parsed.artifact.result) ||
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
  const candidate = requireObject(value, field);
  if (candidate.schema_version !== 1 && candidate.schema_version !== 2) {
    throw invalid(`${field}.schema_version`, 'must be 1 or 2');
  }
  const schemaVersion: SignedReceiptSchemaVersion = candidate.schema_version === 2 ? 2 : 1;
  const artifact = requireExactObject(candidate, field, [
    'schema_version',
    'receipt_id',
    'session_id',
    'plan_sha256',
    'gate',
    'result',
    ...(schemaVersion === 2 ? ['setup'] : []),
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
  const receiptId = requireIdentifier(artifact.receipt_id, `${field}.receipt_id`, 160);
  const sessionId = requireIdentifier(artifact.session_id, `${field}.session_id`, 160);
  const planSha256 = requireSha256(artifact.plan_sha256, `${field}.plan_sha256`);
  const gate = validateGate(artifact.gate, `${field}.gate`);
  if (!GATE_RECEIPT_RESULTS.includes(artifact.result as GateReceiptResult)) {
    throw invalid(`${field}.result`, `must be one of: ${GATE_RECEIPT_RESULTS.join(', ')}`);
  }
  const result = artifact.result as GateReceiptResult;
  const setup = schemaVersion === 2 ? validateRecordedSetup(artifact.setup, `${field}.setup`, gate, result) : undefined;
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
  // The sensor contract and the artifact schema move together, so a v2 artifact cannot claim a v1 sensor.
  if (sensor.contract_version !== schemaVersion) {
    throw invalid(`${field}.sensor.contract_version`, `must be ${schemaVersion}`);
  }

  return {
    schema_version: schemaVersion,
    receipt_id: receiptId,
    session_id: sessionId,
    plan_sha256: planSha256,
    gate,
    result,
    ...(setup ? { setup } : {}),
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
      contract_version: schemaVersion,
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
  // Pinned to the artifact's version, so the statement cannot describe a v2 receipt as a v1 predicate.
  const expectedPredicateType = threadloopReceiptPredicateType(artifact.artifact.schema_version);
  if (statement.predicateType !== expectedPredicateType) {
    throw invalid('statement.predicateType', `must be ${expectedPredicateType}`);
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
  if (predicate.schema_version !== artifact.artifact.schema_version) {
    throw invalid('statement.predicate.schema_version', `must be ${artifact.artifact.schema_version}`);
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
  assertEqual(sensor.contract_version, artifact.artifact.schema_version, 'statement.predicate.sensor.contract_version');

  return value as InTotoReceiptStatement;
}

function validateGate(value: unknown, field: string): ProofGate {
  const record = requireObject(value, field);
  const declaresSetup = 'setup' in record;
  const gate = requireExactObject(
    record,
    field,
    declaresSetup
      ? ['id', 'setup', 'command', 'working_directory', 'timeout_ms']
      : ['id', 'command', 'working_directory', 'timeout_ms'],
  );
  const id = requireIdentifier(gate.id, `${field}.id`, 128);
  const execution = validateGateExecution(gate, field);
  if (!declaresSetup) {
    return { id, ...execution };
  }
  if (!Array.isArray(gate.setup) || gate.setup.length === 0 || gate.setup.length > 32) {
    throw invalid(`${field}.setup`, 'must contain 1-32 declared setup steps when present');
  }
  const setup = gate.setup.map((step, index) => {
    const stepField = `${field}.setup[${index}]`;
    const stepRecord = requireExactObject(step, stepField, ['id', 'command', 'working_directory', 'timeout_ms']);
    return {
      id: requireIdentifier(stepRecord.id, `${stepField}.id`, 128),
      ...validateGateExecution(stepRecord, stepField),
    };
  });
  return { id, setup, ...execution };
}

function validateGateExecution(record: Record<string, unknown>, field: string) {
  if (!Array.isArray(record.command) || record.command.length === 0 || record.command.length > 128) {
    throw invalid(`${field}.command`, 'must contain 1-128 exact argv strings');
  }
  const command = record.command.map((argument, index) => requireText(argument, `${field}.command[${index}]`, 32_768));
  const workingDirectory = requireText(record.working_directory, `${field}.working_directory`, 4_096);
  if (
    workingDirectory.startsWith('/') ||
    workingDirectory === '..' ||
    workingDirectory.startsWith('../') ||
    workingDirectory.includes('\0')
  ) {
    throw invalid(`${field}.working_directory`, 'must be repository-relative and must not escape the repository');
  }
  const timeoutMs = requireSafeInteger(record.timeout_ms, `${field}.timeout_ms`, 1, 86_400_000);
  return { command, working_directory: workingDirectory, timeout_ms: timeoutMs };
}

/**
 * Recorded setup must correspond to the gate's own declaration, step for step. A short sequence is legitimate
 * because a failing step stops the run, but setup_failed must identify that failure as the last recorded step.
 */
function validateRecordedSetup(
  value: unknown,
  field: string,
  gate: ProofGate,
  result: GateReceiptResult,
): RecordedSetupStep[] {
  if (!Array.isArray(value)) {
    throw invalid(field, 'must be an array of recorded setup steps');
  }
  const declared = gate.setup ?? [];
  const requiresCompleteSetup = result !== 'setup_failed' && result !== 'invalidated';
  if (result === 'setup_failed' && declared.length === 0) {
    throw invalid(field, 'cannot be setup_failed when the gate declares no setup');
  }
  if (value.length > declared.length) {
    throw invalid(field, 'must not record more steps than the gate declares');
  }
  if (result === 'setup_failed' && value.length === 0) {
    throw invalid(field, 'must record the setup step that failed');
  }
  if (requiresCompleteSetup && value.length !== declared.length) {
    throw invalid(field, 'must record every declared setup step for this receipt result');
  }
  const recorded = value.map((step, index) => {
    const stepField = `${field}[${index}]`;
    const record = requireExactObject(step, stepField, [
      'id',
      'command',
      'working_directory',
      'timeout_ms',
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
    ]);
    const execution = validateGateExecution(record, stepField);
    const id = requireIdentifier(record.id, `${stepField}.id`, 128);
    const expected = declared[index];
    if (
      !expected ||
      expected.id !== id ||
      expected.working_directory !== execution.working_directory ||
      expected.timeout_ms !== execution.timeout_ms ||
      canonicalJson(expected.command) !== canonicalJson(execution.command)
    ) {
      throw invalid(stepField, 'must match the setup step the gate declares at the same position');
    }
    if (!GATE_RECEIPT_RESULTS.includes(record.result as GateReceiptResult)) {
      throw invalid(`${stepField}.result`, `must be one of: ${GATE_RECEIPT_RESULTS.join(', ')}`);
    }
    const stepResult = record.result as GateReceiptResult;
    if (requiresCompleteSetup && stepResult !== 'passed') {
      throw invalid(`${stepField}.result`, 'must be passed when the gate command ran');
    }
    if (typeof record.clean_before !== 'boolean' || typeof record.clean_after !== 'boolean') {
      throw invalid(stepField, 'must record clean_before and clean_after as booleans');
    }
    const output = requireExactObject(record.output, `${stepField}.output`, ['stdout_sha256', 'stderr_sha256']);
    return {
      id,
      ...execution,
      result: stepResult,
      started_at: requireTimestamp(record.started_at, `${stepField}.started_at`),
      ended_at: requireTimestamp(record.ended_at, `${stepField}.ended_at`),
      duration_ms: requireSafeInteger(record.duration_ms, `${stepField}.duration_ms`, 0, 86_400_000),
      exit_status:
        record.exit_status === null
          ? null
          : requireSafeInteger(record.exit_status, `${stepField}.exit_status`, -2_147_483_648, 2_147_483_647),
      signal: record.signal === null ? null : requireText(record.signal, `${stepField}.signal`, 128),
      head_before: requireCommitSha(record.head_before, `${stepField}.head_before`),
      head_after: requireCommitSha(record.head_after, `${stepField}.head_after`),
      clean_before: record.clean_before,
      clean_after: record.clean_after,
      output: {
        stdout_sha256: requireSha256(output.stdout_sha256, `${stepField}.output.stdout_sha256`),
        stderr_sha256: requireSha256(output.stderr_sha256, `${stepField}.output.stderr_sha256`),
      },
    };
  });
  if (result === 'setup_failed') {
    const firstNonPassingIndex = recorded.findIndex((step) => step.result !== 'passed');
    if (firstNonPassingIndex === -1) {
      throw invalid(field, 'must include a non-passing setup step');
    }
    if (firstNonPassingIndex !== recorded.length - 1) {
      throw invalid(
        `${field}[${firstNonPassingIndex}].result`,
        'the first non-passing setup step must be the last recorded step',
      );
    }
  }
  return recorded;
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
