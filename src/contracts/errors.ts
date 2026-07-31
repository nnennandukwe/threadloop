export const THREADLOOP_ERROR_CODES = [
  'SESSION_NOT_FOUND',
  'SESSION_REQUIRED',
  'SESSION_AMBIGUOUS',
  'THREADLOOP_NOT_INITIALIZED',
  'INVALID_ARGUMENT',
  'BASE_REF_NOT_FOUND',
  'NOT_GIT_REPOSITORY',
  'STATE_CORRUPTED',
  'SESSION_SCHEMA_MIGRATION_REQUIRED',
  'STATE_VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'TRANSITION_NOT_ALLOWED',
  'TRANSITION_GUARD_FAILED',
  'STATE_BUSY',
  'REPOSITORY_OBSERVATION_FAILED',
  'RECONCILE_TARGET_REQUIRED',
  'PROOF_PLAN_MISSING',
  'PROOF_PLAN_CORRUPTED',
  'GATE_NOT_DECLARED',
  'GATE_NOT_RUNNABLE',
  'GATE_PREFLIGHT_DIRTY',
  'RECEIPT_NOT_RECORDED',
  'SIGNED_RECEIPT_INVALID',
  'SIGNED_RECEIPT_SIGNATURE_INVALID',
  'SIGNED_RECEIPT_TRANSPARENCY_MISSING',
  'SIGNED_RECEIPT_IDENTITY_MISMATCH',
  'SIGNED_RECEIPT_ARTIFACT_MISMATCH',
  'SIGNED_RECEIPT_HEAD_MISMATCH',
  'SIGNED_RECEIPT_RESULT_REJECTED',
  'SIGNED_RECEIPT_SETUP_FAILED',
  'SIGNED_RECEIPT_CONFLICT',
  'SIGNED_RECEIPT_VERIFICATION_UNAVAILABLE',
  'AUDIT_UNAVAILABLE',
  'AUDIT_EMPTY',
  'AUDIT_VERIFICATION_FAILED',
  'AUDIT_EXPORT_CONFLICT',
  'AUDIT_EXPORT_FAILED',
] as const;

export type ThreadloopErrorCode = (typeof THREADLOOP_ERROR_CODES)[number];

export interface ThreadloopErrorOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class ThreadloopError extends Error {
  readonly code: ThreadloopErrorCode;
  readonly details: Record<string, unknown> | undefined;

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
  return new ThreadloopError('INVALID_ARGUMENT', message, details ? { details } : {});
}

export function toThreadloopError(error: unknown) {
  if (isThreadloopError(error)) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new ThreadloopError('INVALID_ARGUMENT', message, error instanceof Error ? { cause: error } : undefined);
}
