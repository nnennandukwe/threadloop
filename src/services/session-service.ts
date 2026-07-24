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
  insertTaskSession,
  readConfig,
  readSessionGateContext,
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
} from '../adapters/fs/sqlite-store.js';
import { isThreadloopInitialized } from '../adapters/fs/repo.js';
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
  planNextTransition,
  requiresProofGuardContext,
} from '../domain/session-transition.js';
import type { ProofGuardContext, TransitionRequest } from '../domain/session-transition.js';
import {
  canonicalizeProofPlan,
  evaluateProofEvidence,
  ProofValidationError,
  type BoundProofPlan,
  type ProofEvidence,
  type StoredGateReceipt,
} from '../domain/proof.js';
import type { GateReceiptPayload } from '../domain/proof.js';
import { canonicalJson } from '../domain/canonical-json.js';
import { DEFAULT_BASE_REF, TASK_STATUS } from '../domain/types.js';
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

interface StateContext {
  repoRoot: string;
  state: StateData;
}

interface ResolvedSession extends SessionRecord {
  active: ActiveState;
}

export async function initThreadloop(cwd: string) {
  const repoRoot = await resolveRepositoryRoot(cwd);
  const { created, gitignoreStatus } = await initializeThreadloopRepo(repoRoot);
  return { repoRoot, created, gitignoreStatus };
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
    if (
      lifecycle?.state === TASK_STATUS.FRAMED &&
      lifecycle.stateVersion === input.expectedStateVersion &&
      input.targetState === TASK_STATUS.PROOF_READY
    ) {
      boundProofPlan = await prepareBoundProofPlan(repoRoot, input.input.proof_plan);
      proofGuardContext = { boundPlan: boundProofPlan };
    } else if (
      lifecycle &&
      lifecycle.schemaVersion >= 4 &&
      requiresProofGuardContext(lifecycle.state, input.targetState)
    ) {
      const repository = await observeProofRepository(repoRoot);
      const proofState = await evaluateSessionProof(repoRoot, input.sessionId, repository.headSha);
      proofGuardContext = await buildProofGuardContext(repoRoot, proofState, repository);
    }
    return await applySessionTransition(
      repoRoot,
      {
        ...input,
        ...canonicalRequest,
        ...(boundProofPlan ? { boundProofPlan } : {}),
      },
      (sourceState, targetState, transitionInput, blockedFromState) =>
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

async function prepareBoundProofPlan(repoRoot: string, value: unknown): Promise<BoundProofPlan> {
  const canonical = canonicalizeProofPlan(value, sha256);
  const repository = await observeProofRepository(repoRoot);
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
  await assertInitialized(repoRoot);
  await ensureStateDatabase(repoRoot);
  await ensureThreadloopStateIgnored(repoRoot);
  const context = await readSessionGateContext(repoRoot, input.sessionId);
  if (!context) {
    throw new ThreadloopError('SESSION_NOT_FOUND', `Could not find session: ${input.sessionId}`, {
      details: { session_id: input.sessionId },
    });
  }
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

  const proofState =
    lifecycle.schemaVersion >= 4
      ? await evaluateSessionProof(repoRoot, lifecycle.sessionId, proofRepository?.headSha ?? repository.headSha)
      : null;
  const proofGuardContext =
    proofState && proofRepository ? await buildProofGuardContext(repoRoot, proofState, proofRepository) : undefined;
  const planned = planNextTransition({
    state: lifecycle.state,
    stateVersion: lifecycle.stateVersion,
    blockedFromState: lifecycle.blockedFromState,
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
    contract_version: 1 as const,
    session_id: lifecycle.sessionId,
    task_id: lifecycle.taskId,
    lifecycle: {
      state: lifecycle.state,
      state_version: lifecycle.stateVersion,
      blocked_from_state: lifecycle.blockedFromState,
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
    terminal_reason: planned.terminalReason,
  };
}

async function evaluateSessionProof(
  repoRoot: string,
  sessionId: string,
  currentHead: string | null,
): Promise<{
  evidence: ProofEvidence;
  attemptsUsed: number;
  plan: BoundProofPlan | null;
  receipts: StoredGateReceipt[];
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
      attemptsUsed: stored.attemptsUsed,
      plan: null,
      receipts: stored.receipts,
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
      attemptsUsed: stored.attemptsUsed,
      plan: null,
      receipts: stored.receipts,
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
      attemptsUsed: stored.attemptsUsed,
      plan: null,
      receipts: stored.receipts,
    };
  }
  const plan: BoundProofPlan = {
    ...canonical,
    baselineBranch: stored.plan.baselineBranch,
    baselineHeadSha: stored.plan.baselineHeadSha,
    createdAt: stored.plan.createdAt,
  };
  const artifactDigests = await readReceiptArtifactDigests(repoRoot, sessionId, stored.receipts);
  return {
    evidence: evaluateProofEvidence({
      sessionId,
      plan,
      receipts: stored.receipts,
      currentHead,
      artifactDigests,
      digest: sha256,
    }),
    attemptsUsed: stored.attemptsUsed,
    plan,
    receipts: stored.receipts,
  };
}

async function buildProofGuardContext(
  repoRoot: string,
  proofState: Awaited<ReturnType<typeof evaluateSessionProof>>,
  repository: Awaited<ReturnType<typeof observeProofRepository>>,
): Promise<ProofGuardContext> {
  const plan = proofState.plan;
  const committedDiffFromBaseline = plan
    ? await hasCommittedDiff(repoRoot, plan.baselineHeadSha, repository.headSha)
    : false;
  const latestFailure = [...proofState.receipts]
    .sort((left, right) => right.sequence - left.sequence)
    .find((receipt) => receipt.result !== 'passed');
  let committedRepairFromFailure = false;
  if (latestFailure && isFullCommitSha(latestFailure.headAfter) && latestFailure.headAfter !== repository.headSha) {
    committedRepairFromFailure = await hasCommittedDiff(repoRoot, latestFailure.headAfter, repository.headSha);
  }
  return {
    plan,
    evidence: proofState.evidence,
    attemptsUsed: proofState.attemptsUsed,
    repository: {
      branch: repository.branch,
      headSha: repository.headSha,
      clean: repository.clean,
      committedDiffFromBaseline,
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
  const resolved = resolveSessionFromState(state, selector);
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
  const content = renderArtifact({
    task: resolved.task,
    session: resolved.session,
    entries,
    repoSnapshot: snapshot,
    generatedAt,
    artifactKind,
  });

  const fullPath = await writeArtifactFile(repoRoot, filename, content);
  const artifact = {
    id: createId('artifact'),
    sessionId: resolved.session.id,
    kind: artifactKind,
    path: path.relative(repoRoot, fullPath),
    templateVersion: 'v1',
    generatedAt,
    snapshotSource,
  };

  await recordArtifact(repoRoot, artifact);
  return { repoRoot, task: resolved.task, session: resolved.session, artifact, fullPath };
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
