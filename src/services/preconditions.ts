import { AuditChainCorruptedError, readConfig } from '../adapters/fs/sqlite-store.js';
import { isThreadloopInitialized } from '../adapters/fs/repo.js';
import { resolveRepoRoot } from '../adapters/git/client.js';
import { ThreadloopError } from '../contracts/errors.js';

/** Checks every service entry point makes before touching state, and the error mapping they share. */

export async function resolveRepositoryRoot(cwd: string) {
  try {
    return await resolveRepoRoot(cwd);
  } catch (error) {
    throw new ThreadloopError('NOT_GIT_REPOSITORY', 'ThreadLoop requires a Git repository. Run `git init` first.', {
      cause: error,
    });
  }
}

export async function assertInitializedReadOnly(repoRoot: string) {
  if (!isThreadloopInitialized(repoRoot)) {
    throw new ThreadloopError(
      'THREADLOOP_NOT_INITIALIZED',
      'ThreadLoop is not initialized in this repo. Run `threadloop init` first.',
    );
  }
  await readConfig(repoRoot);
}

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
