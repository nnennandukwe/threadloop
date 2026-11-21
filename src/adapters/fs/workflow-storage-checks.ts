import { StateCorruptedError, ThreadloopError } from '../../contracts/errors.js';
import { canonicalJson } from '../../domain/canonical-json.js';

export function demand(ok: unknown, message: string): asserts ok {
  if (!ok) throw new StateCorruptedError(`Invalid Workflow Run storage: ${message}`);
}
export function equal(a: unknown, b: unknown) {
  return canonicalJson(a) === canonicalJson(b);
}
export function conflict(message: string): never {
  throw new ThreadloopError('IDEMPOTENCY_CONFLICT', message, {
    details: { reason: 'identity_reused', hint: 'Retry the original request or choose a new identity.' },
  });
}
export function expectVersion(actual: number, expected: number) {
  if (actual !== expected)
    throw new ThreadloopError('STATE_VERSION_CONFLICT', 'The Workflow Run version changed.', {
      details: {
        reason: 'stale_version',
        hint: 'Inspect the run, decide again, and retry with its current version.',
      },
    });
}
