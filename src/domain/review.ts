import { z } from 'zod';
import {
  bindSignedStatement,
  canonicalizeSignedArtifact,
  IN_TOTO_STATEMENT_TYPE,
  parseSignedEnvelope,
  reverifyStoredPackage,
  type CanonicalSignedArtifact,
  type ParsedSignedPackage,
  type SignedEnvelope,
  type SignedReceiptKind,
  type StoredSignedPackage,
} from './attestation.js';
import { hasReviewTrustPolicy, type BoundProofPlan, type ProofDigest } from './proof.js';
import {
  boolean,
  commitSha,
  exactObject,
  githubRepository,
  identifier,
  literal,
  parsableTimestamp,
  parseFields,
  reject,
  positiveInteger,
  rule,
  sha256Digest,
  text,
  type FieldErrorFactory,
} from './validation.js';

export const SIGNED_REVIEW_RECEIPT_MEDIA_TYPE = 'application/vnd.threadloop.signed-review-receipt.v1+json';

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

/** GitHub node ids; unlike ThreadLoop's own identifiers they may contain `:`. */
const REVIEW_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const signedReviewReceiptArtifactSchema = exactObject({
  schema_version: literal(1),
  receipt_id: identifier(256, REVIEW_IDENTIFIER),
  session_id: identifier(256, REVIEW_IDENTIFIER),
  plan_sha256: sha256Digest,
  pull_request: exactObject({
    number: positiveInteger,
    url: text(1_024),
    head_sha: commitSha,
    base_ref: text(256),
    merged: boolean,
    merged_at: parsableTimestamp.nullable(),
  }),
  review: exactObject({
    decision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'], { error: 'is invalid' }).nullable(),
    approvals: z.array(
      exactObject({
        actor_id: text(256),
        actor_login: text(256),
        actor_type: text(128),
        state: literal('APPROVED'),
        commit_sha: commitSha,
        submitted_at: parsableTimestamp,
      }),
      { error: 'must be an array' },
    ),
    threads: z.array(
      exactObject({
        id: identifier(256, REVIEW_IDENTIFIER),
        url: text(2_048),
        author_login: text(256).nullable(),
        author_type: text(128).nullable(),
        body: text(65_536),
        path: text(4_096).nullable(),
        line: positiveInteger.nullable(),
        resolved: boolean,
        outdated: boolean,
        created_at: parsableTimestamp,
        updated_at: parsableTimestamp,
      }),
      { error: 'must be an array' },
    ),
  }),
  observed_at: parsableTimestamp,
  source: exactObject({
    repository: githubRepository,
    ref: rule(
      text(1_024),
      (ref) => /^refs\/(?:heads|pull)\/[A-Za-z0-9._/-]+$/.test(ref),
      'must be a branch or pull-request ref',
    ),
    head_sha: commitSha,
    run_invocation_uri: text(1_024),
  }),
  sensor: exactObject({ name: literal('threadloop-github-actions-review'), contract_version: literal(1) }),
}).superRefine((artifact, context) => {
  const pullRequest = artifact.pull_request;
  if (pullRequest.url !== `${artifact.source.repository}/pull/${pullRequest.number}`) {
    reject(context, ['pull_request', 'url'], 'must match the source repository and pull request number');
  }
  if (pullRequest.merged !== Boolean(pullRequest.merged_at)) {
    reject(context, ['pull_request', 'merged_at'], 'must be present exactly when merged is true');
  }
});

export type SignedReviewReceiptArtifact = z.infer<typeof signedReviewReceiptArtifactSchema>;
type InTotoReviewStatement = ReturnType<typeof buildInTotoReviewStatement>;
export type SignedReviewReceiptEnvelope = SignedEnvelope<SignedReviewReceiptArtifact>;
export type ParsedSignedReviewReceiptPackage = ParsedSignedPackage<SignedReviewReceiptArtifact, InTotoReviewStatement>;

export interface StoredSignedReviewReceipt extends StoredSignedPackage {
  sequence: number;
  id: string;
  sessionId: string;
  planSha256: string;
  pullRequestNumber: number;
  subjectHeadSha: string;
  packagePath: string;
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

const reviewValidationError: FieldErrorFactory = (field, detail) => new ReviewValidationError(field, detail);

const reviewReceiptKind: SignedReceiptKind<SignedReviewReceiptArtifact, InTotoReviewStatement> = {
  schema: signedReviewReceiptArtifactSchema,
  mediaType: () => SIGNED_REVIEW_RECEIPT_MEDIA_TYPE,
  buildStatement: buildInTotoReviewStatement,
  fail: reviewValidationError,
  label: 'review',
  reportsStatementField: false,
};

export function canonicalizeSignedReviewReceiptArtifact(
  value: unknown,
  digest: ProofDigest,
): CanonicalSignedArtifact<SignedReviewReceiptArtifact> {
  return canonicalizeSignedArtifact(reviewReceiptKind, value, digest);
}

export function buildInTotoReviewStatement(artifact: SignedReviewReceiptArtifact, artifactSha256: string) {
  parseFields(sha256Digest, artifactSha256, 'statement.subject[1].digest.sha256', reviewValidationError);
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [
      { name: artifact.source.repository, digest: { gitCommit: artifact.pull_request.head_sha } },
      { name: 'threadloop-review-snapshot.json', digest: { sha256: artifactSha256 } },
    ],
    predicateType: 'https://threadloop.dev/attestations/review/v1',
    predicate: {
      schema_version: 1,
      receipt_type: 'review',
      session_id: artifact.session_id,
      plan_sha256: artifact.plan_sha256,
      pull_request_number: artifact.pull_request.number,
      subject_head_sha: artifact.pull_request.head_sha,
      artifact: { name: 'threadloop-review-snapshot.json', sha256: artifactSha256 },
      sensor: { name: 'threadloop-github-actions-review', contract_version: 1 },
    },
  } as const;
}

export function authorizeReviewReportForSigning(
  value: unknown,
  context: {
    receiptId: string;
    sessionId: string;
    planSha256: string;
    pullRequestNumber: number;
    sourceRepository: string;
    sourceRef: string;
    sourceHeadSha: string;
    runInvocationUri: string;
  },
): SignedReviewReceiptArtifact {
  const report = parseFields(signedReviewReceiptArtifactSchema, value, 'package.artifact', reviewValidationError);
  for (const [field, actual, wanted] of [
    ['package.artifact.session_id', report.session_id, context.sessionId],
    ['package.artifact.plan_sha256', report.plan_sha256, context.planSha256],
    ['package.artifact.pull_request.number', report.pull_request.number, context.pullRequestNumber],
    ['package.artifact.source.repository', report.source.repository, context.sourceRepository],
    ['package.artifact.source.ref', report.source.ref, context.sourceRef],
    ['package.artifact.source.head_sha', report.source.head_sha, context.sourceHeadSha],
    ['package.artifact.source.run_invocation_uri', report.source.run_invocation_uri, context.runInvocationUri],
  ] as const) {
    if (actual !== wanted) {
      throw reviewValidationError(field, 'does not match the trusted signing context');
    }
  }
  return {
    ...report,
    receipt_id: parseFields(
      identifier(256, REVIEW_IDENTIFIER),
      context.receiptId,
      'signing.receipt_id',
      reviewValidationError,
    ),
  };
}

export function parseSignedReviewReceiptEnvelope(value: unknown, digest: ProofDigest): SignedReviewReceiptEnvelope {
  return parseSignedEnvelope(reviewReceiptKind, value, digest);
}

export function parseSignedReviewReceiptPackage(value: unknown, digest: ProofDigest): ParsedSignedReviewReceiptPackage {
  return bindSignedStatement(reviewReceiptKind, parseSignedReviewReceiptEnvelope(value, digest));
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
  const parsed = reverifyStoredPackage(
    reviewReceiptKind,
    receipt,
    input.packageContents.get(receipt.id),
    input.plan.plan.review,
    input.digest,
  );
  const artifact = parsed?.artifact;
  if (
    !artifact ||
    artifact.receipt_id !== receipt.id ||
    artifact.session_id !== input.sessionId ||
    artifact.plan_sha256 !== receipt.planSha256 ||
    artifact.pull_request.number !== receipt.pullRequestNumber ||
    artifact.pull_request.head_sha !== receipt.subjectHeadSha
  ) {
    return { ...emptyReviewEvidence('corrupt'), snapshotId: receipt.id, headSha: receipt.subjectHeadSha };
  }
  const evidence = reviewEvidenceFromArtifact(artifact, input.currentHead);
  return receipt.planSha256 === input.plan.sha256 ? evidence : { ...evidence, status: 'stale' };
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

export function hasCurrentHumanApproval(evidence: ReviewEvidence) {
  return Boolean(
    evidence.headSha &&
    evidence.approvals.some(
      (approval) =>
        approval.actorType === 'User' && approval.state === 'APPROVED' && approval.commitSha === evidence.headSha,
    ),
  );
}
