import { writeCommandSuccess, type CommandContext } from './runtime.js';
import { listSessions } from '../services/session-service.js';

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
