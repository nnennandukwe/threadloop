import { AuditChainCorruptedError } from '../adapters/fs/sqlite-store.js';
import { ThreadloopError } from '../contracts/errors.js';

const CONTROLLER_WRITE_RECOVERY =
  'Restore the audit ledger from trusted storage before retrying this controller write.';

export function mapAuditChainCorruption(
  sessionId: string,
  error: AuditChainCorruptedError,
  hint = CONTROLLER_WRITE_RECOVERY,
) {
  return new ThreadloopError('AUDIT_VERIFICATION_FAILED', error.message, {
    cause: error,
    details: {
      session_id: sessionId,
      audit_error: {
        code: error.code,
        ...(error.sequence === undefined ? {} : { sequence: error.sequence }),
      },
      hint,
    },
  });
}
