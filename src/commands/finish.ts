import type { CommandContext } from './runtime.js';
import type { SessionFinishOptions } from './session-finish.js';
import { sessionFinishCommand } from './session-finish.js';

export async function finishCommand(context: CommandContext, options: SessionFinishOptions) {
  return sessionFinishCommand(context, options, true);
}
