import { canonicalJson } from './canonical-json.js';
import { hasReviewTrustPolicy, type BoundProofPlan, type ProofDigest } from './proof.js';

export const SIGNED_REVIEW_RECEIPT_MEDIA_TYPE = 'application/vnd.threadloop.signed-review-receipt.v1+json';
export const REVIEW_IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
export const REVIEW_IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
export const THREADLOOP_REVIEW_PREDICATE_TYPE = 'https://threadloop.dev/attestations/review/v1';

export type ReviewEvidenceStatus = 'policy_missing' | 'missing' | 'current' | 'stale' | 'corrupt';

export interface ReviewFinding {
  id: string;
  url: string;
  author: string | null;
  body: string;
  path: string | null;
  line: number | null;
  resolved: boolean;
  outdated: boolean;
}

export interface ReviewApproval {
  actorId: string;
  actorLogin?: string;
  actorType: string;
  state: 'APPROVED';
  commitSha: string;
  submittedAt?: string;
}

export interface ReviewEvidence {
  status: ReviewEvidenceStatus;
  snapshotId: string | null;
  headSha: string | null;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  blockingFindings: ReviewFinding[];
  approvals: ReviewApproval[];
  merged: boolean;
  mergedAt: string | null;
}

export interface SignedReviewReceiptArtifact {
  schema_version: 1;
  receipt_id: string;
  session_id: string;
  plan_sha256: string;
  pull_request: {
    number: number;
    url: string;
    head_sha: string;
    base_ref: string;
    merged: boolean;
    merged_at: string | null;
  };
  review: {
    decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
    approvals: Array<{
      actor_id: string;
      actor_login: string;
      actor_type: string;
      state: 'APPROVED';
      commit_sha: string;
      submitted_at: string;
    }>;
    threads: Array<{
      id: string;
      url: string;
      author_login: string | null;
      author_type: string | null;
      body: string;
      path: string | null;
      line: number | null;
      resolved: boolean;
      outdated: boolean;
      created_at: string;
      updated_at: string;
    }>;
  };
  observed_at: string;
  source: {
    repository: string;
    ref: string;
    head_sha: string;
    run_invocation_uri: string;
  };
  sensor: {
    name: 'threadloop-github-actions-review';
    contract_version: 1;
  };
}

export interface InTotoReviewStatement {
  _type: typeof REVIEW_IN_TOTO_STATEMENT_TYPE;
  subject: [
    { name: string; digest: { gitCommit: string } },
    { name: 'threadloop-review-snapshot.json'; digest: { sha256: string } },
  ];
  predicateType: typeof THREADLOOP_REVIEW_PREDICATE_TYPE;
  predicate: {
    schema_version: 1;
    receipt_type: 'review';
    session_id: string;
    plan_sha256: string;
    pull_request_number: number;
    subject_head_sha: string;
    artifact: {
      name: 'threadloop-review-snapshot.json';
      sha256: string;
    };
    sensor: {
      name: 'threadloop-github-actions-review';
      contract_version: 1;
    };
  };
}

export interface CanonicalSignedReviewReceiptArtifact {
  artifact: SignedReviewReceiptArtifact;
  json: string;
  sha256: string;
}

export interface ReviewReportSigningContext {
  receiptId: string;
  sessionId: string;
  planSha256: string;
  pullRequestNumber: number;
  sourceRepository: string;
  sourceRef: string;
  sourceHeadSha: string;
  runInvocationUri: string;
}

export interface SignedReviewReceiptEnvelope extends CanonicalSignedReviewReceiptArtifact {
  artifactJson: string;
  artifactSha256: string;
  statementJson: string;
  statementSha256: string;
  bundle: Record<string, unknown>;
  packageJson: string;
  packageSha256: string;
}

export interface ParsedSignedReviewReceiptPackage extends SignedReviewReceiptEnvelope {
  statement: InTotoReviewStatement;
}

export interface StoredSignedReviewReceipt {
  sequence: number;
  id: string;
  sessionId: string;
  planSha256: string;
  pullRequestNumber: number;
  subjectHeadSha: string;
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

export class ReviewValidationError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field} ${message}.`);
    this.name = 'ReviewValidationError';
    this.field = field;
  }
}

export function canonicalizeSignedReviewReceiptArtifact(
  value: unknown,
  digest: ProofDigest,
): CanonicalSignedReviewReceiptArtifact {
  const artifact = validateSignedReviewReceiptArtifact(value);
  const json = canonicalJson(artifact);
  return { artifact, json, sha256: digest(json) };
}

export function buildInTotoReviewStatement(
  artifact: SignedReviewReceiptArtifact,
  artifactSha256: string,
): InTotoReviewStatement {
  requireSha(artifactSha256, 'statement.subject[1].digest.sha256', 64);
  return {
    _type: REVIEW_IN_TOTO_STATEMENT_TYPE,
    subject: [
      {
        name: artifact.source.repository,
        digest: { gitCommit: artifact.pull_request.head_sha },
      },
      {
        name: 'threadloop-review-snapshot.json',
        digest: { sha256: artifactSha256 },
      },
    ],
    predicateType: THREADLOOP_REVIEW_PREDICATE_TYPE,
    predicate: {
      schema_version: 1,
      receipt_type: 'review',
      session_id: artifact.session_id,
      plan_sha256: artifact.plan_sha256,
      pull_request_number: artifact.pull_request.number,
      subject_head_sha: artifact.pull_request.head_sha,
      artifact: {
        name: 'threadloop-review-snapshot.json',
        sha256: artifactSha256,
      },
      sensor: {
        name: 'threadloop-github-actions-review',
        contract_version: 1,
      },
    },
  };
}

export function authorizeReviewReportForSigning(
  value: unknown,
  context: ReviewReportSigningContext,
): SignedReviewReceiptArtifact {
  const report = validateSignedReviewReceiptArtifact(value);
  const expected = {
    session_id: context.sessionId,
    plan_sha256: context.planSha256,
    pull_request_number: context.pullRequestNumber,
    source_repository: context.sourceRepository,
    source_ref: context.sourceRef,
    source_head_sha: context.sourceHeadSha,
    run_invocation_uri: context.runInvocationUri,
  };
  for (const [field, actual, wanted] of [
    ['package.artifact.session_id', report.session_id, expected.session_id],
    ['package.artifact.plan_sha256', report.plan_sha256, expected.plan_sha256],
    ['package.artifact.pull_request.number', report.pull_request.number, expected.pull_request_number],
    ['package.artifact.source.repository', report.source.repository, expected.source_repository],
    ['package.artifact.source.ref', report.source.ref, expected.source_ref],
    ['package.artifact.source.head_sha', report.source.head_sha, expected.source_head_sha],
    ['package.artifact.source.run_invocation_uri', report.source.run_invocation_uri, expected.run_invocation_uri],
  ] as const) {
    if (actual !== wanted) {
      throw invalid(field, 'does not match the trusted signing context');
    }
  }

  return {
    ...report,
    receipt_id: identifier(context.receiptId, 'signing.receipt_id'),
  };
}

export function parseSignedReviewReceiptEnvelope(value: unknown, digest: ProofDigest): SignedReviewReceiptEnvelope {
  const receiptPackage = exactObject(value, 'package', ['media_type', 'artifact', 'bundle']);
  if (receiptPackage.media_type !== SIGNED_REVIEW_RECEIPT_MEDIA_TYPE) {
    throw invalid('package.media_type', `must be ${SIGNED_REVIEW_RECEIPT_MEDIA_TYPE}`);
  }
  const canonicalArtifact = canonicalizeSignedReviewReceiptArtifact(receiptPackage.artifact, digest);
  const bundle = object(receiptPackage.bundle, 'package.bundle');
  const envelope = object(bundle.dsseEnvelope, 'package.bundle.dsseEnvelope');
  if (envelope.payloadType !== REVIEW_IN_TOTO_PAYLOAD_TYPE) {
    throw invalid('package.bundle.dsseEnvelope.payloadType', `must be ${REVIEW_IN_TOTO_PAYLOAD_TYPE}`);
  }
  const payload = text(envelope.payload, 'package.bundle.dsseEnvelope.payload', 16_000_000);
  if (!isCanonicalBase64(payload)) {
    throw invalid('package.bundle.dsseEnvelope.payload', 'must be canonical base64');
  }
  const statementJson = Buffer.from(payload, 'base64').toString('utf8');
  const packageValue = {
    media_type: SIGNED_REVIEW_RECEIPT_MEDIA_TYPE,
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

export function parseSignedReviewReceiptPackage(value: unknown, digest: ProofDigest): ParsedSignedReviewReceiptPackage {
  const envelope = parseSignedReviewReceiptEnvelope(value, digest);
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope.statementJson) as unknown;
  } catch {
    throw invalid('package.bundle.dsseEnvelope.payload', 'must encode a JSON statement');
  }
  if (canonicalJson(parsed) !== envelope.statementJson) {
    throw invalid('package.bundle.dsseEnvelope.payload', 'must encode canonical JSON');
  }
  return {
    ...envelope,
    statement: validateReviewStatement(parsed, envelope),
  };
}

export function reviewEvidenceFromArtifact(
  artifact: SignedReviewReceiptArtifact,
  currentHead: string | null,
): ReviewEvidence {
  const current = Boolean(currentHead && artifact.pull_request.head_sha === currentHead);
  return {
    status: current ? 'current' : 'stale',
    snapshotId: artifact.receipt_id,
    headSha: artifact.pull_request.head_sha,
    reviewDecision: artifact.review.decision,
    blockingFindings: artifact.review.threads
      .filter((thread) => !thread.resolved && !thread.outdated)
      .map((thread) => ({
        id: thread.id,
        url: thread.url,
        author: thread.author_login,
        body: thread.body,
        path: thread.path,
        line: thread.line,
        resolved: thread.resolved,
        outdated: thread.outdated,
      })),
    approvals: artifact.review.approvals.map((approval) => ({
      actorId: approval.actor_id,
      actorLogin: approval.actor_login,
      actorType: approval.actor_type,
      state: approval.state,
      commitSha: approval.commit_sha,
      submittedAt: approval.submitted_at,
    })),
    merged: artifact.pull_request.merged,
    mergedAt: artifact.pull_request.merged_at,
  };
}

export function evaluateReviewEvidence(input: {
  sessionId: string;
  plan: BoundProofPlan;
  receipts: StoredSignedReviewReceipt[];
  currentHead: string | null;
  packageContents: ReadonlyMap<string, string | null>;
  digest: ProofDigest;
}): ReviewEvidence {
  if (!hasReviewTrustPolicy(input.plan.plan)) {
    return emptyReviewEvidence('policy_missing');
  }
  const receipt = [...input.receipts].sort((left, right) => right.sequence - left.sequence)[0];
  if (!receipt) {
    return emptyReviewEvidence('missing');
  }
  const common = {
    snapshotId: receipt.id,
    headSha: receipt.subjectHeadSha,
  };
  const packageJson = input.packageContents.get(receipt.id);
  if (!packageJson || input.digest(packageJson) !== receipt.packageSha256) {
    return { ...emptyReviewEvidence('corrupt'), ...common };
  }
  let parsed: ParsedSignedReviewReceiptPackage;
  try {
    parsed = parseSignedReviewReceiptPackage(JSON.parse(packageJson) as unknown, input.digest);
  } catch {
    return { ...emptyReviewEvidence('corrupt'), ...common };
  }
  const policy = input.plan.plan.review;
  if (
    parsed.packageJson !== packageJson ||
    parsed.packageSha256 !== receipt.packageSha256 ||
    parsed.artifactJson !== receipt.artifactJson ||
    parsed.artifactSha256 !== receipt.artifactSha256 ||
    parsed.statementJson !== receipt.statementJson ||
    parsed.statementSha256 !== receipt.statementSha256 ||
    parsed.artifact.receipt_id !== receipt.id ||
    parsed.artifact.session_id !== input.sessionId ||
    parsed.artifact.plan_sha256 !== receipt.planSha256 ||
    parsed.artifact.pull_request.number !== receipt.pullRequestNumber ||
    parsed.artifact.pull_request.head_sha !== receipt.subjectHeadSha ||
    receipt.issuer !== policy.issuer ||
    receipt.certificateIdentity !== policy.certificate_identity ||
    receipt.buildSignerUri !== policy.build_signer_uri ||
    receipt.buildSignerSha !== policy.build_signer_sha ||
    receipt.sourceRepository !== policy.source_repository ||
    parsed.artifact.source.repository !== receipt.sourceRepository ||
    parsed.artifact.source.ref !== receipt.sourceRef ||
    parsed.artifact.source.run_invocation_uri !== receipt.runInvocationUri
  ) {
    return { ...emptyReviewEvidence('corrupt'), ...common };
  }
  const evidence = reviewEvidenceFromArtifact(parsed.artifact, input.currentHead);
  if (receipt.planSha256 !== input.plan.sha256) {
    return { ...evidence, status: 'stale' };
  }
  return evidence;
}

function emptyReviewEvidence(status: ReviewEvidenceStatus): ReviewEvidence {
  return {
    status,
    snapshotId: null,
    headSha: null,
    reviewDecision: null,
    blockingFindings: [],
    approvals: [],
    merged: false,
    mergedAt: null,
  };
}

export function hasBlockingReview(evidence: ReviewEvidence) {
  return evidence.reviewDecision === 'CHANGES_REQUESTED' || evidence.blockingFindings.length > 0;
}

function validateSignedReviewReceiptArtifact(value: unknown): SignedReviewReceiptArtifact {
  const artifact = exactObject(value, 'package.artifact', [
    'schema_version',
    'receipt_id',
    'session_id',
    'plan_sha256',
    'pull_request',
    'review',
    'observed_at',
    'source',
    'sensor',
  ]);
  if (artifact.schema_version !== 1) {
    throw invalid('package.artifact.schema_version', 'must be 1');
  }
  const receiptId = identifier(artifact.receipt_id, 'package.artifact.receipt_id');
  const sessionId = identifier(artifact.session_id, 'package.artifact.session_id');
  requireSha(artifact.plan_sha256, 'package.artifact.plan_sha256', 64);

  const source = exactObject(artifact.source, 'package.artifact.source', [
    'repository',
    'ref',
    'head_sha',
    'run_invocation_uri',
  ]);
  const repository = text(source.repository, 'package.artifact.source.repository', 512);
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw invalid('package.artifact.source.repository', 'must be an exact GitHub repository URI');
  }
  const sourceRef = text(source.ref, 'package.artifact.source.ref', 1_024);
  if (!/^refs\/(?:heads|pull)\/[A-Za-z0-9._/-]+$/.test(sourceRef)) {
    throw invalid('package.artifact.source.ref', 'must be a branch or pull-request ref');
  }
  const sourceHead = requireSha(source.head_sha, 'package.artifact.source.head_sha', 40);
  const runInvocationUri = text(source.run_invocation_uri, 'package.artifact.source.run_invocation_uri', 1_024);

  const pullRequest = exactObject(artifact.pull_request, 'package.artifact.pull_request', [
    'number',
    'url',
    'head_sha',
    'base_ref',
    'merged',
    'merged_at',
  ]);
  const pullRequestNumber = positiveInteger(pullRequest.number, 'package.artifact.pull_request.number');
  const pullRequestUrl = text(pullRequest.url, 'package.artifact.pull_request.url', 1_024);
  if (pullRequestUrl !== `${repository}/pull/${pullRequestNumber}`) {
    throw invalid('package.artifact.pull_request.url', 'must match the source repository and pull request number');
  }
  const pullRequestHead = requireSha(pullRequest.head_sha, 'package.artifact.pull_request.head_sha', 40);
  const baseRef = text(pullRequest.base_ref, 'package.artifact.pull_request.base_ref', 256);
  if (typeof pullRequest.merged !== 'boolean') {
    throw invalid('package.artifact.pull_request.merged', 'must be a boolean');
  }
  const mergedAt = nullableTimestamp(pullRequest.merged_at, 'package.artifact.pull_request.merged_at');
  if (pullRequest.merged !== Boolean(mergedAt)) {
    throw invalid('package.artifact.pull_request.merged_at', 'must be present exactly when merged is true');
  }

  const review = exactObject(artifact.review, 'package.artifact.review', ['decision', 'approvals', 'threads']);
  const decision =
    review.decision === null ||
    review.decision === 'APPROVED' ||
    review.decision === 'CHANGES_REQUESTED' ||
    review.decision === 'REVIEW_REQUIRED'
      ? review.decision
      : (() => {
          throw invalid('package.artifact.review.decision', 'is invalid');
        })();
  if (!Array.isArray(review.approvals)) {
    throw invalid('package.artifact.review.approvals', 'must be an array');
  }
  const approvals = review.approvals.map((value, index) => {
    const field = `package.artifact.review.approvals[${index}]`;
    const approval = exactObject(value, field, [
      'actor_id',
      'actor_login',
      'actor_type',
      'state',
      'commit_sha',
      'submitted_at',
    ]);
    if (approval.state !== 'APPROVED') {
      throw invalid(`${field}.state`, 'must be APPROVED');
    }
    return {
      actor_id: text(approval.actor_id, `${field}.actor_id`, 256),
      actor_login: text(approval.actor_login, `${field}.actor_login`, 256),
      actor_type: text(approval.actor_type, `${field}.actor_type`, 128),
      state: 'APPROVED' as const,
      commit_sha: requireSha(approval.commit_sha, `${field}.commit_sha`, 40),
      submitted_at: timestamp(approval.submitted_at, `${field}.submitted_at`),
    };
  });
  if (!Array.isArray(review.threads)) {
    throw invalid('package.artifact.review.threads', 'must be an array');
  }
  const threads = review.threads.map((value, index) => {
    const field = `package.artifact.review.threads[${index}]`;
    const thread = exactObject(value, field, [
      'id',
      'url',
      'author_login',
      'author_type',
      'body',
      'path',
      'line',
      'resolved',
      'outdated',
      'created_at',
      'updated_at',
    ]);
    if (typeof thread.resolved !== 'boolean' || typeof thread.outdated !== 'boolean') {
      throw invalid(field, 'resolved and outdated must be booleans');
    }
    return {
      id: identifier(thread.id, `${field}.id`),
      url: text(thread.url, `${field}.url`, 2_048),
      author_login: nullableText(thread.author_login, `${field}.author_login`, 256),
      author_type: nullableText(thread.author_type, `${field}.author_type`, 128),
      body: text(thread.body, `${field}.body`, 65_536),
      path: nullableText(thread.path, `${field}.path`, 4_096),
      line: nullablePositiveInteger(thread.line, `${field}.line`),
      resolved: thread.resolved,
      outdated: thread.outdated,
      created_at: timestamp(thread.created_at, `${field}.created_at`),
      updated_at: timestamp(thread.updated_at, `${field}.updated_at`),
    };
  });

  const sensor = exactObject(artifact.sensor, 'package.artifact.sensor', ['name', 'contract_version']);
  if (sensor.name !== 'threadloop-github-actions-review' || sensor.contract_version !== 1) {
    throw invalid('package.artifact.sensor', 'must identify review sensor contract version 1');
  }

  return {
    schema_version: 1,
    receipt_id: receiptId,
    session_id: sessionId,
    plan_sha256: artifact.plan_sha256 as string,
    pull_request: {
      number: pullRequestNumber,
      url: pullRequestUrl,
      head_sha: pullRequestHead,
      base_ref: baseRef,
      merged: pullRequest.merged,
      merged_at: mergedAt,
    },
    review: { decision, approvals, threads },
    observed_at: timestamp(artifact.observed_at, 'package.artifact.observed_at'),
    source: {
      repository,
      ref: sourceRef,
      head_sha: sourceHead,
      run_invocation_uri: runInvocationUri,
    },
    sensor: { name: 'threadloop-github-actions-review', contract_version: 1 },
  };
}

function validateReviewStatement(value: unknown, envelope: SignedReviewReceiptEnvelope): InTotoReviewStatement {
  const statement = exactObject(value, 'statement', ['_type', 'subject', 'predicateType', 'predicate']);
  if (
    statement._type !== REVIEW_IN_TOTO_STATEMENT_TYPE ||
    statement.predicateType !== THREADLOOP_REVIEW_PREDICATE_TYPE
  ) {
    throw invalid('statement', 'has an unsupported type');
  }
  const expected = buildInTotoReviewStatement(envelope.artifact, envelope.artifactSha256);
  if (canonicalJson(statement) !== canonicalJson(expected)) {
    throw invalid('statement', 'does not exactly bind the canonical review artifact');
  }
  return expected;
}

function exactObject(value: unknown, field: string, expectedKeys: string[]) {
  const record = object(value, field);
  const keys = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw invalid(field, `must contain exactly: ${expectedKeys.join(', ')}`);
  }
  return record;
}

function object(value: unknown, field: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(field, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, maximum: number) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum || value.includes('\0')) {
    throw invalid(field, `must be non-empty text no longer than ${maximum} characters`);
  }
  return value;
}

function nullableText(value: unknown, field: string, maximum: number) {
  return value === null ? null : text(value, field, maximum);
}

function identifier(value: unknown, field: string) {
  const result = text(value, field, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) {
    throw invalid(field, 'contains unsupported characters');
  }
  return result;
}

function requireSha(value: unknown, field: string, length: 40 | 64) {
  if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${length}}$`).test(value)) {
    throw invalid(field, `must be ${length} lowercase hexadecimal characters`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw invalid(field, 'must be a positive integer');
  }
  return value;
}

function nullablePositiveInteger(value: unknown, field: string) {
  return value === null ? null : positiveInteger(value, field);
}

function timestamp(value: unknown, field: string) {
  const result = text(value, field, 64);
  if (!Number.isFinite(Date.parse(result))) {
    throw invalid(field, 'must be an ISO timestamp');
  }
  return result;
}

function nullableTimestamp(value: unknown, field: string) {
  return value === null ? null : timestamp(value, field);
}

function isCanonicalBase64(value: string) {
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}

function invalid(field: string, message: string) {
  return new ReviewValidationError(field, message);
}

export function hasCurrentHumanApproval(evidence: ReviewEvidence) {
  return Boolean(
    evidence.headSha &&
    evidence.approvals.some(
      (approval) =>
        approval.actorType === 'User' && approval.state === 'APPROVED' && approval.commitSha === evidence.headSha,
    ),
  );
}
