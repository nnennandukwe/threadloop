import { z } from 'zod';
import { canonicalJson, isPlainObject } from './canonical-json.js';
import {
  aggregateGateStatus,
  declaredGateSchema,
  gateReceiptResult,
  hasCiTrustPolicy,
  latestBy,
  recordedSetupStepSchema,
  recordedSetupViolation,
  type BoundProofPlan,
  type GitHubActionsTrustPolicy,
  type GateReceiptResult,
  type ProofDigest,
  type ProofGate,
} from './proof.js';
import {
  boolean,
  canonicalTimestamp,
  commitSha,
  escapeRegExp,
  exactObject,
  githubRepository,
  identifier,
  integer,
  literal,
  parseFields,
  reject,
  rule,
  sha256Digest,
  text,
  type FieldErrorFactory,
} from './validation.js';

export const SIGNED_RECEIPT_MEDIA_TYPE_V1 = 'application/vnd.threadloop.signed-receipt.v1+json';
/** The version newly signed receipts use. Stored v1 packages stay readable. */
export const SIGNED_RECEIPT_MEDIA_TYPE_V2 = 'application/vnd.threadloop.signed-receipt.v2+json';
export const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json';

type SignedReceiptSchemaVersion = 1 | 2;

/**
 * The media type, predicate type, and artifact schema_version move together. Pairing them explicitly stops a
 * v2 artifact carrying recorded setup from being presented under a v1 media type that predates it.
 */
export function signedReceiptMediaType(schemaVersion: SignedReceiptSchemaVersion) {
  return schemaVersion === 1 ? SIGNED_RECEIPT_MEDIA_TYPE_V1 : SIGNED_RECEIPT_MEDIA_TYPE_V2;
}

export class AttestationValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field} ${message}.`);
    this.name = 'AttestationValidationError';
    this.field = field;
  }
}

const attestationError: FieldErrorFactory = (field, detail) => new AttestationValidationError(field, detail);

/**
 * A signed artifact embeds its gate in canonical form. An empty `setup` that a plan would normalize away is
 * rejected rather than rewritten, so the artifact bytes a signer saw are the bytes that get canonicalized.
 */
const canonicalGateSchema = z.preprocess((gate, context) => {
  if (isPlainObject(gate) && Array.isArray(gate.setup) && gate.setup.length === 0) {
    reject(context, ['setup'], 'must contain 1-32 declared setup steps when present');
  }
  return gate;
}, declaredGateSchema);

const signedGateReceiptArtifactSchema = z.preprocess(
  (artifact, context) => {
    if (isPlainObject(artifact) && artifact.schema_version !== 1 && artifact.schema_version !== 2) {
      reject(context, ['schema_version'], 'must be 1 or 2');
    }
    return artifact;
  },
  exactObject(
    {
      schema_version: z.literal([1, 2]),
      receipt_id: identifier(160),
      session_id: identifier(160),
      plan_sha256: sha256Digest,
      gate: canonicalGateSchema,
      result: gateReceiptResult,
      setup: z.array(recordedSetupStepSchema, { error: 'must be an array of recorded setup steps' }).exactOptional(),
      started_at: canonicalTimestamp,
      ended_at: canonicalTimestamp,
      duration_ms: integer(0, 86_400_000),
      exit_status: integer(-2_147_483_648, 2_147_483_647).nullable(),
      signal: text(128).nullable(),
      head_before: commitSha,
      head_after: commitSha,
      clean_before: boolean,
      clean_after: boolean,
      output: exactObject({ stdout_sha256: sha256Digest, stderr_sha256: sha256Digest }),
      source: exactObject({
        repository: githubRepository,
        ref: rule(text(1_024), (ref) => /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref), 'must be an exact branch ref'),
        head_sha: commitSha,
        run_invocation_uri: text(1_024),
      }).superRefine((source, context) => {
        const runAttempt = new RegExp(
          `^${escapeRegExp(source.repository)}/actions/runs/[1-9][0-9]*/attempts/[1-9][0-9]*$`,
        );
        if (!runAttempt.test(source.run_invocation_uri)) {
          reject(context, ['run_invocation_uri'], 'must identify an exact GitHub Actions run attempt');
        }
      }),
      environment: exactObject({
        runner_environment: literal('github-hosted'),
        runner_os: text(128),
        runner_arch: text(128),
        node_version: text(128),
      }),
      sensor: exactObject({
        name: literal('threadloop-github-actions-gate'),
        contract_version: z.literal([1, 2], { error: 'must be 1 or 2' }),
      }),
    },
    // 1 predates declared setup and carries no `setup` key; 2 always carries one, possibly empty.
    { key: 'setup', expected: (artifact) => artifact.schema_version === 2 },
  ).superRefine((artifact, context) => {
    const violation = recordedSetupViolation(artifact.setup, artifact.gate.setup, artifact.result);
    if (violation) {
      reject(context, ['setup', ...violation.path], violation.message);
    }
    // The sensor contract and the artifact schema move together, so a v2 artifact cannot claim a v1 sensor.
    if (artifact.sensor.contract_version !== artifact.schema_version) {
      reject(context, ['sensor', 'contract_version'], `must be ${artifact.schema_version}`);
    }
  }),
);

export type SignedGateReceiptArtifact = z.infer<typeof signedGateReceiptArtifactSchema>;
export type InTotoReceiptStatement = ReturnType<typeof buildInTotoReceiptStatement>;

export interface CanonicalSignedArtifact<TArtifact> {
  artifact: TArtifact;
  json: string;
  sha256: string;
}

export type GitHubGateJobResult = 'success' | 'failure' | 'cancelled';

/** A signed package after its envelope is decoded, before its statement is bound to the artifact. */
export interface SignedEnvelope<TArtifact> {
  artifact: TArtifact;
  artifactJson: string;
  artifactSha256: string;
  statementJson: string;
  statementSha256: string;
  bundle: Record<string, unknown>;
  packageJson: string;
  packageSha256: string;
}

export interface ParsedSignedPackage<TArtifact, TStatement> extends SignedEnvelope<TArtifact> {
  statement: TStatement;
}

export type SignedReceiptEnvelope = SignedEnvelope<SignedGateReceiptArtifact>;
export type ParsedSignedReceiptPackage = ParsedSignedPackage<SignedGateReceiptArtifact, InTotoReceiptStatement>;

/**
 * What distinguishes one kind of signed receipt. Envelope decoding, statement binding, and stored-row
 * re-verification are shared, so the gate and review packages cannot drift apart.
 */
export interface SignedReceiptKind<TArtifact, TStatement> {
  schema: z.ZodType<TArtifact>;
  mediaType: (artifact: TArtifact) => string;
  buildStatement: (artifact: TArtifact, artifactSha256: string) => TStatement;
  fail: FieldErrorFactory;
  /** Names the artifact in a statement mismatch. */
  label: string;
  /**
   * Whether a statement mismatch names the first differing statement field. The import maps
   * `statement.subject*` and `statement.predicate.artifact*` fields to SIGNED_RECEIPT_ARTIFACT_MISMATCH; review
   * mismatches have always been reported at `statement`, so they stay SIGNED_RECEIPT_INVALID.
   */
  reportsStatementField: boolean;
}

/** The verified projection stored beside a signed package, which re-verification compares against. */
export interface StoredSignedPackage {
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
}

export interface StoredSignedGateReceipt extends StoredSignedPackage {
  sequence: number;
  id: string;
  sessionId: string;
  gateId: string;
  planSha256: string;
  subjectHeadSha: string;
  result: 'passed';
  packagePath: string;
  stateVersion: number;
  verifiedAt: string;
}

export type CiProofGateStatus = 'missing' | 'passed' | 'stale' | 'corrupt';

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
  status: 'policy_missing' | CiProofGateStatus;
  policy: GitHubActionsTrustPolicy | null;
  gates: CiProofGateEvidence[];
}

const gateReceiptKind: SignedReceiptKind<SignedGateReceiptArtifact, InTotoReceiptStatement> = {
  schema: signedGateReceiptArtifactSchema,
  // Pinned to the artifact's own version, so a v2 artifact cannot arrive under the v1 media type.
  mediaType: (artifact) => signedReceiptMediaType(artifact.schema_version),
  buildStatement: buildInTotoReceiptStatement,
  fail: attestationError,
  label: 'receipt',
  reportsStatementField: true,
};

export function canonicalizeSignedGateReceiptArtifact(
  value: unknown,
  digest: ProofDigest,
): CanonicalSignedArtifact<SignedGateReceiptArtifact> {
  return canonicalizeSignedArtifact(gateReceiptKind, value, digest);
}

export function authorizeGateReportForSigning(
  value: unknown,
  context: {
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
  },
): SignedGateReceiptArtifact {
  const report = parseFields(signedGateReceiptArtifactSchema, value, 'package.artifact', attestationError);
  for (const [field, actual, wanted] of [
    ['package.artifact.session_id', report.session_id, context.sessionId],
    ['package.artifact.plan_sha256', report.plan_sha256, context.planSha256],
    ['package.artifact.gate', canonicalJson(report.gate), canonicalJson(context.gate)],
    ['package.artifact.source.repository', report.source.repository, context.sourceRepository],
    ['package.artifact.source.ref', report.source.ref, context.sourceRef],
    ['package.artifact.source.head_sha', report.source.head_sha, context.sourceHeadSha],
    ['package.artifact.source.run_invocation_uri', report.source.run_invocation_uri, context.runInvocationUri],
  ] as const) {
    if (actual !== wanted) {
      throw attestationError(field, 'does not match the trusted signing context');
    }
  }

  const result = authoritativeGateResult(report, context.jobResult);
  return {
    // Spreading `report` carries recorded setup through signing unchanged, so the signed artifact keeps
    // describing exactly what the sensor observed.
    ...report,
    receipt_id: parseFields(identifier(160), context.receiptId, 'signing.receipt_id', attestationError),
    result,
    exit_status:
      result === 'passed' ? 0 : report.exit_status === 0 || report.exit_status === null ? 1 : report.exit_status,
    signal: result === 'passed' ? null : report.signal,
    environment: {
      runner_environment: 'github-hosted',
      runner_os: parseFields(text(128), context.runnerOs, 'signing.runner_os', attestationError),
      runner_arch: parseFields(text(128), context.runnerArch, 'signing.runner_arch', attestationError),
      node_version: parseFields(text(128), context.nodeVersion, 'signing.node_version', attestationError),
    },
  };
}

export function buildInTotoReceiptStatement(artifact: SignedGateReceiptArtifact, artifactSha256: string) {
  parseFields(sha256Digest, artifactSha256, 'statement.subject[1].digest.sha256', attestationError);
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [
      { name: artifact.source.repository, digest: { gitCommit: artifact.source.head_sha } },
      { name: 'threadloop-gate-receipt.json', digest: { sha256: artifactSha256 } },
    ],
    predicateType: `https://threadloop.dev/attestations/receipt/v${artifact.schema_version}`,
    predicate: {
      schema_version: artifact.schema_version,
      receipt_type: 'gate',
      session_id: artifact.session_id,
      plan_sha256: artifact.plan_sha256,
      gate_id: artifact.gate.id,
      result: artifact.result,
      subject_head_sha: artifact.source.head_sha,
      artifact: { name: 'threadloop-gate-receipt.json', sha256: artifactSha256 },
      sensor: { name: 'threadloop-github-actions-gate', contract_version: artifact.schema_version },
    },
  } as const;
}

export function parseSignedReceiptPackage(value: unknown, digest: ProofDigest): ParsedSignedReceiptPackage {
  return validateSignedReceiptStatement(parseSignedReceiptEnvelope(value, digest));
}

export function parseSignedReceiptEnvelope(value: unknown, digest: ProofDigest): SignedReceiptEnvelope {
  return parseSignedEnvelope(gateReceiptKind, value, digest);
}

export function validateSignedReceiptStatement(envelope: SignedReceiptEnvelope): ParsedSignedReceiptPackage {
  return bindSignedStatement(gateReceiptKind, envelope);
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
    return { status: 'policy_missing', policy: null, gates: proofPlan.gates.map((gate) => emptyCiGate(gate.id)) };
  }
  const policy = proofPlan.ci;
  const latestByGate = latestBy(input.receipts, (receipt) => receipt.gateId);
  const gates = proofPlan.gates.map((gate): CiProofGateEvidence => {
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
    const parsed = reverifyStoredPackage(
      gateReceiptKind,
      receipt,
      input.packageContents.get(receipt.id),
      policy,
      input.digest,
    );
    const artifact = parsed?.artifact;
    if (
      !artifact ||
      artifact.receipt_id !== receipt.id ||
      artifact.session_id !== input.sessionId ||
      artifact.gate.id !== receipt.gateId ||
      artifact.plan_sha256 !== receipt.planSha256 ||
      artifact.source.head_sha !== receipt.subjectHeadSha ||
      receipt.result !== 'passed' ||
      artifact.result !== 'passed' ||
      artifact.exit_status !== 0 ||
      artifact.signal !== null ||
      !artifact.clean_before ||
      !artifact.clean_after ||
      artifact.head_before !== receipt.subjectHeadSha ||
      artifact.head_after !== receipt.subjectHeadSha ||
      canonicalJson(artifact.gate) !== canonicalJson(gate) ||
      recordedSetupViolation(artifact.setup, gate.setup, artifact.result)
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

  return { status: aggregateGateStatus(gates.map((gate) => gate.status)), policy, gates };
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
    throw attestationError(
      'package.artifact.result',
      'cannot be passed because the captured gate report is not a clean pass',
    );
  }
  return 'passed';
}

export function canonicalizeSignedArtifact<TArtifact>(
  kind: SignedReceiptKind<TArtifact, unknown>,
  value: unknown,
  digest: ProofDigest,
): CanonicalSignedArtifact<TArtifact> {
  const artifact = parseFields(kind.schema, value, 'package.artifact', kind.fail);
  const json = canonicalJson(artifact);
  return { artifact, json, sha256: digest(json) };
}

const packageKeysSchema = exactObject({ media_type: z.unknown(), artifact: z.unknown(), bundle: z.unknown() });

/**
 * Node's base64 decoder skips characters outside the alphabet and accepts URL-safe ones, so only a string that
 * re-encodes to itself is known to carry exactly the bytes it appears to.
 */
const bundleSchema = z.looseObject(
  {
    dsseEnvelope: z.looseObject(
      {
        payloadType: literal(IN_TOTO_PAYLOAD_TYPE),
        payload: rule(
          text(16_000_000),
          (payload) => Buffer.from(payload, 'base64').toString('base64') === payload,
          'must be canonical base64',
        ),
      },
      { error: 'must be an object' },
    ),
  },
  { error: 'must be an object' },
);

/** Decodes a signed package's envelope and canonicalizes its artifact. The statement is bound separately. */
export function parseSignedEnvelope<TArtifact>(
  kind: SignedReceiptKind<TArtifact, unknown>,
  value: unknown,
  digest: ProofDigest,
): SignedEnvelope<TArtifact> {
  const receiptPackage = parseFields(packageKeysSchema, value, 'package', kind.fail);
  const canonicalArtifact = canonicalizeSignedArtifact(kind, receiptPackage.artifact, digest);
  const mediaType = kind.mediaType(canonicalArtifact.artifact);
  if (receiptPackage.media_type !== mediaType) {
    throw kind.fail('package.media_type', `must be ${mediaType}`);
  }
  const envelope = parseFields(bundleSchema, receiptPackage.bundle, 'package.bundle', kind.fail).dsseEnvelope;
  const bundle = receiptPackage.bundle as Record<string, unknown>;
  const statementBytes = Buffer.from(envelope.payload, 'base64');
  const statementJson = statementBytes.toString('utf8');
  // Decoding replaces invalid UTF-8 with U+FFFD. Without this check the statement text, and the digest stored
  // for it, could describe bytes other than the ones that were signed.
  if (!Buffer.from(statementJson, 'utf8').equals(statementBytes)) {
    throw kind.fail('package.bundle.dsseEnvelope.payload', 'must encode UTF-8 text');
  }
  const packageJson = canonicalJson({ media_type: mediaType, artifact: canonicalArtifact.artifact, bundle });
  return {
    artifact: canonicalArtifact.artifact,
    artifactJson: canonicalArtifact.json,
    artifactSha256: canonicalArtifact.sha256,
    statementJson,
    statementSha256: digest(statementJson),
    bundle,
    packageJson,
    packageSha256: digest(packageJson),
  };
}

/** Requires the signed statement to be exactly, byte for byte, the statement the canonical artifact implies. */
export function bindSignedStatement<TArtifact, TStatement>(
  kind: SignedReceiptKind<TArtifact, TStatement>,
  envelope: SignedEnvelope<TArtifact>,
): ParsedSignedPackage<TArtifact, TStatement> {
  let statement: unknown;
  try {
    statement = JSON.parse(envelope.statementJson) as unknown;
  } catch {
    throw kind.fail('package.bundle.dsseEnvelope.payload', 'must encode a JSON statement');
  }
  if (canonicalJson(statement) !== envelope.statementJson) {
    throw kind.fail('package.bundle.dsseEnvelope.payload', 'must encode canonical JSON');
  }
  const expected = kind.buildStatement(envelope.artifact, envelope.artifactSha256);
  const difference = firstDifference(statement, expected);
  if (difference && kind.reportsStatementField) {
    throw kind.fail(
      `statement${difference.path}`,
      difference.expected === null
        ? `does not exactly bind the canonical ${kind.label} artifact`
        : `must be ${difference.expected}`,
    );
  }
  if (difference) {
    throw kind.fail('statement', `does not exactly bind the canonical ${kind.label} artifact`);
  }
  return { ...envelope, statement: expected };
}

/**
 * Re-parses a stored package and checks it against the verified projection stored beside it and against the
 * plan's immutable policy, without repeating Sigstore verification. Null when anything disagrees.
 */
export function reverifyStoredPackage<
  TArtifact extends { source: { repository: string; ref: string; run_invocation_uri: string } },
  TStatement,
>(
  kind: SignedReceiptKind<TArtifact, TStatement>,
  stored: StoredSignedPackage,
  packageJson: string | null | undefined,
  policy: GitHubActionsTrustPolicy,
  digest: ProofDigest,
): ParsedSignedPackage<TArtifact, TStatement> | null {
  if (!packageJson || digest(packageJson) !== stored.packageSha256) {
    return null;
  }
  let parsed: ParsedSignedPackage<TArtifact, TStatement>;
  try {
    parsed = bindSignedStatement(kind, parseSignedEnvelope(kind, JSON.parse(packageJson) as unknown, digest));
  } catch {
    return null;
  }
  const source = parsed.artifact.source;
  const matches =
    parsed.packageJson === packageJson &&
    parsed.packageSha256 === stored.packageSha256 &&
    parsed.artifactJson === stored.artifactJson &&
    parsed.artifactSha256 === stored.artifactSha256 &&
    parsed.statementJson === stored.statementJson &&
    parsed.statementSha256 === stored.statementSha256 &&
    stored.issuer === policy.issuer &&
    stored.certificateIdentity === policy.certificate_identity &&
    stored.buildSignerUri === policy.build_signer_uri &&
    stored.buildSignerSha === policy.build_signer_sha &&
    stored.sourceRepository === policy.source_repository &&
    source.repository === stored.sourceRepository &&
    source.ref === stored.sourceRef &&
    source.run_invocation_uri === stored.runInvocationUri;
  return matches ? parsed : null;
}

/**
 * The first value in `actual` that differs from `expected`, with its path and the scalar it should have been, or
 * null when the two are equal. `expected` is null when the difference is in shape rather than in one value.
 */
function firstDifference(
  actual: unknown,
  expected: unknown,
  path = '',
): { path: string; expected: string | number | null } | null {
  if (typeof expected === 'string' || typeof expected === 'number') {
    return actual === expected ? null : { path, expected };
  }
  if (typeof expected !== 'object' || expected === null) {
    return actual === expected ? null : { path, expected: null };
  }
  const expectedKeys = Object.keys(expected);
  const sameShape =
    typeof actual === 'object' &&
    actual !== null &&
    Array.isArray(actual) === Array.isArray(expected) &&
    Object.keys(actual).length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(actual, key));
  if (!sameShape) {
    return { path, expected: null };
  }
  for (const key of expectedKeys) {
    const difference = firstDifference(
      (actual as Record<string, unknown>)[key],
      (expected as Record<string, unknown>)[key],
      Array.isArray(expected) ? `${path}[${key}]` : `${path}.${key}`,
    );
    if (difference) {
      return difference;
    }
  }
  return null;
}
