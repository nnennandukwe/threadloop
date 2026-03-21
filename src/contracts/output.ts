import type { ThreadloopErrorCode } from './errors.js';

export interface CommandSuccessEnvelope<T> {
  ok: true;
  command: string;
  data: T;
}

export interface CommandFailureEnvelope {
  ok: false;
  command: string;
  error: {
    code: ThreadloopErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface CommandOutput<T> {
  text: string[];
  data: T;
}

export function createCommandSuccessEnvelope<T>(command: string, data: T): CommandSuccessEnvelope<T> {
  return { ok: true, command, data };
}

export function createCommandFailureEnvelope(
  command: string,
  error: { code: ThreadloopErrorCode; message: string; details?: Record<string, unknown> },
): CommandFailureEnvelope {
  return {
    ok: false,
    command,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

export function renderCommandSuccess<T>(command: string, output: CommandOutput<T>, json: boolean) {
  if (json) {
    return JSON.stringify(createCommandSuccessEnvelope(command, output.data), null, 2);
  }

  return output.text.join('\n');
}

export function renderCommandFailure(
  command: string,
  error: { code: ThreadloopErrorCode; message: string; details?: Record<string, unknown> },
  json: boolean,
) {
  if (json) {
    return JSON.stringify(createCommandFailureEnvelope(command, error), null, 2);
  }

  const lines = [`threadloop [${error.code}]: ${error.message}`];
  const hint = error.details?.hint;

  if (typeof hint === 'string' && hint.trim().length > 0) {
    lines.push(`Hint: ${hint}`);
  }

  return lines.join('\n');
}
