import { writeCommandSuccess, type CommandContext } from './runtime.js';
import { listSessions } from '../services/session-service.js';

export async function sessionListCommand(context: CommandContext) {
  const result = await listSessions(context.cwd);

  writeCommandSuccess(context, {
    text: [
      `Active sessions: ${result.sessions.length}`,
      ...(result.sessions.length > 0
        ? result.sessions.map(({ task, session, active }) => `${session.id}  ${active ? 'active' : 'completed'}  ${task.title}`)
        : ['none']),
    ],
    data: {
      sessions: result.sessions.map(({ task, session, active }) => ({
        session_id: session.id,
        task_id: task.id,
        title: task.title,
        active,
        ended_at: session.endedAt,
      })),
    },
  });
}
