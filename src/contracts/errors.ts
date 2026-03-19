export const THREADLOOP_ERROR_CODES = [
  'SESSION_NOT_FOUND',
  'SESSION_REQUIRED',
  'SESSION_AMBIGUOUS',
  'THREADLOOP_NOT_INITIALIZED',
  'INVALID_ARGUMENT',
  'BASE_REF_NOT_FOUND',
  'NOT_GIT_REPOSITORY',
  'STATE_CORRUPTED',
] as const;

export type ThreadloopErrorCode = (typeof THREADLOOP_ERROR_CODES)[number];

export interface ThreadloopErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class ThreadloopError extends Error {
  readonly code: ThreadloopErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ThreadloopErrorCode, message: string, options: ThreadloopErrorOptions = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'ThreadloopError';
    this.code = code;
    this.details = options.details;
  }
}

export function isThreadloopError(error: unknown): error is ThreadloopError {
  return error instanceof ThreadloopError;
}

export function createInvalidArgumentError(message: string, details?: Record<string, unknown>) {
  return new ThreadloopError('INVALID_ARGUMENT', message, { details });
}

export function toThreadloopError(error: unknown) {
  if (isThreadloopError(error)) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new ThreadloopError('INVALID_ARGUMENT', message, error instanceof Error ? { cause: error } : undefined);
}
