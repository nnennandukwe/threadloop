import {
  countEntryKinds,
  toSessionId,
  type CommandContext,
  type JsonOption,
  type SessionOption,
  writeCommandSuccess,
} from './runtime.js';
import { ThreadloopError } from '../contracts/errors.js';
import { getStatus } from '../services/session-service.js';

export type SessionStatusOptions = JsonOption & SessionOption;

export async function sessionStatusCommand(
  context: CommandContext,
  options: SessionStatusOptions,
  allowLegacySingleActive = false,
) {
  const sessionId = toSessionId(options);
  if (!sessionId && !allowLegacySingleActive) {
    throw new ThreadloopError('SESSION_REQUIRED', 'A session id is required for this command.', {
      details: { hint: 'Pass --session <id>.' },
    });
  }

  const result = await getStatus(context.cwd, sessionId ? { sessionId } : { allowLegacySingleActive: true });

  // For legacy convenience commands, fail safely when zero sessions match
  if (!result.active && !sessionId && allowLegacySingleActive) {
    throw new ThreadloopError('SESSION_REQUIRED', 'No active session.', {
      details: { hint: 'Start one with `threadloop session start`.' },
    });
  }

  if (!result.active) {
    writeCommandSuccess(context, {
      text: ['No active session.'],
      data: { session: null, task: null, entries: { count: 0, kinds: {} }, repo_snapshot: null },
    });
    return;
  }

  const { task, session } = result.active;
  const counts = countEntryKinds(result.entries);

  writeCommandSuccess(context, {
    text: [
      `Task: ${task.title}`,
      `Session: ${session.id}`,
      `Goal: ${task.goal}`,
      `Issue: ${task.issueRef ?? 'not set'}`,
      `Status: ${task.status}`,
      `State version: ${task.stateVersion}`,
      `Branch: ${result.repoSnapshot?.branch ?? session.branch}`,
      `Base ref: ${session.baseRef ?? 'not set'}`,
      `Entries: ${result.entries.length}`,
      `Changed files: ${result.repoSnapshot?.changedFiles.length ?? 0}`,
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
        branch: result.repoSnapshot?.branch ?? session.branch,
        head_sha: result.repoSnapshot?.headSha ?? session.headSha,
        last_heartbeat_at: session.lastHeartbeatAt,
        last_heartbeat_source: session.lastHeartbeatSource,
      },
      entries: {
        count: result.entries.length,
        kinds: counts,
      },
      repo_snapshot: result.repoSnapshot,
    },
  });
}
