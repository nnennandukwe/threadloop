import type { Command } from 'commander';
import { ThreadloopError } from '../contracts/errors.js';
import type { Entry } from '../domain/types.js';
import { renderCommandSuccess, type CommandOutput } from '../contracts/output.js';

export interface CommandContext {
  cwd: string;
  json: boolean;
  command: string;
}

export function createCommandContext(commandName: string, command: Command): CommandContext {
  return {
    cwd: process.cwd(),
    json: Boolean(command.optsWithGlobals().json),
    command: commandName,
  };
}

export function writeCommandSuccess<T>(context: CommandContext, output: CommandOutput<T>) {
  process.stdout.write(`${renderCommandSuccess(context.command, output, context.json)}\n`);
}

/** Commands that act on one session take it explicitly; there is no implicit current session. */
export function requireSessionId(options: { session?: string }) {
  const sessionId = options.session?.trim();
  if (!sessionId) {
    throw new ThreadloopError('SESSION_REQUIRED', 'A session id is required for this command.', {
      details: { hint: 'Pass --session <id>.' },
    });
  }
  return sessionId;
}

export function countEntryKinds(entries: Entry[]) {
  return entries.reduce<Record<string, number>>((counts, entry) => {
    counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
    return counts;
  }, {});
}
