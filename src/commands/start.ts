import type { CommandContext } from './runtime.js';
import type { StartOptions } from './session-start.js';
import { sessionStartCommand } from './session-start.js';

export async function startCommand(context: CommandContext, title: string, options: StartOptions) {
  return sessionStartCommand(context, title, options, false);
}
