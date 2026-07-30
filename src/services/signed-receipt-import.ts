import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { sha256 } from '../adapters/crypto/sha256.js';
import {
  SigstoreReceiptVerificationError,
  verifySigstoreReceipt,
  type VerifiedSigstoreSigner,
} from '../adapters/crypto/sigstore.js';
import {
  appendSignedGateReceipt,
  appendSignedReviewReceipt,
  AuditChainCorruptedError,
  readConfig,
  readSessionLifecycleReadOnly,
  readSessionProofEvidenceReadOnly,
  requiresExplicitInitMigration,
  SessionTransitionHistoryCorruptedError,
  SignedReceiptAppendConflictError,
  SignedReviewReceiptAppendConflictError,
} from '../adapters/fs/sqlite-store.js';
import { isThreadloopInitialized } from '../adapters/fs/repo.js';
import { observeProofRepository, observeRepository, resolveRepoRoot } from '../adapters/git/client.js';
import { ThreadloopError } from '../contracts/errors.js';
import {
  AttestationValidationError,
  parseSignedReceiptEnvelope,
  validateSignedReceiptStatement,
  type ParsedSignedReceiptPackage,
  type SignedReceiptEnvelope,
} from '../domain/attestation.js';
import { canonicalJson } from '../domain/canonical-json.js';
import {
  canonicalizeProofPlan,
  hasCiTrustPolicy,
  hasReviewTrustPolicy,
  type BoundProofPlan,
  type GitHubActionsTrustPolicy,
} from '../domain/proof.js';
import {
  parseSignedReviewReceiptEnvelope,
  parseSignedReviewReceiptPackage,
  ReviewValidationError,
  type ParsedSignedReviewReceiptPackage,
  type SignedReviewReceiptEnvelope,
} from '../domain/review.js';
import { TASK_STATUS } from '../domain/types.js';
import { mapAuditChainCorruption } from './audit-service-errors.js';
import { MAX_SIGNED_RECEIPT_PACKAGE_BYTES, type SignedReceiptFileSystem } from './signed-receipt-files.js';

export interface SignedReceiptImportInput {
  cwd: string;
  sessionId: string;
  packagePath: string;
  verifyReceipt?: typeof verifySigstoreReceipt;
  receiptFileSystem: SignedReceiptFileSystem;
}

export interface ImportedSignedGateReceipt {
  repoRoot: string;
  lifecycle: { state: string; stateVersion: number };
  receipt: ParsedSignedReceiptPackage;
  signer: VerifiedSigstoreSigner;
  sequence: number;
  alreadyImported: boolean;
  verifiedAt: string;
  packagePath: string;
}

export interface ImportedSignedReviewReceipt {
  repoRoot: string;
  lifecycle: { state: string; stateVersion: number };
  receipt: ParsedSignedReviewReceiptPackage;
  signer: VerifiedSigstoreSigner;
  sequence: number;
  alreadyImported: boolean;
  verifiedAt: string;
  packagePath: string;
}

type ImportKind = 'gate' | 'review';
type ImportEnvelope = SignedReceiptEnvelope | SignedReviewReceiptEnvelope;

interface PreparedImport<TEnvelope extends ImportEnvelope> {
  repoRoot: string;
  lifecycle: NonNullable<ReturnType<typeof readSessionLifecycleReadOnly>>;
  plan: BoundProofPlan;
  packageValue: unknown;
  envelope: TEnvelope;
  fileSystem: SignedReceiptFileSystem;
}

export async function importSignedGateReceiptPackage(
  input: SignedReceiptImportInput,
): Promise<ImportedSignedGateReceipt> {
  const prepared = await prepareImport(input, 'gate', parseSignedReceiptEnvelope);
  if (!hasCiTrustPolicy(prepared.plan.plan)) {
    throw new ThreadloopError(
      'SIGNED_RECEIPT_IDENTITY_MISMATCH',
      'This session has no immutable signed-CI trust policy. Start a new session with a v3 proof plan.',
    );
  }

  const artifact = prepared.envelope.artifact;
  const gate = prepared.plan.plan.gates.find((candidate) => candidate.id === artifact.gate.id);
  const repository = await observeRepository(prepared.repoRoot);
  const proofRepository = await observeProofRepository(prepared.repoRoot);
  const expectedRepository = githubRepositoryUri(repository);
  const signer = await verifySigner(prepared.envelope, prepared.plan.plan.ci, input.verifyReceipt);
  let receipt: ParsedSignedReceiptPackage;
  try {
    receipt = validateSignedReceiptStatement(prepared.envelope);
  } catch (error) {
    throw mapSignedReceiptParseError(error);
  }
  assertSignerProjection(signer, artifact.source, prepared.plan.plan.ci, 'CI');
  assertSignedGateContext({
    requestedSessionId: input.sessionId,
    plan: prepared.plan,
    expectedRepository,
    currentBranch: proofRepository.branch,
    currentHead: proofRepository.headSha,
    receipt,
    gate,
    policy: prepared.plan.plan.ci,
  });
  if (
    artifact.result !== 'passed' ||
    artifact.exit_status !== 0 ||
    artifact.signal !== null ||
    artifact.head_before !== artifact.head_after ||
    !artifact.clean_before ||
    !artifact.clean_after
  ) {
    throw new ThreadloopError(
      'SIGNED_RECEIPT_RESULT_REJECTED',
      'Only a clean, unchanged, passing CI gate receipt is authoritative proof.',
      { details: { receipt_id: artifact.receipt_id, result: artifact.result } },
    );
  }

  const verifiedAt = new Date().toISOString();
  try {
    const persisted = await persistControlledPackage({
      prepared,
      receiptId: artifact.receipt_id,
      sessionId: artifact.session_id,
      fileName: 'signed-receipt.json',
      packageJson: receipt.packageJson,
      packageSha256: receipt.packageSha256,
      append: (packagePath, promotePackage) =>
        appendSignedGateReceipt(prepared.repoRoot, {
          receipt,
          signer,
          packagePath,
          stateVersion: prepared.lifecycle.stateVersion,
          verifiedAt,
          promotePackage,
        }),
    });
    return {
      repoRoot: prepared.repoRoot,
      lifecycle: { state: prepared.lifecycle.state, stateVersion: prepared.lifecycle.stateVersion },
      receipt,
      signer,
      sequence: persisted.sequence,
      alreadyImported: persisted.alreadyImported,
      verifiedAt: persisted.verifiedAt,
      packagePath: persisted.packagePath,
    };
  } catch (error) {
    if (error instanceof AuditChainCorruptedError) {
      throw mapAuditChainCorruption(input.sessionId, error);
    }
    if (error instanceof SessionTransitionHistoryCorruptedError) {
      throw mapTransitionHistoryCorruption(error);
    }
    if (error instanceof SignedReceiptAppendConflictError) {
      throw new ThreadloopError('SIGNED_RECEIPT_CONFLICT', error.message, { cause: error });
    }
    if (isErrorCode(error, 'EEXIST')) {
      throw new ThreadloopError(
        'SIGNED_RECEIPT_CONFLICT',
        `Signed receipt ${artifact.receipt_id} already has an unindexed package at its controlled path.`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function importSignedReviewReceiptPackage(
  input: SignedReceiptImportInput,
): Promise<ImportedSignedReviewReceipt> {
  const prepared = await prepareImport(input, 'review', parseSignedReviewReceiptEnvelope);
  if (!hasReviewTrustPolicy(prepared.plan.plan)) {
    throw new ThreadloopError(
      'SIGNED_RECEIPT_IDENTITY_MISMATCH',
      'This session has no immutable signed-review trust policy. Start a new session with a v3 proof plan.',
    );
  }

  const artifact = prepared.envelope.artifact;
  const repository = await observeRepository(prepared.repoRoot);
  const proofRepository = await observeProofRepository(prepared.repoRoot);
  const expectedRepository = githubRepositoryUri(repository);
  const signer = await verifySigner(prepared.envelope, prepared.plan.plan.review, input.verifyReceipt);
  let receipt: ParsedSignedReviewReceiptPackage;
  try {
    receipt = parseSignedReviewReceiptPackage(prepared.packageValue, sha256);
  } catch (error) {
    throw mapSignedReceiptParseError(error);
  }
  assertSignerProjection(signer, artifact.source, prepared.plan.plan.review, 'review');
  assertSignedReviewContext({
    requestedSessionId: input.sessionId,
    plan: prepared.plan,
    expectedRepository,
    currentHead: proofRepository.headSha,
    receipt,
    policy: prepared.plan.plan.review,
  });

  const verifiedAt = new Date().toISOString();
  try {
    const persisted = await persistControlledPackage({
      prepared,
      receiptId: artifact.receipt_id,
      sessionId: artifact.session_id,
      fileName: 'signed-review-receipt.json',
      packageJson: receipt.packageJson,
      packageSha256: receipt.packageSha256,
      append: (packagePath, promotePackage) =>
        appendSignedReviewReceipt(prepared.repoRoot, {
          receipt,
          signer,
          packagePath,
          stateVersion: prepared.lifecycle.stateVersion,
          verifiedAt,
          promotePackage,
        }),
    });
    return {
      repoRoot: prepared.repoRoot,
      lifecycle: { state: prepared.lifecycle.state, stateVersion: prepared.lifecycle.stateVersion },
      receipt,
      signer,
      sequence: persisted.sequence,
      alreadyImported: persisted.alreadyImported,
      verifiedAt: persisted.verifiedAt,
      packagePath: persisted.packagePath,
    };
  } catch (error) {
    if (error instanceof AuditChainCorruptedError) {
      throw mapAuditChainCorruption(input.sessionId, error);
    }
    if (error instanceof SessionTransitionHistoryCorruptedError) {
      throw mapTransitionHistoryCorruption(error);
    }
    if (error instanceof SignedReviewReceiptAppendConflictError) {
      throw new ThreadloopError('SIGNED_RECEIPT_CONFLICT', error.message, { cause: error });
    }
    if (isErrorCode(error, 'EEXIST')) {
      throw new ThreadloopError(
        'SIGNED_RECEIPT_CONFLICT',
        `Signed review receipt ${artifact.receipt_id} already has an unindexed package at its controlled path.`,
        { cause: error },
      );
    }
    throw error;
  }
}

function mapTransitionHistoryCorruption(error: SessionTransitionHistoryCorruptedError) {
  return new ThreadloopError('STATE_CORRUPTED', error.message, {
    cause: error,
    details: {
      session_id: error.sessionId,
      hint: 'Restore transition history from trusted storage before retrying the receipt import.',
    },
  });
}

async function prepareImport<TEnvelope extends ImportEnvelope>(
  input: SignedReceiptImportInput,
  kind: ImportKind,
  parseEnvelope: (value: unknown, digest: typeof sha256) => TEnvelope,
): Promise<PreparedImport<TEnvelope>> {
  const repoRoot = await resolveRepositoryRoot(input.cwd);
  await assertInitializedReadOnly(repoRoot);
  let lifecycle: ReturnType<typeof readSessionLifecycleReadOnly>;
  try {
    lifecycle = readSessionLifecycleReadOnly(repoRoot, input.sessionId);
  } catch (error) {
    if (error instanceof AuditChainCorruptedError) {
      throw mapAuditChainCorruption(input.sessionId, error, 'Restore the ledger from trusted storage.');
    }
    if (error instanceof SessionTransitionHistoryCorruptedError) {
      throw mapTransitionHistoryCorruption(error);
    }
    throw error;
  }
  if (!lifecycle) {
    throw new ThreadloopError('SESSION_NOT_FOUND', `Could not find session: ${input.sessionId}`, {
      details: { session_id: input.sessionId },
    });
  }
  if (requiresExplicitInitMigration(lifecycle.schemaVersion)) {
    throw new ThreadloopError(
      'SESSION_SCHEMA_MIGRATION_REQUIRED',
      `ThreadLoop schema v${lifecycle.schemaVersion} requires explicit migration before receipt import.`,
      {
        details: {
          session_id: input.sessionId,
          storage_schema_version: lifecycle.schemaVersion,
          hint: 'Run `threadloop init`, then retry the receipt import.',
        },
      },
    );
  }
  let packageRead: Awaited<ReturnType<SignedReceiptFileSystem['readWithinLimit']>>;
  try {
    packageRead = await input.receiptFileSystem.readWithinLimit(
      path.resolve(input.cwd, input.packagePath),
      MAX_SIGNED_RECEIPT_PACKAGE_BYTES,
    );
  } catch (error) {
    const packageLabel = kind === 'review' ? 'signed review receipt' : 'signed receipt';
    throw new ThreadloopError(
      'SIGNED_RECEIPT_INVALID',
      `The ${packageLabel} package at ${input.packagePath} could not be read.`,
      {
        cause: error,
        details: {
          package_path: input.packagePath,
          hint: 'Provide a readable regular file containing the signed receipt package.',
        },
      },
    );
  }
  if (packageRead.status === 'too_large') {
    throw new ThreadloopError(
      'SIGNED_RECEIPT_INVALID',
      `The signed ${kind === 'review' ? 'review ' : ''}receipt package exceeds the 10 MiB limit.`,
      { details: { package_path: input.packagePath, size_bytes: packageRead.sizeBytes } },
    );
  }

  let packageValue: unknown;
  let envelope: TEnvelope;
  try {
    packageValue = JSON.parse(packageRead.bytes.toString('utf8')) as unknown;
    envelope = parseEnvelope(packageValue, sha256);
  } catch (error) {
    throw mapSignedReceiptParseError(error);
  }

  if (lifecycle.schemaVersion < 4) {
    throw new ThreadloopError(
      'SIGNED_RECEIPT_IDENTITY_MISMATCH',
      `This session predates immutable proof plans and cannot accept signed ${kind === 'review' ? 'review' : 'CI'} receipts.`,
    );
  }
  if (kind === 'gate' && lifecycle.state !== TASK_STATUS.VERIFYING) {
    throw new ThreadloopError('SIGNED_RECEIPT_CONFLICT', 'Signed gate receipts can be imported only while verifying.', {
      details: { session_id: input.sessionId, lifecycle_state: lifecycle.state },
    });
  }
  if (
    kind === 'review' &&
    lifecycle.state !== TASK_STATUS.REVIEWING &&
    lifecycle.state !== TASK_STATUS.READY_FOR_HUMAN
  ) {
    throw new ThreadloopError(
      'SIGNED_RECEIPT_CONFLICT',
      'Signed review receipts can be imported only while reviewing or ready for human authority.',
      { details: { session_id: input.sessionId, lifecycle_state: lifecycle.state } },
    );
  }
  const storedProof = readSessionProofEvidenceReadOnly(repoRoot, input.sessionId);
  if (!storedProof.plan) {
    throw new ThreadloopError('PROOF_PLAN_MISSING', 'The session has no immutable proof plan.', {
      details: { session_id: input.sessionId },
    });
  }
  let canonicalPlan: ReturnType<typeof canonicalizeProofPlan>;
  try {
    canonicalPlan = canonicalizeProofPlan(JSON.parse(storedProof.plan.json) as unknown, sha256);
  } catch (error) {
    throw new ThreadloopError('PROOF_PLAN_CORRUPTED', 'The stored proof plan is invalid.', { cause: error });
  }
  if (canonicalPlan.json !== storedProof.plan.json || canonicalPlan.sha256 !== storedProof.plan.sha256) {
    throw new ThreadloopError('PROOF_PLAN_CORRUPTED', 'The stored proof plan digest does not match its contents.');
  }
  return {
    repoRoot,
    lifecycle,
    plan: {
      ...canonicalPlan,
      baselineBranch: storedProof.plan.baselineBranch,
      baselineHeadSha: storedProof.plan.baselineHeadSha,
      createdAt: storedProof.plan.createdAt,
    },
    packageValue,
    envelope,
    fileSystem: input.receiptFileSystem,
  };
}

async function verifySigner(
  envelope: ImportEnvelope,
  policy: GitHubActionsTrustPolicy,
  verifier: typeof verifySigstoreReceipt = verifySigstoreReceipt,
) {
  try {
    return await verifier(envelope, policy);
  } catch (error) {
    throw mapSigstoreReceiptError(error);
  }
}

function assertSignerProjection(
  signer: VerifiedSigstoreSigner,
  source: ImportEnvelope['artifact']['source'],
  policy: GitHubActionsTrustPolicy,
  label: 'CI' | 'review',
) {
  if (
    signer.issuer !== policy.issuer ||
    signer.certificateIdentity !== policy.certificate_identity ||
    signer.buildSignerUri !== policy.build_signer_uri ||
    signer.buildSignerSha !== policy.build_signer_sha ||
    signer.sourceRepository !== source.repository ||
    signer.sourceHeadSha !== source.head_sha ||
    signer.sourceRef !== source.ref ||
    signer.runnerEnvironment !== 'github-hosted' ||
    signer.runInvocationUri !== source.run_invocation_uri
  ) {
    throw new ThreadloopError(
      'SIGNED_RECEIPT_IDENTITY_MISMATCH',
      `The verified signer projection does not match the signed ${label} package and immutable ${label} policy.`,
    );
  }
}

async function persistControlledPackage(input: {
  prepared: PreparedImport<ImportEnvelope>;
  receiptId: string;
  sessionId: string;
  fileName: 'signed-receipt.json' | 'signed-review-receipt.json';
  packageJson: string;
  packageSha256: string;
  append: (
    packagePath: string,
    promotePackage: () => void,
  ) => Promise<{ sequence: number; alreadyImported: boolean; verifiedAt: string }>;
}) {
  const relativePackagePath = [
    '.threadloop',
    'artifacts',
    'receipts',
    input.sessionId,
    input.receiptId,
    input.fileName,
  ].join('/');
  const finalPackagePath = path.join(input.prepared.repoRoot, ...relativePackagePath.split('/'));
  const receiptDirectory = path.dirname(finalPackagePath);
  const stagePrefix = input.fileName.replace(/\.json$/, '');
  const stagedPackagePath = path.join(
    receiptDirectory,
    `.${stagePrefix}.stage_${randomUUID().replaceAll('-', '')}.tmp`,
  );
  await mkdir(receiptDirectory, { recursive: true });
  await writeFile(stagedPackagePath, input.packageJson, { encoding: 'utf8', flag: 'wx' });

  let promoted = false;
  let completed = false;
  try {
    const appended = await input.append(relativePackagePath, () => {
      try {
        input.prepared.fileSystem.linkExclusive(stagedPackagePath, finalPackagePath);
        promoted = true;
      } catch (error) {
        if (!isErrorCode(error, 'EEXIST')) {
          throw error;
        }
        const existingDigest = input.prepared.fileSystem.sha256WithinLimitOrNull(
          finalPackagePath,
          MAX_SIGNED_RECEIPT_PACKAGE_BYTES,
        );
        if (existingDigest !== input.packageSha256) {
          throw error;
        }
      }
      input.prepared.fileSystem.unlink(stagedPackagePath);
    });
    if (
      appended.alreadyImported &&
      input.prepared.fileSystem.sha256WithinLimitOrNull(finalPackagePath, MAX_SIGNED_RECEIPT_PACKAGE_BYTES) !==
        input.packageSha256
    ) {
      throw new ThreadloopError(
        'SIGNED_RECEIPT_CONFLICT',
        'The previously imported signed receipt package is missing or corrupt.',
        { details: { receipt_id: input.receiptId } },
      );
    }
    completed = true;
    return { ...appended, packagePath: relativePackagePath };
  } finally {
    await rm(stagedPackagePath, { force: true });
    if (promoted && !completed) {
      await rm(finalPackagePath, { force: true });
    }
  }
}

function assertSignedGateContext(input: {
  requestedSessionId: string;
  plan: BoundProofPlan;
  expectedRepository: string | null;
  currentBranch: string | null;
  currentHead: string;
  receipt: ParsedSignedReceiptPackage;
  gate: BoundProofPlan['plan']['gates'][number] | undefined;
  policy: GitHubActionsTrustPolicy;
}) {
  const artifact = input.receipt.artifact;
  if (artifact.session_id !== input.requestedSessionId || artifact.plan_sha256 !== input.plan.sha256) {
    throw new ThreadloopError(
      'SIGNED_RECEIPT_INVALID',
      'The signed receipt does not match the selected session and plan.',
    );
  }
  if (!input.gate || canonicalJson(input.gate) !== canonicalJson(artifact.gate)) {
    throw new ThreadloopError('SIGNED_RECEIPT_INVALID', 'The signed receipt gate does not match a declared gate.');
  }
  if (
    !input.expectedRepository ||
    input.expectedRepository !== input.policy.source_repository ||
    artifact.source.repository !== input.policy.source_repository
  ) {
    throw new ThreadloopError(
      'SIGNED_RECEIPT_IDENTITY_MISMATCH',
      'The signed receipt source repository is not trusted.',
    );
  }
  if (!input.currentBranch || artifact.source.ref !== `refs/heads/${input.currentBranch}`) {
    throw new ThreadloopError(
      'SIGNED_RECEIPT_IDENTITY_MISMATCH',
      'The signed receipt source ref is not the current branch.',
    );
  }
  if (
    artifact.source.head_sha !== input.currentHead ||
    artifact.head_before !== input.currentHead ||
    artifact.head_after !== input.currentHead
  ) {
    throw new ThreadloopError(
      'SIGNED_RECEIPT_HEAD_MISMATCH',
      'The signed receipt does not prove the current repository HEAD.',
    );
  }
}

function assertSignedReviewContext(input: {
  requestedSessionId: string;
  plan: BoundProofPlan;
  expectedRepository: string | null;
  currentHead: string;
  receipt: ParsedSignedReviewReceiptPackage;
  policy: GitHubActionsTrustPolicy;
}) {
  const artifact = input.receipt.artifact;
  if (artifact.session_id !== input.requestedSessionId || artifact.plan_sha256 !== input.plan.sha256) {
    throw new ThreadloopError(
      'SIGNED_RECEIPT_INVALID',
      'The signed review package does not belong to this session and proof plan.',
    );
  }
  if (
    !input.expectedRepository ||
    artifact.source.repository !== input.expectedRepository ||
    artifact.source.repository !== input.policy.source_repository
  ) {
    throw new ThreadloopError(
      'SIGNED_RECEIPT_IDENTITY_MISMATCH',
      'The signed review package source repository is not trusted.',
    );
  }
  if (artifact.pull_request.head_sha !== input.currentHead) {
    throw new ThreadloopError(
      'SIGNED_RECEIPT_HEAD_MISMATCH',
      'The signed review package does not describe the current repository HEAD.',
    );
  }
}

function githubRepositoryUri(repository: Awaited<ReturnType<typeof observeRepository>>) {
  return repository.identity.source === 'origin' &&
    repository.identity.host === 'github.com' &&
    repository.identity.owner
    ? `https://github.com/${repository.identity.owner}/${repository.identity.name}`
    : null;
}

function mapSignedReceiptParseError(error: unknown) {
  if (error instanceof AttestationValidationError || error instanceof ReviewValidationError) {
    const artifactMismatch =
      error.field.startsWith('statement.subject') || error.field.startsWith('statement.predicate.artifact');
    return new ThreadloopError(
      artifactMismatch ? 'SIGNED_RECEIPT_ARTIFACT_MISMATCH' : 'SIGNED_RECEIPT_INVALID',
      error.message,
      { cause: error, details: { field: error.field } },
    );
  }
  return new ThreadloopError('SIGNED_RECEIPT_INVALID', 'The signed receipt package is not valid JSON.', {
    cause: error,
  });
}

function mapSigstoreReceiptError(error: unknown) {
  if (!(error instanceof SigstoreReceiptVerificationError)) {
    return new ThreadloopError('SIGNED_RECEIPT_SIGNATURE_INVALID', 'The signed receipt could not be verified.', {
      cause: error,
    });
  }
  const code = {
    transparency_missing: 'SIGNED_RECEIPT_TRANSPARENCY_MISSING',
    identity_mismatch: 'SIGNED_RECEIPT_IDENTITY_MISMATCH',
    signature_invalid: 'SIGNED_RECEIPT_SIGNATURE_INVALID',
    verification_unavailable: 'SIGNED_RECEIPT_VERIFICATION_UNAVAILABLE',
  }[error.reason] as
    | 'SIGNED_RECEIPT_TRANSPARENCY_MISSING'
    | 'SIGNED_RECEIPT_IDENTITY_MISMATCH'
    | 'SIGNED_RECEIPT_SIGNATURE_INVALID'
    | 'SIGNED_RECEIPT_VERIFICATION_UNAVAILABLE';
  return new ThreadloopError(code, error.message, { cause: error });
}

async function resolveRepositoryRoot(cwd: string) {
  try {
    return await resolveRepoRoot(cwd);
  } catch (error) {
    throw new ThreadloopError('NOT_GIT_REPOSITORY', 'ThreadLoop requires a Git repository. Run `git init` first.', {
      cause: error,
    });
  }
}

async function assertInitializedReadOnly(repoRoot: string) {
  if (!isThreadloopInitialized(repoRoot)) {
    throw new ThreadloopError(
      'THREADLOOP_NOT_INITIALIZED',
      'ThreadLoop is not initialized in this repo. Run `threadloop init` first.',
    );
  }
  await readConfig(repoRoot);
}

function isErrorCode(error: unknown, code: string) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
