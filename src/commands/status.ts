import type { CommandContext } from './runtime.js';
import type { SessionStatusOptions } from './session-status.js';
import { sessionStatusCommand } from './session-status.js';

export async function statusCommand(context: CommandContext, options: SessionStatusOptions) {
  return sessionStatusCommand(context, options, true);
}
