import { finishSession } from '../services/session-service.js';
import { ThreadloopError } from '../contracts/errors.js';
import {
  toSessionId,
  type CommandContext,
  type JsonOption,
  type SessionOption,
  writeCommandSuccess,
} from './runtime.js';

export type SessionFinishOptions = JsonOption & SessionOption;

export async function sessionFinishCommand(
  context: CommandContext,
  options: SessionFinishOptions,
  allowLegacySingleActive = false,
) {
  const sessionId = toSessionId(options);
  if (!sessionId && !allowLegacySingleActive) {
    throw new ThreadloopError('SESSION_REQUIRED', 'A session id is required for this command.', {
      details: { hint: 'Pass --session <id>.' },
    });
  }

  const result = await finishSession(context.cwd, sessionId ? { sessionId } : { allowLegacySingleActive: true });

  writeCommandSuccess(context, {
    text: [`Finished session ${result.sessionId}`],
    data: {
      session_id: result.sessionId,
      task_id: result.taskId,
    },
  });
}
