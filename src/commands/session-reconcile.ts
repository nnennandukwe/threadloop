import type { CommandContext, JsonOption, SessionOption } from './runtime.js';
import { writeCommandSuccess } from './runtime.js';
import { reconcileSession } from '../services/session-service.js';

export type SessionReconcileOptions = JsonOption & SessionOption & { all?: boolean };

export async function sessionReconcileCommand(context: CommandContext, options: SessionReconcileOptions) {
  const sessionId = options.session;
  const reconcileAll = options.all ?? false;

  const results = await reconcileSession({
    cwd: context.cwd,
    sessionId,
    reconcileAll,
  });

  if (results.length === 0) {
    writeCommandSuccess(context, {
      text: ['No active sessions to reconcile.'],
      data: { reconciled: 0 },
    });
    return;
  }

  writeCommandSuccess(context, {
    text: results.map((r) => {
      const changed = r.currentSnapshot.changedFiles.length;
      const prev = r.previousSnapshot ? ` (was ${r.previousSnapshot.headSha.slice(0, 7)})` : ' (initial)';
      return `Reconciled ${r.sessionId}: ${r.currentSnapshot.branch} @ ${r.currentSnapshot.headSha.slice(0, 7)}${prev}, ${changed} files changed`;
    }),
    data: {
      reconciled: results.length,
      sessions: results.map((r) => ({
        session_id: r.sessionId,
        branch: r.currentSnapshot.branch,
        head_sha: r.currentSnapshot.headSha,
        changed_files: r.currentSnapshot.changedFiles.length,
        previous_head_sha: r.previousSnapshot?.headSha ?? null,
        reconciled_at: r.reconciledAt,
      })),
    },
  });
}
