import { ThreadloopError } from '../contracts/errors.js';
import type { EntrySource, TaskStatus } from '../domain/types.js';
import { transitionSession } from '../services/session-service.js';
import { type CommandContext, type JsonOption, writeCommandSuccess } from './runtime.js';

export interface SessionTransitionOptions extends JsonOption {
  session: string;
  expectedStateVersion: number;
  idempotencyKey: string;
  actor: EntrySource;
  input: Record<string, unknown>;
}

export async function sessionTransitionCommand(
  context: CommandContext,
  targetState: TaskStatus,
  options: SessionTransitionOptions,
) {
  const result = await transitionSession({
    cwd: context.cwd,
    sessionId: options.session,
    targetState,
    expectedStateVersion: options.expectedStateVersion,
    idempotencyKey: options.idempotencyKey,
    actor: options.actor,
    input: options.input,
  });

  if (!result.ok) {
    throw new ThreadloopError(result.error.code, result.error.message, {
      ...(result.error.details ? { details: result.error.details } : {}),
    });
  }

  writeCommandSuccess(context, {
    text: [
      `Transitioned session ${result.data.session_id}: ${result.data.transition.from_state} -> ${result.data.transition.to_state}`,
      `State version: ${result.data.lifecycle.state_version}`,
    ],
    data: result.data,
  });
}
