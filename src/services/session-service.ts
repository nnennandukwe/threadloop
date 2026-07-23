import path from 'node:path';
import { ensureThreadloopStateIgnored } from '../adapters/fs/gitignore.js';
import {
  appendEntryToSession,
  applySessionTransition,
  createId,
  ensureStateDatabase,
  ensureThreadloopLayout,
  insertTaskSession,
  readConfig,
  readSessionLifecycleReadOnly,
  readRepoSnapshot,
  readState,
  recordArtifact,
  recordSessionHeartbeat,
  upsertRepoSnapshot,
  writeArtifactFile,
  writeConfig,
} from '../adapters/fs/sqlite-store.js';
import { isThreadloopInitialized } from '../adapters/fs/repo.js';
import { observeRepository, refExists, resolveRepoRoot, snapshotRepo } from '../adapters/git/client.js';
import { ThreadloopError } from '../contracts/errors.js';
import { canonicalizeTransitionRequest, planNextTransition } from '../domain/session-transition.js';
import type { TransitionRequest } from '../domain/session-transition.js';
import { DEFAULT_BASE_REF } from '../domain/types.js';
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
    status: 'queued',
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
    return await applySessionTransition(repoRoot, {
      ...input,
      ...canonicalizeTransitionRequest(input),
    });
  } catch (error) {
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
  try {
    repository = await observeRepository(repoRoot);
  } catch (error) {
    throw new ThreadloopError('REPOSITORY_OBSERVATION_FAILED', 'Could not read the live Git repository state.', {
      cause: error,
      details: {
        session_id: input.sessionId,
        hint: 'Restore access to the Git worktree and retry session next.',
      },
    });
  }

  const planned = planNextTransition({
    state: lifecycle.state,
    stateVersion: lifecycle.stateVersion,
    blockedFromState: lifecycle.blockedFromState,
  });
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
      branch: repository.branch,
      head_sha: repository.headSha,
      worktree: {
        clean: repository.worktree.clean,
        changed_files: repository.worktree.changedFiles,
      },
    },
    staleness: {
      status: 'deferred' as const,
      is_stale: null,
      stale_receipt_ids: [],
      owner_issue: 40 as const,
    },
    repair_budget: {
      status: 'deferred' as const,
      attempts_used: null,
      limit: 3,
      remaining: null,
      exhausted: null,
      owner_issue: 40 as const,
    },
    terminal_reason: planned.terminalReason,
  };
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
