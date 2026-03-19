import type { Command } from 'commander';
import type { Entry } from '../domain/types.js';
import { renderCommandSuccess, type CommandOutput } from '../contracts/output.js';

export interface CommandContext {
  cwd: string;
  json: boolean;
  command: string;
}

export interface JsonOption {
  json?: boolean;
}

export interface SessionOption {
  session?: string;
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

export function toSessionId(options: SessionOption) {
  return options.session?.trim() || undefined;
}

export function countEntryKinds(entries: Entry[]) {
  return entries.reduce<Record<string, number>>((counts, entry) => {
    counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
    return counts;
  }, {});
}
