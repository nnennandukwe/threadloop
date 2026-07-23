import { getNextSessionAction } from '../services/session-service.js';
import { type CommandContext, type JsonOption, writeCommandSuccess } from './runtime.js';

export interface SessionNextOptions extends JsonOption {
  session: string;
}

export async function sessionNextCommand(context: CommandContext, options: SessionNextOptions) {
  const result = await getNextSessionAction({
    cwd: context.cwd,
    sessionId: options.session,
  });

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
