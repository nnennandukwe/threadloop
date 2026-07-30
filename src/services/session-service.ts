import path from 'node:path';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { sha256, sha256File } from '../adapters/crypto/sha256.js';
import { ensureThreadloopStateIgnored } from '../adapters/fs/gitignore.js';
import {
  appendEntryToSession,
  appendGateReceipt,
  applySessionTransition,
  createId,
  ensureStateDatabase,
  ensureThreadloopLayout,
  hasSessionTransitionIdempotencyReadOnly,
  inspectAuditLedgerReadOnly,
  insertTaskSession,
  readConfig,
  readSessionGateContext,
  readSessionAuditReadOnly,
  readSessionTransitionHistoryReadOnly,
  readSessionProofEvidenceReadOnly,
  readSessionLifecycleReadOnly,
  readRepoSnapshot,
  readState,
  recordArtifact,
  recordSessionHeartbeat,
  upsertRepoSnapshot,
  writeArtifactFile,
  writeConfig,
  ReceiptAppendConflictError,
  AuditChainCorruptedError,
  AuditLedgerUnavailableError,
  SessionTransitionHistoryCorruptedError,
} from '../adapters/fs/sqlite-store.js';
import { AuditExportConflictError, writeAuditExportExclusive } from '../adapters/fs/audit-export.js';
import { isThreadloopInitialized } from '../adapters/fs/repo.js';
import { nodeSignedReceiptFileSystem } from '../adapters/fs/signed-receipt-files.js';
import {
  isFullCommitSha,
  observeProofRepository,
  observeRepository,
  hasCommittedDiff,
  refExists,
  resolveRepoRoot,
  snapshotRepo,
} from '../adapters/git/client.js';
import { runGateProcess } from '../adapters/process/gate-runner.js';
import { ThreadloopError } from '../contracts/errors.js';
import {
  canonicalizeTransitionRequest,
  evaluateTransitionGuards,
  getTransitionGuardRequirement,
  planNextTransition,
  readPrePrReviewEvidence,
  requiresProofGuardContext,
} from '../domain/session-transition.js';
import type { ProofGuardContext, TransitionGuardDecision, TransitionRequest } from '../domain/session-transition.js';
import {
  canonicalizeProofPlan,
  evaluateProofEvidence,
  hasReviewTrustPolicy,
  ProofValidationError,
  type BoundProofPlan,
  type ProofEvidence,
  type StoredGateReceipt,
} from '../domain/proof.js';
import type { GateReceiptPayload } from '../domain/proof.js';
import { evaluateCiProofEvidence, type CiProofEvidence, type StoredSignedGateReceipt } from '../domain/attestation.js';
import {
  evaluateReviewEvidence,
  hasBlockingReview,
  hasCurrentHumanApproval,
  reviewEvidenceFromArtifact,
  type ReviewEvidence,
  type StoredSignedReviewReceipt,
} from '../domain/review.js';
import { canonicalJson } from '../domain/canonical-json.js';
import { verifyAuditChain } from '../domain/audit.js';
import { deriveLifecyclePhase, isRepairEntryTransition } from '../domain/lifecycle.js';
import { DEFAULT_BASE_REF, LIFECYCLE_PHASE, TASK_STATUS } from '../domain/types.js';
import type {
  ActiveState,
  ArtifactKind,
  Entry,
  EntryKind,
  EntrySource,
  HeartbeatSource,
  RepoSnapshot,
  Session,
  SessionRecord,
  StateData,
  StoredRepoSnapshot,
  Task,
} from '../domain/types.js';
import { renderArtifact } from '../renderers/markdown/artifacts.js';
import {
  importSignedGateReceiptPackage,
  importSignedReviewReceiptPackage,
  type SignedReceiptImportInput,
} from './signed-receipt-import.js';
import { mapAuditChainCorruption } from './audit-service-errors.js';
import { readControlledSignedReceiptPackageContents } from './signed-receipt-files.js';

export interface StartTaskInput {
  cwd: string;
  title: string;
  goal: string;
  constraints: string[];
  baseRef?: string | null;
  issueRef?: string | null;
  actor?: EntrySource;
  allowMultipleActive?: boolean;
}

export interface CaptureInput {
  cwd: string;
  kind: EntryKind;
  body: string;
  because?: string;
  sessionId?: string;
  actor?: EntrySource;
}

export interface SessionSelector {
  sessionId?: string;
  allowLegacySingleActive?: boolean;
}

export interface HeartbeatInput {
  cwd: string;
  sessionId: string;
  source?: HeartbeatSource;
}

export interface TransitionSessionInput extends TransitionRequest {
  cwd: string;
  idempotencyKey: string;
}

export interface NextSessionInput {
  cwd: string;
  sessionId: string;
}

export interface RunSessionGateInput {
  cwd: string;
  sessionId: string;
  gateId: string;
}

export type ImportSessionGateReceiptInput = SignedReceiptImportInput;
export type ImportSessionReviewReceiptInput = SignedReceiptImportInput;

interface StateContext {
  repoRoot: string;
  state: StateData;
}

interface ResolvedSession extends SessionRecord {
  active: ActiveState;
}

export async function initThreadloop(cwd: string) {
  const repoRoot = await resolveRepositoryRoot(cwd);
  try {
    const { created, gitignoreStatus } = await initializeThreadloopRepo(repoRoot);
    return { repoRoot, created, gitignoreStatus };
  } catch (error) {
    if (error instanceof AuditChainCorruptedError) {
      throw mapAuditChainCorruption(
        error.sessionId ?? '(migration)',
        error,
        'Restore the audit ledger from trusted storage, then rerun `threadloop init`.',
      );
    }
    if (isSchemaStateError(error)) {
      throw new ThreadloopError('STATE_CORRUPTED', error instanceof Error ? error.message : String(error), {
        cause: error,
        details: {
          hint: 'Restore transition history from trusted storage, then rerun `threadloop init`.',
        },
      });
    }
    throw error;
  }
}

export async function startTask(input: StartTaskInput) {
  const repoRoot = await resolveRepositoryRoot(input.cwd);
  await initializeThreadloopRepo(repoRoot);
  const baseRef =
    input.baseRef === undefined && (await refExists(repoRoot, DEFAULT_BASE_REF))
      ? DEFAULT_BASE_REF
      : (input.baseRef ?? null);

  if (!input.allowMultipleActive) {
    const state = await readState(repoRoot);
    if (state.activeSessions.length > 0) {
      throw new ThreadloopError(
        'SESSION_AMBIGUOUS',
        'A legacy root session already exists in this repo. Use explicit session commands for additional work.',
        {
          details: { activeSessions: state.activeSessions.length },
        },
      );
    }
  }

  if (baseRef && !(await refExists(repoRoot, baseRef))) {
    throw new ThreadloopError('BASE_REF_NOT_FOUND', `Base ref not found: ${baseRef}`, {
      details: { baseRef },
    });
  }

  const snapshot = await snapshotRepo(repoRoot, 'preview', baseRef);
  const now = new Date().toISOString();
  const task: Task = {
    id: createId('task'),
    title: input.title,
    goal: input.goal,
    constraints: input.constraints,
    issueRef: normalizeOptionalText(input.issueRef),
    repoRoot,
    status: TASK_STATUS.QUEUED,
    stateVersion: 0,
    blockedFromState: null,
    createdAt: now,
  };

  const session: Session = {
    id: createId('session'),
    taskId: task.id,
    startedAt: now,
    endedAt: null,
    baseRef,
    branch: snapshot.branch,
    headSha: snapshot.headSha,
    lastHeartbeatAt: null,
    lastHeartbeatSource: null,
  };

  await insertTaskSession(repoRoot, {
    task,
    session,
    intentEntry: {
      id: createId('entry'),
      sessionId: session.id,
      kind: 'intent',
      body: `Task started: ${task.title}`,
      metadata: {
        goal: task.goal,
        constraints: task.constraints,
        ...(task.issueRef ? { issueRef: task.issueRef } : {}),
      },
      createdAt: now,
      source: input.actor ?? 'cli',
    },
    initialSnapshot: {
      sessionId: session.id,
      branch: snapshot.branch,
      headSha: snapshot.headSha,
      baseRef: snapshot.baseRef,
      changedFiles: snapshot.changedFiles,
      diffStats: snapshot.diffStats,
      commitRange: snapshot.commitRange,
      reconciledAt: now,
    },
  });
  return { repoRoot, task, session };
}

export async function listSessions(cwd: string) {
  const { repoRoot, state } = await loadStateContext(cwd);
  return {
    repoRoot,
    sessions: state.sessions.map((session) => {
      const task = mustFindTask(state, session.taskId);
      return {
        task,
        session,
        active: state.activeSessions.some((active) => active.sessionId === session.id),
      };
    }),
  };
}

export async function heartbeatSession(input: HeartbeatInput) {
  const { repoRoot, state } = await loadStateContext(input.cwd);
  const resolved = resolveSessionFromState(state, { sessionId: input.sessionId });
  const now = new Date().toISOString();
  const source = input.source ?? 'cli';
  const repoSnapshot = await snapshotRepo(repoRoot, resolved.session.id, resolved.session.baseRef);

  await recordSessionHeartbeat(repoRoot, {
    sessionId: resolved.session.id,
    branch: repoSnapshot.branch,
    headSha: repoSnapshot.headSha,
    lastHeartbeatAt: now,
    source,
  });

  return {
    repoRoot,
    task: resolved.task,
    session: {
      ...resolved.session,
      branch: repoSnapshot.branch,
      headSha: repoSnapshot.headSha,
      lastHeartbeatAt: now,
      lastHeartbeatSource: source,
    },
  };
}

export async function transitionSession(input: TransitionSessionInput) {
  const repoRoot = await resolveRepositoryRoot(input.cwd);
  try {
    await assertInitialized(repoRoot);
    await ensureStateDatabase(repoRoot);
    const lifecycle = readSessionLifecycleReadOnly(repoRoot, input.sessionId);
    const canonicalRequest = canonicalizeTransitionRequest(input, sha256);
    if (hasSessionTransitionIdempotencyReadOnly(repoRoot, input.sessionId, input.idempotencyKey)) {
      return await applySessionTransition(repoRoot, {
        ...input,
        ...canonicalRequest,
      });
    }
    let boundProofPlan: BoundProofPlan | undefined;
    let proofGuardContext: ProofGuardContext = {};
    let preparedProofGuardRejection: TransitionGuardDecision | undefined;
    const phase = lifecycle
      ? deriveLifecyclePhase(readSessionTransitionHistoryReadOnly(repoRoot, input.sessionId))
      : LIFECYCLE_PHASE.PRE_PR;
    if (
      lifecycle?.state === TASK_STATUS.FRAMED &&
      lifecycle.stateVersion === input.expectedStateVersion &&
      input.targetState === TASK_STATUS.PROOF_READY
    ) {
      try {
        boundProofPlan = await prepareBoundProofPlan(repoRoot, input.input.proof_plan);
        proofGuardContext = { boundPlan: boundProofPlan };
      } catch (error) {
        const rejection = proofBaselineGuardRejection(error);
        if (!rejection) {
          throw error;
        }
        preparedProofGuardRejection = rejection;
      }
    } else if (
      lifecycle &&
      lifecycle.schemaVersion >= 4 &&
      getTransitionGuardRequirement(lifecycle.state, input.targetState) === 'review'
    ) {
      const preliminary = await evaluateSessionProof(repoRoot, input.sessionId, null);
      if (!preliminary.plan) {
        proofGuardContext = {
          plan: null,
          evidence: preliminary.evidence,
          ciEvidence: preliminary.ciEvidence,
          reviewEvidence: preliminary.reviewEvidence,
          attemptsUsed: preliminary.attemptsUsed,
          phase,
        };
      } else {
        const repository = await observeProofRepository(repoRoot);
        const proofState = await evaluateSessionProof(repoRoot, input.sessionId, repository.headSha);
        proofGuardContext = await buildProofGuardContext(repoRoot, input.sessionId, proofState, repository);
      }
    } else if (
      lifecycle &&
      lifecycle.schemaVersion >= 4 &&
      requiresProofGuardContext(lifecycle.state, input.targetState)
    ) {
      const repository = await observeProofRepository(repoRoot);
      const proofState = await evaluateSessionProof(repoRoot, input.sessionId, repository.headSha);
      proofGuardContext = await buildProofGuardContext(repoRoot, input.sessionId, proofState, repository);
    }
    return await applySessionTransition(
      repoRoot,
      {
        ...input,
        ...canonicalRequest,
        ...(boundProofPlan ? { boundProofPlan } : {}),
      },
      (sourceState, targetState, transitionInput, blockedFromState) =>
        preparedProofGuardRejection ??
        evaluateTransitionGuards(sourceState, targetState, transitionInput, blockedFromState, proofGuardContext),
    );
  } catch (error) {
    if (error instanceof ProofValidationError) {
      throw new ThreadloopError('INVALID_ARGUMENT', error.message, {
        cause: error,
        details: {
          field: error.field,
          hint: 'Provide a valid proof_plan with acceptance_criteria and exact declared gates.',
        },
      });
    }
    if (error instanceof AuditChainCorruptedError) {
      throw mapAuditChainCorruption(input.sessionId, error);
    }
    if (isSchemaStateError(error)) {
      throw new ThreadloopError('STATE_CORRUPTED', error instanceof Error ? error.message : String(error), {
        cause: error,
      });
    }
    if (isSqliteBusyError(error)) {
      throw new ThreadloopError(
        'STATE_BUSY',
        'ThreadLoop state is busy after waiting 10 seconds. Retry the same idempotency key.',
        {
          cause: error,
          details: {
            session_id: input.sessionId,
            idempotency_key: input.idempotencyKey,
            hint: 'Retry the identical request with the same idempotency key.',
          },
        },
      );
    }
    if (isSqliteStateError(error)) {
      throw new ThreadloopError('STATE_CORRUPTED', 'ThreadLoop could not persist transition state safely.', {
        cause: error,
        details: { session_id: input.sessionId },
      });
    }
    throw error;
  }
}

function proofBaselineGuardRejection(error: unknown): TransitionGuardDecision | null {
  if (
    !(error instanceof ThreadloopError) ||
    error.code !== 'TRANSITION_GUARD_FAILED' ||
    !Array.isArray(error.details?.guard_failures) ||
    !Array.isArray(error.details.required_work)
  ) {
    return null;
  }
  const guardFailures = error.details.guard_failures;
  const requiredWork = error.details.required_work;
  if (
    !guardFailures.every(
      (failure) =>
        typeof failure === 'object' &&
        failure !== null &&
        typeof (failure as Record<string, unknown>).code === 'string' &&
        typeof (failure as Record<string, unknown>).message === 'string',
    ) ||
    !requiredWork.every(
      (work) =>
        typeof work === 'object' &&
        work !== null &&
        typeof (work as Record<string, unknown>).code === 'string' &&
        typeof (work as Record<string, unknown>).description === 'string',
    )
  ) {
    return null;
  }
  return {
    allowed: false,
    guardFailures: guardFailures as TransitionGuardDecision['guardFailures'],
    requiredWork: requiredWork as TransitionGuardDecision['requiredWork'],
  };
}

async function prepareBoundProofPlan(repoRoot: string, value: unknown): Promise<BoundProofPlan> {
  const canonical = canonicalizeProofPlan(value, sha256, {
    requireCiPolicy: true,
    requireReviewPolicy: true,
  });
  const [repository, liveRepository] = await Promise.all([
    observeProofRepository(repoRoot),
    observeRepository(repoRoot),
  ]);
  if (!repository.clean || !repository.branch) {
    throw new ThreadloopError(
      'TRANSITION_GUARD_FAILED',
      'A proof plan requires a clean repository on a named branch.',
      {
        details: {
          guard_failures: [
            {
              code: repository.branch ? 'PROOF_BASELINE_DIRTY' : 'PROOF_BASELINE_BRANCH_REQUIRED',
              message: repository.branch
                ? 'Commit or clean every repository change before recording the proof plan.'
                : 'Check out a named branch before recording the proof plan.',
            },
          ],
          required_work: [
            {
              code: 'PREPARE_CLEAN_PROOF_BASELINE',
              description: 'Use a named branch and commit or clean the worktree before retrying.',
            },
          ],
          changed_files: repository.changedFiles,
          hint: 'Commit or clean the repository, then retry the same transition with a new idempotency key.',
        },
      },
    );
  }
  if (!hasReviewTrustPolicy(canonical.plan)) {
    throw new ProofValidationError(
      'proof_plan.review',
      'proof_plan.review must define an immutable signed-review trust policy.',
    );
  }
  const expectedSourceRepository =
    liveRepository.identity.source === 'origin' &&
    liveRepository.identity.host === 'github.com' &&
    liveRepository.identity.owner
      ? `https://github.com/${liveRepository.identity.owner}/${liveRepository.identity.name}`
      : null;
  for (const [field, policy] of [
    ['ci', canonical.plan.ci],
    ['review', canonical.plan.review],
  ] as const) {
    if (!expectedSourceRepository || policy.source_repository !== expectedSourceRepository) {
      throw new ProofValidationError(
        `proof_plan.${field}.source_repository`,
        `proof_plan.${field}.source_repository must match the GitHub origin repository.`,
      );
    }
    if (!policy.certificate_identity.endsWith(`@refs/heads/${repository.branch}`)) {
      throw new ProofValidationError(
        `proof_plan.${field}.certificate_identity`,
        `proof_plan.${field}.certificate_identity must bind the current proof-plan branch.`,
      );
    }
  }

  for (const gate of canonical.plan.gates) {
    await resolveProofWorkingDirectory(repoRoot, gate.id, gate.working_directory);
  }

  return {
    ...canonical,
    baselineBranch: repository.branch,
    baselineHeadSha: repository.headSha,
    createdAt: new Date().toISOString(),
  };
}

export async function runSessionGate(input: RunSessionGateInput) {
  const repoRoot = await resolveRepositoryRoot(input.cwd);
  try {
    await assertInitialized(repoRoot);
    await ensureStateDatabase(repoRoot);
  } catch (error) {
    if (error instanceof AuditChainCorruptedError) {
      throw mapAuditChainCorruption(input.sessionId, error);
    }
    if (isSchemaStateError(error)) {
      throw new ThreadloopError('STATE_CORRUPTED', error instanceof Error ? error.message : String(error), {
        cause: error,
        details: {
          session_id: input.sessionId,
          hint: 'Restore transition history from trusted storage before retrying the gate.',
        },
      });
    }
    throw error;
  }
  const context = await readSessionGateContext(repoRoot, input.sessionId);
  if (!context) {
    throw new ThreadloopError('SESSION_NOT_FOUND', `Could not find session: ${input.sessionId}`, {
      details: { session_id: input.sessionId },
    });
  }
  assertSessionAuditVerified(repoRoot, input.sessionId);
  await ensureThreadloopStateIgnored(repoRoot);
  if (context.state !== TASK_STATUS.VERIFYING) {
    throw new ThreadloopError('GATE_NOT_RUNNABLE', 'Local gates can run only while a session is verifying.', {
      details: {
        session_id: input.sessionId,
        lifecycle_state: context.state,
        hint: 'Run `threadloop session next --json` and satisfy the reported transition guard.',
      },
    });
  }
  if (!context.plan) {
    throw new ThreadloopError('PROOF_PLAN_MISSING', 'The session has no immutable proof plan.', {
      details: {
        session_id: input.sessionId,
        hint: 'Return to framed and record a valid proof plan before running gates.',
      },
    });
  }

  let canonicalPlan: ReturnType<typeof canonicalizeProofPlan>;
  try {
    canonicalPlan = canonicalizeProofPlan(JSON.parse(context.plan.json) as unknown, sha256);
  } catch (error) {
    throw new ThreadloopError('PROOF_PLAN_CORRUPTED', 'The stored proof plan is invalid.', {
      cause: error,
      details: {
        session_id: input.sessionId,
        hint: 'Restore the proof plan from a trusted backup or start a new session.',
      },
    });
  }
  if (canonicalPlan.json !== context.plan.json || canonicalPlan.sha256 !== context.plan.sha256) {
    throw new ThreadloopError('PROOF_PLAN_CORRUPTED', 'The stored proof plan digest does not match its contents.', {
      details: {
        session_id: input.sessionId,
        expected_sha256: context.plan.sha256,
        actual_sha256: canonicalPlan.sha256,
        hint: 'Restore the proof plan from a trusted backup or start a new session.',
      },
    });
  }
  const gate = canonicalPlan.plan.gates.find((candidate) => candidate.id === input.gateId);
  if (!gate) {
    throw new ThreadloopError('GATE_NOT_DECLARED', `Gate ${input.gateId} is not declared in the proof plan.`, {
      details: {
        session_id: input.sessionId,
        gate_id: input.gateId,
        declared_gates: canonicalPlan.plan.gates.map((candidate) => candidate.id),
        hint: 'Run one of the declared gate ids; command overrides are not supported.',
      },
    });
  }

  const before = await observeProofRepository(repoRoot);
  if (before.branch !== context.plan.baselineBranch) {
    throw new ThreadloopError('GATE_NOT_RUNNABLE', 'The gate must run on the named branch bound to the proof plan.', {
      details: {
        session_id: input.sessionId,
        gate_id: gate.id,
        expected_branch: context.plan.baselineBranch,
        actual_branch: before.branch,
        hint: `Check out ${context.plan.baselineBranch} and restore the intended verification HEAD.`,
      },
    });
  }
  if (!before.clean) {
    throw new ThreadloopError('GATE_PREFLIGHT_DIRTY', 'The repository must be clean before a gate can start.', {
      details: {
        session_id: input.sessionId,
        gate_id: gate.id,
        changed_files: before.changedFiles,
        hint: 'Commit or clean every repository change, then rerun the declared gate.',
      },
    });
  }
  const workingDirectory = await resolveProofWorkingDirectory(repoRoot, gate.id, gate.working_directory);
  const receiptId = createId('receipt');
  const receiptDirectory = path.join(repoRoot, '.threadloop', 'artifacts', 'receipts', input.sessionId, receiptId);
  await mkdir(receiptDirectory, { recursive: true });
  const stdoutPath = path.join(receiptDirectory, 'stdout.log');
  const stderrPath = path.join(receiptDirectory, 'stderr.log');
  const executionPath = path.join(receiptDirectory, 'execution.json');
  const relativeStdoutPath = relativeArtifactPath(repoRoot, stdoutPath);
  const relativeStderrPath = relativeArtifactPath(repoRoot, stderrPath);
  const relativeExecutionPath = relativeArtifactPath(repoRoot, executionPath);

  const processResult = await runGateProcess({
    command: gate.command,
    cwd: workingDirectory,
    timeoutMs: gate.timeout_ms,
    stdoutPath,
    stderrPath,
  });
  const after = await observeProofRepository(repoRoot).catch(() => null);
  const invalidated = !after || !after.clean || after.headSha !== before.headSha || after.branch !== before.branch;
  const result = invalidated ? 'invalidated' : processResult.result;
  const headAfter = after?.headSha ?? before.headSha;
  const cleanAfter = after?.clean ?? false;
  const execution = {
    contract_version: 1,
    receipt_id: receiptId,
    session_id: input.sessionId,
    gate_id: gate.id,
    plan_sha256: context.plan.sha256,
    result,
    command: gate.command,
    working_directory: gate.working_directory,
    timeout_ms: gate.timeout_ms,
    started_at: processResult.startedAt,
    ended_at: processResult.endedAt,
    duration_ms: processResult.durationMs,
    exit_status: processResult.exitStatus,
    signal: processResult.signal,
    head_before: before.headSha,
    head_after: headAfter,
    clean_before: before.clean,
    clean_after: cleanAfter,
    stdout: {
      path: relativeStdoutPath,
      sha256: processResult.stdout.sha256,
      bytes: processResult.stdout.bytes,
    },
    stderr: {
      path: relativeStderrPath,
      sha256: processResult.stderr.sha256,
      bytes: processResult.stderr.bytes,
    },
    error: processResult.error,
    sensor: {
      name: 'threadloop-local-gate',
      contract_version: 1,
    },
  };
  const executionBytes = Buffer.from(`${canonicalJson(execution)}\n`, 'utf8');
  await writeFile(executionPath, executionBytes, { flag: 'wx' });
  const receipt: GateReceiptPayload = {
    id: receiptId,
    session_id: input.sessionId,
    gate_id: gate.id,
    plan_sha256: context.plan.sha256,
    result,
    command: gate.command,
    working_directory: gate.working_directory,
    timeout_ms: gate.timeout_ms,
    started_at: processResult.startedAt,
    ended_at: processResult.endedAt,
    duration_ms: processResult.durationMs,
    exit_status: processResult.exitStatus,
    signal: processResult.signal,
    head_before: before.headSha,
    head_after: headAfter,
    clean_before: before.clean,
    clean_after: cleanAfter,
    artifact: {
      path: relativeExecutionPath,
      sha256: sha256(executionBytes),
    },
    sensor: {
      name: 'threadloop-local-gate',
      contract_version: 1,
    },
  };
  const receiptJson = canonicalJson(receipt);
  let sequence: number;
  try {
    sequence = await appendGateReceipt(repoRoot, {
      receipt,
      receiptJson,
      receiptSha256: sha256(receiptJson),
      stateVersion: context.stateVersion,
    });
  } catch (error) {
    if (error instanceof AuditChainCorruptedError) {
      throw mapAuditChainCorruption(input.sessionId, error);
    }
    if (error instanceof SessionTransitionHistoryCorruptedError) {
      throw new ThreadloopError('STATE_CORRUPTED', error.message, {
        cause: error,
        details: {
          session_id: input.sessionId,
          orphan_artifact: relativeExecutionPath,
          hint: 'Restore transition history from trusted storage before retrying the gate.',
        },
      });
    }
    if (error instanceof ReceiptAppendConflictError) {
      throw new ThreadloopError('RECEIPT_NOT_RECORDED', error.message, {
        cause: error,
        details: {
          session_id: input.sessionId,
          gate_id: gate.id,
          orphan_artifact: relativeExecutionPath,
          hint: 'Inspect the current lifecycle state, then rerun the gate if verification is still required.',
        },
      });
    }
    throw error;
  }

  return {
    receipt: { ...receipt, sequence },
    lifecycle: {
      state: context.state,
      state_version: context.stateVersion,
    },
  };
}

export async function importSessionGateReceipt(input: ImportSessionGateReceiptInput) {
  const imported = await importSignedGateReceiptPackage(input);
  const artifact = imported.receipt.artifact;
  const proof = await evaluateSessionProof(imported.repoRoot, input.sessionId, artifact.source.head_sha);
  return {
    contract_version: 1 as const,
    receipt: {
      id: artifact.receipt_id,
      sequence: imported.sequence,
      gate_id: artifact.gate.id,
      result: artifact.result,
      subject_head_sha: artifact.source.head_sha,
      artifact: { sha256: imported.receipt.artifactSha256 },
      statement: { sha256: imported.receipt.statementSha256 },
      package: { path: imported.packagePath, sha256: imported.receipt.packageSha256 },
      signer: imported.signer,
      verified_at: imported.verifiedAt,
    },
    already_imported: imported.alreadyImported,
    ci_proof: {
      status: proof.ciEvidence.status,
      policy: proof.ciEvidence.policy ?? {},
      gates: proof.ciEvidence.gates,
    },
    lifecycle: {
      state: imported.lifecycle.state,
      state_version: imported.lifecycle.stateVersion,
    },
  };
}

export async function importSessionReviewReceipt(input: ImportSessionReviewReceiptInput) {
  const imported = await importSignedReviewReceiptPackage(input);
  const artifact = imported.receipt.artifact;
  const evidence = reviewEvidenceFromArtifact(artifact, artifact.pull_request.head_sha);
  return {
    contract_version: 1 as const,
    receipt: {
      id: artifact.receipt_id,
      sequence: imported.sequence,
      pull_request_number: artifact.pull_request.number,
      subject_head_sha: artifact.pull_request.head_sha,
      artifact: { sha256: imported.receipt.artifactSha256 },
      statement: { sha256: imported.receipt.statementSha256 },
      package: { path: imported.packagePath, sha256: imported.receipt.packageSha256 },
      signer: imported.signer,
      verified_at: imported.verifiedAt,
    },
    already_imported: imported.alreadyImported,
    review: {
      status: evidence.status,
      snapshot_id: evidence.snapshotId,
      decision: evidence.reviewDecision,
      blocking_findings: evidence.blockingFindings,
      approvals: evidence.approvals,
      merged: evidence.merged,
      merged_at: evidence.mergedAt,
    },
    lifecycle: {
      state: imported.lifecycle.state,
      state_version: imported.lifecycle.stateVersion,
    },
  };
}

function assertSessionAuditVerified(repoRoot: string, sessionId: string) {
  try {
    const verification = verifyAuditChain(readRequiredSessionAudit(repoRoot, sessionId), sha256);
    if (!verification.valid && verification.error) {
      throw new AuditChainCorruptedError(
        verification.error.code,
        `Session ${sessionId} audit chain is corrupt at sequence ${verification.error.sequence ?? 'root'}.`,
        verification.error.sequence,
        sessionId,
      );
    }
  } catch (error) {
    if (error instanceof AuditChainCorruptedError) {
      throw mapAuditChainCorruption(sessionId, error);
    }
    throw error;
  }
}

async function resolveProofWorkingDirectory(repoRoot: string, gateId: string, workingDirectory: string) {
  const canonicalRepoRoot = await realpath(repoRoot);
  let gateDirectory: string;
  try {
    gateDirectory = await realpath(path.resolve(canonicalRepoRoot, workingDirectory));
  } catch {
    throw new ProofValidationError(
      `proof_plan.gates.${gateId}.working_directory`,
      `proof_plan.gates.${gateId}.working_directory must name an existing directory.`,
    );
  }
  const relative = path.relative(canonicalRepoRoot, gateDirectory);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ProofValidationError(
      `proof_plan.gates.${gateId}.working_directory`,
      `proof_plan.gates.${gateId}.working_directory resolves outside the repository.`,
    );
  }
  return gateDirectory;
}

function relativeArtifactPath(repoRoot: string, artifactPath: string) {
  return path.relative(repoRoot, artifactPath).split(path.sep).join('/');
}

export interface SessionAuditInput {
  cwd: string;
  sessionId: string;
}

export interface VerifySessionAuditInput extends SessionAuditInput {
  expectedRoot?: string;
}

export interface ExportSessionAuditInput extends SessionAuditInput {
  outputPath: string;
}

export async function showSessionAudit(input: SessionAuditInput) {
  const audit = await loadSessionAudit(input);
  return {
    contract_version: audit.contract_version,
    session_id: audit.session_id,
    count: audit.count,
    root: audit.root,
    coverage: audit.coverage,
    verification: audit.verification,
    events: audit.storedEvents.map((event) => ({
      event: event.value,
      event_sha256: event.sha256,
    })),
  };
}

export async function verifySessionAudit(input: VerifySessionAuditInput) {
  if (input.expectedRoot !== undefined && !/^[a-f0-9]{64}$/.test(input.expectedRoot)) {
    throw new ThreadloopError('INVALID_ARGUMENT', 'Audit root must be 64 lowercase hexadecimal characters.', {
      details: { field: 'root' },
    });
  }
  const audit = await loadSessionAudit(input, input.expectedRoot);
  if (!audit.verification.valid) {
    throw auditVerificationFailure(input.sessionId, audit);
  }
  return {
    contract_version: audit.contract_version,
    session_id: audit.session_id,
    count: audit.count,
    root: audit.root,
    expected_root: input.expectedRoot ?? null,
    valid: true as const,
    error: null,
  };
}

export async function exportSessionAudit(input: ExportSessionAuditInput) {
  const audit = await loadSessionAudit(input);
  if (!audit.verification.valid) {
    throw auditVerificationFailure(input.sessionId, audit);
  }
  const outputPath = path.resolve(input.cwd, input.outputPath);
  const content = `${audit.storedEvents
    .map((event) => canonicalJson({ event: event.value, event_sha256: event.sha256 }))
    .join('\n')}\n`;
  try {
    await writeAuditExportExclusive(outputPath, content);
  } catch (error) {
    if (error instanceof AuditExportConflictError) {
      throw new ThreadloopError('AUDIT_EXPORT_CONFLICT', error.message, {
        cause: error,
        details: {
          output: outputPath,
          hint: 'Choose a new output path; ThreadLoop never overwrites an audit export.',
        },
      });
    }
    throw new ThreadloopError('AUDIT_EXPORT_FAILED', 'ThreadLoop could not publish the verified audit export.', {
      cause: error,
      details: {
        output: outputPath,
        hint: 'Choose a writable output path whose parent is a directory, then retry the export.',
      },
    });
  }
  return {
    contract_version: 1 as const,
    session_id: input.sessionId,
    count: audit.count,
    root: audit.root,
    coverage: audit.coverage,
    output: outputPath,
  };
}

async function loadSessionAudit(input: SessionAuditInput, expectedRoot?: string) {
  const repoRoot = await resolveRepositoryRoot(input.cwd);
  await assertInitializedReadOnly(repoRoot);
  const availability = inspectAuditLedgerReadOnly(repoRoot);
  if (!availability.available && availability.schemaVersion !== null && availability.schemaVersion >= 6) {
    throw auditUnavailableFailure(
      input.sessionId,
      new AuditLedgerUnavailableError('table_missing', availability.schemaVersion),
    );
  }
  try {
    await ensureStateDatabase(repoRoot);
  } catch (error) {
    if (error instanceof AuditChainCorruptedError) {
      throw mapAuditChainCorruption(input.sessionId, error, 'Restore the ledger from trusted storage.');
    }
    if (isSchemaStateError(error)) {
      throw new ThreadloopError('STATE_CORRUPTED', error instanceof Error ? error.message : String(error), {
        cause: error,
        details: {
          session_id: input.sessionId,
          hint: 'Restore transition history from trusted storage before retrying the audit operation.',
        },
      });
    }
    throw error;
  }
  const lifecycle = readSessionLifecycleReadOnly(repoRoot, input.sessionId);
  if (!lifecycle) {
    throw new ThreadloopError('SESSION_NOT_FOUND', `Could not find session: ${input.sessionId}`, {
      details: { session_id: input.sessionId },
    });
  }
  const storedEvents = readRequiredSessionAudit(repoRoot, input.sessionId);
  const verification = verifyAuditChain(storedEvents, sha256, expectedRoot);
  const first = storedEvents[0]?.value;
  const coverage =
    first?.event_type === 'session_started'
      ? ('full' as const)
      : first?.event_type === 'audit_activated' && first.payload.coverage === 'schema_v6_forward'
        ? ('schema_v6_forward' as const)
        : ('unknown' as const);
  return {
    contract_version: 1 as const,
    session_id: input.sessionId,
    count: storedEvents.length,
    root: verification.root,
    coverage,
    verification,
    events: storedEvents.map((event) => event.value),
    storedEvents,
  };
}

function readRequiredSessionAudit(repoRoot: string, sessionId: string) {
  let storedEvents: ReturnType<typeof readSessionAuditReadOnly>;
  try {
    storedEvents = readSessionAuditReadOnly(repoRoot, sessionId);
  } catch (error) {
    if (error instanceof AuditLedgerUnavailableError) {
      throw auditUnavailableFailure(sessionId, error);
    }
    if (error instanceof AuditChainCorruptedError) {
      throw mapAuditChainCorruption(sessionId, error, 'Restore the ledger from trusted storage.');
    }
    throw error;
  }
  if (storedEvents.length === 0) {
    throw new ThreadloopError('AUDIT_EMPTY', `Session ${sessionId} has no audit events.`, {
      details: {
        session_id: sessionId,
        hint: 'Restore the ledger from trusted storage; an authoritative session audit must have a genesis event.',
      },
    });
  }
  return storedEvents;
}

function auditUnavailableFailure(sessionId: string, error: AuditLedgerUnavailableError) {
  return new ThreadloopError('AUDIT_UNAVAILABLE', 'The session audit ledger is unavailable.', {
    cause: error,
    details: {
      session_id: sessionId,
      schema_version: error.schemaVersion,
      reason: error.reason,
      hint:
        error.reason === 'schema_version'
          ? 'Run a state-migrating ThreadLoop command before retrying the audit operation.'
          : 'Restore the schema-v6-or-newer audit ledger from trusted storage before retrying.',
    },
  });
}

function auditVerificationFailure(sessionId: string, audit: Awaited<ReturnType<typeof loadSessionAudit>>) {
  return new ThreadloopError('AUDIT_VERIFICATION_FAILED', 'The session audit ledger failed verification.', {
    details: {
      session_id: sessionId,
      count: audit.count,
      root: audit.root,
      audit_error: audit.verification.error,
      hint: 'Restore the ledger from trusted storage or compare it with a previously retained audit root.',
    },
  });
}

export async function getNextSessionAction(input: NextSessionInput) {
  const repoRoot = await resolveRepositoryRoot(input.cwd);
  await assertInitializedReadOnly(repoRoot);

  let lifecycle: NonNullable<ReturnType<typeof readSessionLifecycleReadOnly>>;
  try {
    const stored = readSessionLifecycleReadOnly(repoRoot, input.sessionId);
    if (!stored) {
      throw new ThreadloopError('SESSION_NOT_FOUND', `Could not find session: ${input.sessionId}`, {
        details: { session_id: input.sessionId },
      });
    }
    lifecycle = stored;
  } catch (error) {
    if (error instanceof ThreadloopError) {
      throw error;
    }
    throw new ThreadloopError('STATE_CORRUPTED', error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }

  let repository: Awaited<ReturnType<typeof observeRepository>>;
  let proofRepository: Awaited<ReturnType<typeof observeProofRepository>> | null = null;
  try {
    repository = await observeRepository(repoRoot);
    if (repository.headSha) {
      proofRepository = await observeProofRepository(repoRoot);
    }
  } catch (error) {
    throw new ThreadloopError('REPOSITORY_OBSERVATION_FAILED', 'Could not read the live Git repository state.', {
      cause: error,
      details: {
        session_id: input.sessionId,
        hint: 'Restore access to the Git worktree and retry session next.',
      },
    });
  }

  let lifecycleHistory: ReturnType<typeof readSessionTransitionHistoryReadOnly>;
  try {
    lifecycleHistory =
      lifecycle.schemaVersion >= 3 ? readSessionTransitionHistoryReadOnly(repoRoot, input.sessionId) : [];
  } catch (error) {
    if (error instanceof AuditChainCorruptedError) {
      throw mapAuditChainCorruption(input.sessionId, error);
    }
    throw new ThreadloopError('STATE_CORRUPTED', error instanceof Error ? error.message : String(error), {
      cause: error,
      details: {
        session_id: input.sessionId,
        hint: 'Restore transition history from trusted storage before retrying session next.',
      },
    });
  }
  const phase = deriveLifecyclePhase(lifecycleHistory);
  const lifecycleMigrationRequired = lifecycle.schemaVersion < 7;
  const proofState =
    !lifecycleMigrationRequired && lifecycle.schemaVersion >= 4
      ? await evaluateSessionProof(repoRoot, lifecycle.sessionId, proofRepository?.headSha ?? repository.headSha)
      : null;
  const proofGuardContext =
    proofState && proofRepository
      ? await buildProofGuardContext(repoRoot, input.sessionId, proofState, proofRepository)
      : undefined;
  const audit = projectSessionAuditReadOnly(repoRoot, input.sessionId, lifecycle.schemaVersion);
  const planned = lifecycleMigrationRequired
    ? {
        candidate: null,
        guardFailures: [
          {
            code: 'SESSION_SCHEMA_MIGRATION_REQUIRED',
            message: `ThreadLoop schema v${lifecycle.schemaVersion} must be migrated before lifecycle work can continue.`,
            owner_issue: 69,
          },
        ],
        requiredWork: [
          {
            code: 'MIGRATE_SESSION_SCHEMA',
            description: 'Run `threadloop init`, then rerun `threadloop session next --session <id> --json`.',
            owner_issue: 69,
          },
        ],
        terminalReason: null,
      }
    : planNextTransition({
        state: lifecycle.state,
        stateVersion: lifecycle.stateVersion,
        blockedFromState: lifecycle.blockedFromState,
        phase,
        ...(proofState
          ? {
              proof: {
                status: proofState.evidence.status,
                attemptsUsed: proofState.attemptsUsed,
              },
            }
          : {}),
        ...(proofGuardContext ? { proofGuardContext } : {}),
      });
  const repairBudget = proofState
    ? {
        status: proofState.attemptsUsed >= 3 ? ('exhausted' as const) : ('available' as const),
        attempts_used: proofState.attemptsUsed,
        limit: 3,
        remaining: Math.max(0, 3 - proofState.attemptsUsed),
        exhausted: proofState.attemptsUsed >= 3,
      }
    : {
        status: 'migration_required' as const,
        attempts_used: null,
        limit: 3,
        remaining: null,
        exhausted: null,
      };
  return {
    contract_version: 4 as const,
    session_id: lifecycle.sessionId,
    task_id: lifecycle.taskId,
    lifecycle: {
      state: lifecycle.state,
      state_version: lifecycle.stateVersion,
      blocked_from_state: lifecycle.blockedFromState,
      phase,
      storage_schema_version: lifecycle.schemaVersion,
      contract_status: lifecycleMigrationRequired ? ('migration_required' as const) : ('current' as const),
      history: lifecycleHistory,
    },
    pre_pr_review: projectPrePrReview(
      lifecycle.schemaVersion,
      lifecycle.state,
      lifecycleHistory,
      proofRepository?.headSha ?? repository.headSha,
    ),
    implementation_basis: lifecycleMigrationRequired
      ? {
          head_sha: null,
          source: null,
        }
      : {
          head_sha: proofGuardContext?.implementationBasis?.headSha ?? null,
          source: proofGuardContext?.implementationBasis?.source ?? null,
        },
    candidate: planned.candidate,
    guard_failures: planned.guardFailures,
    required_work: planned.requiredWork,
    repository: {
      identity: repository.identity,
      branch: proofRepository?.branch ?? repository.branch,
      head_sha: proofRepository?.headSha ?? repository.headSha,
      worktree: {
        clean: proofRepository?.clean ?? repository.worktree.clean,
        changed_files: proofRepository?.changedFiles ?? repository.worktree.changedFiles,
      },
    },
    proof: proofState
      ? {
          status: proofState.evidence.status,
          plan_sha256: proofState.plan?.sha256 ?? null,
          baseline_branch: proofState.plan?.baselineBranch ?? null,
          baseline_head_sha: proofState.plan?.baselineHeadSha ?? null,
          gates: proofState.evidence.gates,
        }
      : {
          status: 'migration_required' as const,
          plan_sha256: null,
          baseline_branch: null,
          baseline_head_sha: null,
          gates: [],
        },
    ci_proof: proofState
      ? {
          status: proofState.ciEvidence.status,
          policy: proofState.ciEvidence.policy ?? {},
          gates: proofState.ciEvidence.gates,
        }
      : {
          status: 'policy_missing' as const,
          policy: {},
          gates: [],
        },
    review: proofState
      ? {
          status: proofState.reviewEvidence.status,
          snapshot_id: proofState.reviewEvidence.snapshotId,
          head_sha: proofState.reviewEvidence.headSha,
          decision: proofState.reviewEvidence.reviewDecision,
          blocking_findings: proofState.reviewEvidence.blockingFindings,
          approvals: proofState.reviewEvidence.approvals,
          human_approval_current: hasCurrentHumanApproval(proofState.reviewEvidence),
          merged: proofState.reviewEvidence.merged,
          merged_at: proofState.reviewEvidence.mergedAt,
        }
      : {
          status: 'policy_missing' as const,
          snapshot_id: null,
          head_sha: null,
          decision: null,
          blocking_findings: [],
          approvals: [],
          human_approval_current: false,
          merged: false,
          merged_at: null,
        },
    staleness: proofState
      ? {
          status:
            proofState.evidence.status === 'stale'
              ? ('stale' as const)
              : proofState.evidence.status === 'missing'
                ? ('missing' as const)
                : proofState.evidence.status === 'corrupt'
                  ? ('corrupt' as const)
                  : ('current' as const),
          is_stale: proofState.evidence.staleReceiptIds.length > 0,
          stale_receipt_ids: proofState.evidence.staleReceiptIds,
        }
      : {
          status: 'migration_required' as const,
          is_stale: null,
          stale_receipt_ids: [],
        },
    repair_budget: repairBudget,
    audit,
    next_human_action: nextHumanAction(lifecycle.state, planned),
    terminal_reason: planned.terminalReason,
  };
}

function projectPrePrReview(
  schemaVersion: number,
  state: Task['status'],
  history: ReturnType<typeof readSessionTransitionHistoryReadOnly>,
  currentHead: string | null,
) {
  const firstReviewIndex = history.findIndex((transition) => transition.to_state === TASK_STATUS.REVIEWING);
  const prePrHistory = history.slice(0, firstReviewIndex === -1 ? history.length : firstReviewIndex + 1);
  const iterationCount = prePrHistory.filter(
    (transition) =>
      transition.to_state === TASK_STATUS.IMPLEMENTING && transition.from_state !== TASK_STATUS.PROOF_READY,
  ).length;
  if (schemaVersion < 7) {
    return {
      status: 'migration_required' as const,
      head_sha: null,
      evidence_ref: null,
      evidence_sha256: null,
      findings: [],
      iteration_count: iterationCount,
    };
  }

  const latestReview = [...prePrHistory]
    .reverse()
    .map((transition) => readPrePrReviewEvidence(transition.input))
    .find((review) => review !== null);
  if (!latestReview) {
    return {
      status: state === TASK_STATUS.PRE_PR_REVIEWING ? ('review_required' as const) : ('not_started' as const),
      head_sha: null,
      evidence_ref: null,
      evidence_sha256: null,
      findings: [],
      iteration_count: iterationCount,
    };
  }

  return {
    status:
      latestReview.headSha !== currentHead
        ? ('stale' as const)
        : latestReview.outcome === 'changes_required'
          ? ('changes_required' as const)
          : ('cleared' as const),
    head_sha: latestReview.headSha,
    evidence_ref: latestReview.evidenceRef,
    evidence_sha256: latestReview.evidenceSha256,
    findings: latestReview.findings.map((finding) => ({
      id: finding.id,
      summary: finding.summary,
      path: finding.path,
    })),
    iteration_count: iterationCount,
  };
}

function projectSessionAuditReadOnly(repoRoot: string, sessionId: string, schemaVersion: number) {
  if (schemaVersion < 6) {
    return {
      status: 'migration_required' as const,
      event_count: null,
      root: null,
      coverage: 'unavailable' as const,
      error: null,
    };
  }
  try {
    const events = readSessionAuditReadOnly(repoRoot, sessionId);
    const verification = verifyAuditChain(events, sha256);
    const first = events[0]?.value;
    return {
      status: verification.valid ? ('valid' as const) : ('corrupt' as const),
      event_count: events.length,
      root: verification.root,
      coverage:
        first?.event_type === 'session_started'
          ? ('full' as const)
          : first?.event_type === 'audit_activated' && first.payload.coverage === 'schema_v6_forward'
            ? ('schema_v6_forward' as const)
            : ('unknown' as const),
      error: verification.error,
    };
  } catch (error) {
    return {
      status: 'corrupt' as const,
      event_count: null,
      root: null,
      coverage: 'unknown' as const,
      error: {
        code: 'AUDIT_READ_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function nextHumanAction(state: Task['status'], planned: ReturnType<typeof planNextTransition>) {
  const required = planned.requiredWork[0];
  if (required) {
    return {
      code: required.code,
      description: required.description,
    };
  }
  if (
    state === TASK_STATUS.REVIEWING &&
    planned.candidate?.target_state === TASK_STATUS.READY_FOR_HUMAN &&
    planned.candidate.executable
  ) {
    return {
      code: 'ADVANCE_TO_HUMAN_AUTHORITY',
      description: 'Apply the ready_for_human transition, then obtain human approval and merge authority.',
    };
  }
  return null;
}

async function evaluateSessionProof(
  repoRoot: string,
  sessionId: string,
  currentHead: string | null,
): Promise<{
  evidence: ProofEvidence;
  ciEvidence: CiProofEvidence;
  reviewEvidence: ReviewEvidence;
  attemptsUsed: number;
  plan: BoundProofPlan | null;
  receipts: StoredGateReceipt[];
  signedReceipts: StoredSignedGateReceipt[];
  signedReviewReceipts: StoredSignedReviewReceipt[];
}> {
  const stored = readSessionProofEvidenceReadOnly(repoRoot, sessionId);
  if (!stored.plan) {
    return {
      evidence: {
        status: 'missing',
        gates: [],
        staleReceiptIds: [],
        failedReceiptIds: [],
        corruptReceiptIds: [],
      },
      ciEvidence: { status: 'policy_missing', policy: null, gates: [] },
      reviewEvidence: emptySessionReviewEvidence('policy_missing'),
      attemptsUsed: stored.attemptsUsed,
      plan: null,
      receipts: stored.receipts,
      signedReceipts: stored.signedReceipts,
      signedReviewReceipts: stored.signedReviewReceipts,
    };
  }

  let canonical: ReturnType<typeof canonicalizeProofPlan>;
  try {
    canonical = canonicalizeProofPlan(JSON.parse(stored.plan.json) as unknown, sha256);
  } catch {
    return {
      evidence: {
        status: 'corrupt',
        gates: [],
        staleReceiptIds: [],
        failedReceiptIds: [],
        corruptReceiptIds: [],
      },
      ciEvidence: { status: 'corrupt', policy: null, gates: [] },
      reviewEvidence: emptySessionReviewEvidence('corrupt'),
      attemptsUsed: stored.attemptsUsed,
      plan: null,
      receipts: stored.receipts,
      signedReceipts: stored.signedReceipts,
      signedReviewReceipts: stored.signedReviewReceipts,
    };
  }
  if (canonical.json !== stored.plan.json || canonical.sha256 !== stored.plan.sha256) {
    return {
      evidence: {
        status: 'corrupt',
        gates: [],
        staleReceiptIds: [],
        failedReceiptIds: [],
        corruptReceiptIds: [],
      },
      ciEvidence: { status: 'corrupt', policy: null, gates: [] },
      reviewEvidence: emptySessionReviewEvidence('corrupt'),
      attemptsUsed: stored.attemptsUsed,
      plan: null,
      receipts: stored.receipts,
      signedReceipts: stored.signedReceipts,
      signedReviewReceipts: stored.signedReviewReceipts,
    };
  }
  const plan: BoundProofPlan = {
    ...canonical,
    baselineBranch: stored.plan.baselineBranch,
    baselineHeadSha: stored.plan.baselineHeadSha,
    createdAt: stored.plan.createdAt,
  };
  const [artifactDigests, packageContents, reviewPackageContents] = await Promise.all([
    readReceiptArtifactDigests(repoRoot, sessionId, stored.receipts),
    readControlledSignedReceiptPackageContents({
      repoRoot,
      sessionId,
      receipts: stored.signedReceipts,
      fileSystem: nodeSignedReceiptFileSystem,
    }),
    readControlledSignedReceiptPackageContents({
      repoRoot,
      sessionId,
      receipts: stored.signedReviewReceipts,
      fileSystem: nodeSignedReceiptFileSystem,
    }),
  ]);
  return {
    evidence: evaluateProofEvidence({
      sessionId,
      plan,
      receipts: stored.receipts,
      currentHead,
      artifactDigests,
      digest: sha256,
    }),
    ciEvidence: evaluateCiProofEvidence({
      sessionId,
      plan,
      receipts: stored.signedReceipts,
      currentHead,
      packageContents,
      digest: sha256,
    }),
    reviewEvidence: evaluateReviewEvidence({
      sessionId,
      plan,
      receipts: stored.signedReviewReceipts,
      currentHead,
      packageContents: reviewPackageContents,
      digest: sha256,
    }),
    attemptsUsed: stored.attemptsUsed,
    plan,
    receipts: stored.receipts,
    signedReceipts: stored.signedReceipts,
    signedReviewReceipts: stored.signedReviewReceipts,
  };
}

function emptySessionReviewEvidence(status: ReviewEvidence['status']): ReviewEvidence {
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

async function buildProofGuardContext(
  repoRoot: string,
  sessionId: string,
  proofState: Awaited<ReturnType<typeof evaluateSessionProof>>,
  repository: Awaited<ReturnType<typeof observeProofRepository>>,
): Promise<ProofGuardContext> {
  const plan = proofState.plan;
  const transitionHistory = readSessionTransitionHistoryReadOnly(repoRoot, sessionId);
  const phase = deriveLifecyclePhase(transitionHistory);
  const committedDiffFromBaseline = plan
    ? await hasCommittedDiff(repoRoot, plan.baselineHeadSha, repository.headSha)
    : false;
  const latestFailure = [...proofState.receipts]
    .sort((left, right) => right.sequence - left.sequence)
    .find((receipt) => receipt.result !== 'passed');
  const latestImplementationEntry = [...transitionHistory]
    .reverse()
    .find((entry) => entry.to_state === TASK_STATUS.IMPLEMENTING);
  const implementationReview = latestImplementationEntry
    ? readPrePrReviewEvidence(latestImplementationEntry.input)
    : null;
  const implementationBasis = !plan
    ? null
    : implementationReview
      ? {
          headSha: implementationReview.headSha,
          source: 'pre_pr_review' as const,
        }
      : phase === LIFECYCLE_PHASE.PRE_PR &&
          (proofState.evidence.status === 'failed' ||
            latestImplementationEntry?.from_state === TASK_STATUS.VERIFYING) &&
          latestFailure?.headAfter
        ? {
            headSha: latestFailure.headAfter,
            source: 'failed_local_proof' as const,
          }
        : {
            headSha: plan.baselineHeadSha,
            source: 'proof_plan_baseline' as const,
          };
  const committedImplementationFromBasis =
    implementationBasis &&
    isFullCommitSha(implementationBasis.headSha) &&
    implementationBasis.headSha !== repository.headSha
      ? await hasCommittedDiff(repoRoot, implementationBasis.headSha, repository.headSha)
      : false;
  const currentRepairEntry = [...transitionHistory]
    .reverse()
    .find((entry) => isRepairEntryTransition(entry.from_state, entry.to_state));
  const repairBasis =
    currentRepairEntry?.to_state !== TASK_STATUS.REPAIRING
      ? undefined
      : currentRepairEntry.from_state === TASK_STATUS.VERIFYING
        ? latestFailure?.headAfter
        : (currentRepairEntry.from_state === TASK_STATUS.REVIEWING ||
              currentRepairEntry.from_state === TASK_STATUS.READY_FOR_HUMAN) &&
            hasBlockingReview(proofState.reviewEvidence)
          ? (proofState.reviewEvidence.headSha ?? undefined)
          : undefined;
  let committedRepairFromFailure = false;
  if (repairBasis && isFullCommitSha(repairBasis) && repairBasis !== repository.headSha) {
    committedRepairFromFailure = await hasCommittedDiff(repoRoot, repairBasis, repository.headSha);
  }
  return {
    plan,
    evidence: proofState.evidence,
    ciEvidence: proofState.ciEvidence,
    reviewEvidence: proofState.reviewEvidence,
    attemptsUsed: proofState.attemptsUsed,
    phase,
    implementationBasis,
    repository: {
      branch: repository.branch,
      headSha: repository.headSha,
      clean: repository.clean,
      committedDiffFromBaseline,
      committedImplementationFromBasis,
      committedRepairFromFailure,
    },
  };
}

async function readReceiptArtifactDigests(repoRoot: string, sessionId: string, receipts: StoredGateReceipt[]) {
  const digests = new Map<string, string | null>();
  const expectedRoot = path.resolve(repoRoot, '.threadloop', 'artifacts', 'receipts', sessionId);
  for (const receipt of receipts) {
    const artifactPath = path.resolve(repoRoot, receipt.artifactPath);
    const relative = path.relative(expectedRoot, artifactPath);
    if (
      path.isAbsolute(receipt.artifactPath) ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      digests.set(receipt.id, null);
      continue;
    }
    try {
      const [canonicalRoot, canonicalArtifact] = await Promise.all([realpath(expectedRoot), realpath(artifactPath)]);
      const canonicalRelative = path.relative(canonicalRoot, canonicalArtifact);
      if (
        canonicalRelative === '..' ||
        canonicalRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(canonicalRelative)
      ) {
        digests.set(receipt.id, null);
        continue;
      }
      const executionDigest = await sha256File(canonicalArtifact);
      if (!(await executionOutputsAreValid(repoRoot, path.dirname(canonicalArtifact), canonicalArtifact))) {
        digests.set(receipt.id, null);
        continue;
      }
      digests.set(receipt.id, executionDigest);
    } catch {
      digests.set(receipt.id, null);
    }
  }
  return digests;
}

async function executionOutputsAreValid(repoRoot: string, receiptDirectory: string, executionPath: string) {
  let execution: unknown;
  try {
    execution = JSON.parse(await readFile(executionPath, 'utf8')) as unknown;
  } catch {
    return false;
  }
  if (typeof execution !== 'object' || execution === null || Array.isArray(execution)) {
    return false;
  }
  const record = execution as Record<string, unknown>;
  for (const streamName of ['stdout', 'stderr']) {
    const stream = record[streamName];
    if (typeof stream !== 'object' || stream === null || Array.isArray(stream)) {
      return false;
    }
    const output = stream as Record<string, unknown>;
    if (typeof output.path !== 'string' || typeof output.sha256 !== 'string') {
      return false;
    }
    const outputPath = path.resolve(repoRoot, output.path);
    try {
      const canonicalOutput = await realpath(outputPath);
      const relative = path.relative(receiptDirectory, canonicalOutput);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return false;
      }
      if ((await sha256File(canonicalOutput)) !== output.sha256) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

export interface ReconcileInput {
  cwd: string;
  sessionId?: string;
  reconcileAll?: boolean;
}

export interface ReconcileResult {
  repoRoot: string;
  sessionId: string;
  previousSnapshot: StoredRepoSnapshot | null;
  currentSnapshot: RepoSnapshot;
  reconciledAt: string;
}

export async function reconcileSession(input: ReconcileInput): Promise<ReconcileResult[]> {
  const { repoRoot, state } = await loadStateContext(input.cwd);

  let sessionIds: string[];

  if (input.sessionId) {
    const resolved = resolveSessionRecord(state, input.sessionId);
    sessionIds = [resolved.session.id];
  } else if (input.reconcileAll) {
    sessionIds = state.activeSessions.map((active) => active.sessionId);
    if (sessionIds.length === 0) {
      return [];
    }
  } else {
    throw new ThreadloopError('RECONCILE_TARGET_REQUIRED', 'Specify --session <id> or --all to reconcile.', {
      details: { hint: 'Use --session <id> for a specific session or --all for all active sessions.' },
    });
  }

  const now = new Date().toISOString();
  const results: ReconcileResult[] = [];

  for (const sessionId of sessionIds) {
    const resolved = resolveSessionRecord(state, sessionId);
    const previousSnapshot = await readRepoSnapshot(repoRoot, sessionId);
    const currentSnapshot = await snapshotRepo(repoRoot, sessionId, resolved.session.baseRef);

    await upsertRepoSnapshot(repoRoot, {
      sessionId,
      branch: currentSnapshot.branch,
      headSha: currentSnapshot.headSha,
      baseRef: currentSnapshot.baseRef,
      changedFiles: currentSnapshot.changedFiles,
      diffStats: currentSnapshot.diffStats,
      commitRange: currentSnapshot.commitRange,
      reconciledAt: now,
    });

    results.push({
      repoRoot,
      sessionId,
      previousSnapshot,
      currentSnapshot,
      reconciledAt: now,
    });
  }

  return results;
}

export async function captureEntry(input: CaptureInput) {
  const { repoRoot, state } = await loadStateContext(input.cwd);
  const resolved = resolveSessionFromState(state, {
    allowLegacySingleActive: !input.sessionId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  });

  const entry: Entry = await appendEntryToSession(repoRoot, resolved.session.id, {
    id: createId('entry'),
    kind: input.kind,
    body: input.body,
    metadata: input.because ? { because: input.because } : {},
    createdAt: new Date().toISOString(),
    source: input.actor ?? 'cli',
  });
  return { repoRoot, task: resolved.task, session: resolved.session, entry };
}

export async function getStatus(cwd: string, selector: SessionSelector = {}) {
  const { repoRoot, state } = await loadStateContext(cwd);
  if (!selector.sessionId && (selector.allowLegacySingleActive ?? true) && state.activeSessions.length === 0) {
    return { repoRoot, active: null, entries: [], repoSnapshot: null };
  }
  const record = selector.sessionId
    ? resolveSessionRecord(state, selector.sessionId)
    : resolveSessionFromState(state, {
        ...selector,
        allowLegacySingleActive: selector.allowLegacySingleActive ?? !selector.sessionId,
      });

  const entries = state.entries.filter((entry) => entry.sessionId === record.session.id);
  const repoSnapshot =
    record.session.endedAt === null ? await snapshotRepo(repoRoot, record.session.id, record.session.baseRef) : null;
  return { repoRoot, active: { task: record.task, session: record.session }, entries, repoSnapshot };
}

export async function generateArtifact(
  cwd: string,
  artifactKind: ArtifactKind,
  selector: SessionSelector = { allowLegacySingleActive: true },
) {
  const { repoRoot, state } = await loadStateContext(cwd);
  const resolved = resolveArtifactSessionFromState(state, selector);
  const entries = state.entries.filter((entry) => entry.sessionId === resolved.session.id);
  const storedSnapshot = await readRepoSnapshot(repoRoot, resolved.session.id);
  let snapshot: RepoSnapshot;
  let snapshotSource: 'stored' | 'live';
  if (resolved.session.endedAt === null || !storedSnapshot) {
    snapshot = await snapshotRepo(repoRoot, resolved.session.id, resolved.session.baseRef);
    snapshotSource = 'live';
    await upsertRepoSnapshot(repoRoot, {
      sessionId: resolved.session.id,
      branch: snapshot.branch,
      headSha: snapshot.headSha,
      baseRef: snapshot.baseRef,
      changedFiles: snapshot.changedFiles,
      diffStats: snapshot.diffStats,
      commitRange: snapshot.commitRange,
      reconciledAt: new Date().toISOString(),
    });
  } else {
    snapshot = storedSnapshot;
    snapshotSource = 'stored';
  }
  const generatedAt = new Date().toISOString();
  const filename = `${slugify(resolved.task.title)}.${artifactKind}.md`;
  const governance =
    artifactKind === 'handoff'
      ? await getNextSessionAction({ cwd: repoRoot, sessionId: resolved.session.id })
      : undefined;
  const content = renderArtifact({
    task: resolved.task,
    session: resolved.session,
    entries,
    repoSnapshot: snapshot,
    generatedAt,
    artifactKind,
    ...(governance ? { governance } : {}),
  });

  const fullPath = await writeArtifactFile(repoRoot, filename, content);
  const artifact = {
    id: createId('artifact'),
    sessionId: resolved.session.id,
    kind: artifactKind,
    path: path.relative(repoRoot, fullPath),
    templateVersion: artifactKind === 'handoff' ? 'v3' : 'v1',
    generatedAt,
    snapshotSource,
  };

  await recordArtifact(repoRoot, artifact);
  return { repoRoot, task: resolved.task, session: resolved.session, artifact, fullPath };
}

function resolveArtifactSessionFromState(state: StateData, selector: SessionSelector): SessionRecord {
  if (!selector.sessionId) {
    return resolveSessionFromState(state, selector);
  }
  return resolveSessionRecord(state, selector.sessionId);
}

async function loadStateContext(cwd: string): Promise<StateContext> {
  const repoRoot = await resolveRepositoryRoot(cwd);
  await assertInitialized(repoRoot);
  return { repoRoot, state: await readState(repoRoot) };
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

async function initializeThreadloopRepo(repoRoot: string) {
  await ensureThreadloopLayout(repoRoot);

  const created = !isThreadloopInitialized(repoRoot);
  if (created) {
    await writeConfig(repoRoot, { version: 1, createdAt: new Date().toISOString() });
  } else {
    await readConfig(repoRoot);
  }

  await ensureStateDatabase(repoRoot);
  const gitignoreStatus = await ensureThreadloopStateIgnored(repoRoot);
  return { created, gitignoreStatus };
}

async function assertInitialized(repoRoot: string) {
  if (!isThreadloopInitialized(repoRoot)) {
    throw new ThreadloopError(
      'THREADLOOP_NOT_INITIALIZED',
      'ThreadLoop is not initialized in this repo. Run `threadloop init` first.',
    );
  }
  await readConfig(repoRoot);
  await ensureStateDatabase(repoRoot);
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

function resolveSessionFromState(state: StateData, selector: SessionSelector): ResolvedSession {
  if (selector.sessionId) {
    const active = state.activeSessions.find((item) => item.sessionId === selector.sessionId);
    if (!active) {
      throw new ThreadloopError('SESSION_NOT_FOUND', `Could not find active session: ${selector.sessionId}`, {
        details: { sessionId: selector.sessionId },
      });
    }

    return { active, ...materializeSessionRecord(state, active) };
  }

  if (!selector.allowLegacySingleActive) {
    throw new ThreadloopError('SESSION_REQUIRED', 'A session id is required for this command.', {
      details: { hint: 'Pass --session <id> or use the command with exactly one active session.' },
    });
  }

  if (state.activeSessions.length === 0) {
    throw new ThreadloopError(
      'SESSION_REQUIRED',
      'No active session exists in this repo. Start one with `threadloop session start`.',
      {
        details: { activeSessions: 0 },
      },
    );
  }

  if (state.activeSessions.length > 1) {
    throw new ThreadloopError(
      'SESSION_AMBIGUOUS',
      'Multiple active sessions exist in this repo. Select one explicitly.',
      {
        details: { sessionIds: state.activeSessions.map((item) => item.sessionId) },
      },
    );
  }

  const active = state.activeSessions[0];
  if (!active) {
    throw new ThreadloopError('STATE_CORRUPTED', 'ThreadLoop active session registry is inconsistent.');
  }
  return { active, ...materializeSessionRecord(state, active) };
}

function materializeSessionRecord(state: StateData, active: ActiveState): SessionRecord {
  const task = state.tasks.find((item) => item.id === active.taskId);
  const session = state.sessions.find((item) => item.id === active.sessionId && item.endedAt === null);

  if (!task || !session) {
    throw new ThreadloopError(
      'STATE_CORRUPTED',
      'ThreadLoop session registry is inconsistent with persisted tasks or sessions.',
      {
        details: { taskId: active.taskId, sessionId: active.sessionId },
      },
    );
  }

  if (session.taskId !== task.id) {
    throw new ThreadloopError(
      'STATE_CORRUPTED',
      'ThreadLoop session registry associates the session with the wrong task.',
      {
        details: {
          projectedTaskId: active.taskId,
          sessionId: active.sessionId,
          sessionTaskId: session.taskId,
        },
      },
    );
  }

  return { task, session };
}

function resolveSessionRecord(state: StateData, sessionId: string): SessionRecord {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) {
    throw new ThreadloopError('SESSION_NOT_FOUND', `Could not find session: ${sessionId}`, {
      details: { sessionId },
    });
  }

  return {
    task: mustFindTask(state, session.taskId),
    session,
  };
}

function mustFindTask(state: StateData, taskId: string) {
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) {
    throw new ThreadloopError('STATE_CORRUPTED', 'ThreadLoop could not reload the associated task record.', {
      details: { taskId },
    });
  }
  return task;
}

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'artifact'
  );
}

function normalizeOptionalText(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isSchemaStateError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.startsWith('Unsupported ThreadLoop schema version:') ||
    message.startsWith('Missing ThreadLoop schema version metadata.') ||
    message.startsWith('Invalid schema for ') ||
    message.startsWith('Invalid session transition history for ') ||
    message === 'Invalid .threadloop/state/state.db'
  );
}

function isSqliteBusyError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }
  const sqlite = error as Error & { errcode?: number; errstr?: string };
  return sqlite.errcode === 5 || sqlite.errstr === 'database is locked' || /database is locked/i.test(error.message);
}

function isSqliteStateError(error: unknown) {
  return error instanceof Error && (error as Error & { code?: string }).code === 'ERR_SQLITE_ERROR';
}
