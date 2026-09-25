import prompts from 'prompts';
import { readTextFromEditor } from '../adapters/fs/editor.js';
import { nodeSignedReceiptFileSystem } from '../adapters/fs/signed-receipt-files.js';
import { ThreadloopError, createInvalidArgumentError } from '../contracts/errors.js';
import type { EntryKind, EntrySource, HeartbeatSource, TaskStatus } from '../domain/types.js';
import {
  captureEntry,
  getNextSessionAction,
  getStatus,
  heartbeatSession,
  importSessionGateReceipt,
  importSessionReviewReceipt,
  listSessions,
  reconcileSession,
  runSessionGate,
  startTask,
  transitionSession,
} from '../services/session-service.js';
import { countEntryKinds, requireSessionId, type CommandContext, writeCommandSuccess } from './runtime.js';

interface SessionOptions {
  session: string;
}

export async function sessionStartCommand(
  context: CommandContext,
  title: string,
  options: {
    goal?: string;
    constraint?: string[];
    base?: string;
    issue?: string;
    actor?: EntrySource;
    goalEdit?: boolean;
  },
) {
  let goal = options.goal?.trim();
  if (options.goalEdit) {
    goal = await readTextFromEditor(goal ?? '');
  }

  if (!goal) {
    const response = await prompts({
      type: 'text',
      name: 'goal',
      message: 'What is the goal of this task?',
      validate: (value: string) => (value.trim() ? true : 'Goal is required'),
    });
    if (typeof response.goal !== 'string' || !response.goal.trim()) {
      throw new Error('Goal is required.');
    }
    goal = response.goal.trim();
  }

  const result = await startTask({
    cwd: context.cwd,
    title,
    goal,
    constraints: options.constraint ?? [],
    ...(options.base ? { baseRef: options.base } : {}),
    ...(options.issue ? { issueRef: options.issue } : {}),
    ...(options.actor ? { actor: options.actor } : {}),
  });

  writeCommandSuccess(context, {
    text: [
      `Started task: ${result.task.title}`,
      `Goal: ${result.task.goal}`,
      `Constraints: ${result.task.constraints.length > 0 ? result.task.constraints.join('; ') : 'none'}`,
      `Issue: ${result.task.issueRef ?? 'none'}`,
      `Session: ${result.session.id}`,
    ],
    data: {
      session_id: result.session.id,
      task_id: result.task.id,
      task: result.task,
      session: result.session,
    },
  });
}

export async function sessionListCommand(context: CommandContext) {
  const result = await listSessions(context.cwd);

  writeCommandSuccess(context, {
    text: [
      `Sessions: ${result.sessions.length}`,
      ...(result.sessions.length > 0
        ? result.sessions.map(({ task, session }) => `${session.id}  ${task.status}  ${task.title}`)
        : ['none']),
    ],
    data: {
      sessions: result.sessions.map(({ task, session, active }) => ({
        session_id: session.id,
        task_id: task.id,
        title: task.title,
        status: task.status,
        state_version: task.stateVersion,
        active,
        ended_at: session.endedAt,
      })),
    },
  });
}

export async function sessionStatusCommand(context: CommandContext, options: { session?: string }) {
  const { task, session, entries, repoSnapshot } = await getStatus(context.cwd, requireSessionId(options));
  const counts = countEntryKinds(entries);

  writeCommandSuccess(context, {
    text: [
      `Task: ${task.title}`,
      `Session: ${session.id}`,
      `Goal: ${task.goal}`,
      `Issue: ${task.issueRef ?? 'not set'}`,
      `Status: ${task.status}`,
      `State version: ${task.stateVersion}`,
      `Branch: ${repoSnapshot?.branch ?? session.branch}`,
      `Base ref: ${session.baseRef ?? 'not set'}`,
      `Entries: ${entries.length}`,
      `Changed files: ${repoSnapshot?.changedFiles.length ?? 0}`,
      `Entry kinds: ${
        Object.keys(counts).length > 0
          ? Object.entries(counts)
              .map(([kind, count]) => `${kind}=${count}`)
              .join(', ')
          : 'none'
      }`,
    ],
    data: {
      session_id: session.id,
      task_id: task.id,
      task: {
        id: task.id,
        title: task.title,
        goal: task.goal,
        issue_ref: task.issueRef,
        status: task.status,
        state_version: task.stateVersion,
      },
      session: {
        id: session.id,
        ended_at: session.endedAt,
        started_at: session.startedAt,
        base_ref: session.baseRef,
        branch: repoSnapshot?.branch ?? session.branch,
        head_sha: repoSnapshot?.headSha ?? session.headSha,
        last_heartbeat_at: session.lastHeartbeatAt,
        last_heartbeat_source: session.lastHeartbeatSource,
      },
      entries: {
        count: entries.length,
        kinds: counts,
      },
      repo_snapshot: repoSnapshot,
    },
  });
}

export async function sessionCaptureCommand(
  context: CommandContext,
  kind: EntryKind,
  text: string | undefined,
  options: { session?: string; because?: string; edit?: boolean; actor?: EntrySource },
) {
  const sessionId = requireSessionId(options);
  const body = options.edit ? await readTextFromEditor(text ?? '') : text?.trim();
  if (!body) {
    throw createInvalidArgumentError('Capture text is required. Pass text directly or use --edit.');
  }

  const result = await captureEntry({
    cwd: context.cwd,
    kind,
    body,
    sessionId,
    ...(options.because ? { because: options.because } : {}),
    ...(options.actor ? { actor: options.actor } : {}),
  });

  writeCommandSuccess(context, {
    text: [`Captured ${result.entry.kind}: ${result.entry.body}`, `Session: ${result.session.id}`],
    data: {
      session_id: result.session.id,
      task: result.task,
      session: result.session,
      entry: result.entry,
    },
  });
}

export async function sessionHeartbeatCommand(
  context: CommandContext,
  options: { session?: string; source?: HeartbeatSource },
) {
  const result = await heartbeatSession({
    cwd: context.cwd,
    sessionId: requireSessionId(options),
    ...(options.source ? { source: options.source } : {}),
  });

  writeCommandSuccess(context, {
    text: [
      `Heartbeat recorded for ${result.session.id}`,
      `Branch: ${result.session.branch}`,
      `Head: ${result.session.headSha}`,
    ],
    data: {
      session_id: result.session.id,
      task: result.task,
      session: {
        id: result.session.id,
        branch: result.session.branch,
        head_sha: result.session.headSha,
        last_heartbeat_at: result.session.lastHeartbeatAt,
        last_heartbeat_source: result.session.lastHeartbeatSource,
      },
    },
  });
}

export async function sessionTransitionCommand(
  context: CommandContext,
  targetState: TaskStatus,
  options: SessionOptions & {
    expectedStateVersion: number;
    idempotencyKey: string;
    actor: EntrySource;
    input: Record<string, unknown>;
  },
) {
  const result = await transitionSession({
    cwd: context.cwd,
    sessionId: options.session,
    targetState,
    expectedStateVersion: options.expectedStateVersion,
    idempotencyKey: options.idempotencyKey,
    actor: options.actor,
    input: options.input,
  });

  if (!result.ok) {
    throw new ThreadloopError(result.error.code, result.error.message, {
      ...(result.error.details ? { details: result.error.details } : {}),
    });
  }

  writeCommandSuccess(context, {
    text: [
      `Transitioned session ${result.data.session_id}: ${result.data.transition.from_state} -> ${result.data.transition.to_state}`,
      `State version: ${result.data.lifecycle.state_version}`,
    ],
    data: result.data,
  });
}

export async function sessionNextCommand(context: CommandContext, options: SessionOptions) {
  const result = await getNextSessionAction({ cwd: context.cwd, sessionId: options.session });

  const target = result.candidate?.target_state ?? result.terminal_reason ?? 'none';
  writeCommandSuccess(context, {
    text: [
      `Session ${result.session_id}: ${result.lifecycle.state} @ ${result.lifecycle.state_version}`,
      `Next: ${target}`,
      `Executable: ${result.candidate?.executable ?? false}`,
    ],
    data: result,
  });
}

export async function sessionGateRunCommand(context: CommandContext, gateId: string, options: SessionOptions) {
  const result = await runSessionGate({ cwd: context.cwd, sessionId: options.session, gateId });
  writeCommandSuccess(context, {
    text: [
      `Gate ${result.receipt.gate_id}: ${result.receipt.result}`,
      `Receipt: ${result.receipt.id} (#${result.receipt.sequence})`,
    ],
    data: result,
  });
}

export async function sessionGateImportCommand(context: CommandContext, packagePath: string, options: SessionOptions) {
  const result = await importSessionGateReceipt({
    cwd: context.cwd,
    sessionId: options.session,
    packagePath,
    receiptFileSystem: nodeSignedReceiptFileSystem,
  });
  writeCommandSuccess(context, {
    text: [
      `Signed CI gate ${result.receipt.gate_id}: ${result.receipt.result}`,
      `Receipt: ${result.receipt.id} (#${result.receipt.sequence})`,
      `Already imported: ${result.already_imported ? 'yes' : 'no'}`,
    ],
    data: result,
  });
}

export async function sessionReviewImportCommand(
  context: CommandContext,
  packagePath: string,
  options: SessionOptions,
) {
  const result = await importSessionReviewReceipt({
    cwd: context.cwd,
    sessionId: options.session,
    packagePath,
    receiptFileSystem: nodeSignedReceiptFileSystem,
  });
  writeCommandSuccess(context, {
    text: [
      `Signed review PR #${result.receipt.pull_request_number}: ${result.review.status}`,
      `Receipt: ${result.receipt.id} (#${result.receipt.sequence})`,
      `Already imported: ${result.already_imported ? 'yes' : 'no'}`,
    ],
    data: result,
  });
}

export async function sessionReconcileCommand(context: CommandContext, options: { session?: string; all?: boolean }) {
  const sessionId = options.session?.trim() || undefined;
  if (sessionId && options.all) {
    throw createInvalidArgumentError('Pass either --session <id> or --all, not both.');
  }

  const results = await reconcileSession({
    cwd: context.cwd,
    reconcileAll: options.all ?? false,
    ...(sessionId ? { sessionId } : {}),
  });

  if (results.length === 0) {
    writeCommandSuccess(context, {
      text: ['No active sessions to reconcile.'],
      data: { reconciled: 0 },
    });
    return;
  }

  writeCommandSuccess(context, {
    text: results.map(({ sessionId, currentSnapshot, previousSnapshot }) => {
      const previous = previousSnapshot ? ` (was ${previousSnapshot.headSha.slice(0, 7)})` : ' (initial)';
      return `Reconciled ${sessionId}: ${currentSnapshot.branch} @ ${currentSnapshot.headSha.slice(0, 7)}${previous}, ${currentSnapshot.changedFiles.length} files changed`;
    }),
    data: {
      reconciled: results.length,
      sessions: results.map(({ sessionId, currentSnapshot, previousSnapshot, reconciledAt }) => ({
        session_id: sessionId,
        branch: currentSnapshot.branch,
        head_sha: currentSnapshot.headSha,
        changed_files: currentSnapshot.changedFiles.length,
        previous_head_sha: previousSnapshot?.headSha ?? null,
        reconciled_at: reconciledAt,
      })),
    },
  });
}
