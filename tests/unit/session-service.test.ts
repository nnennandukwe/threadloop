import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTemporaryState, makeRepo } from '../helpers/session.js';
import { withStateDb } from '../helpers/state-db.js';
import { captureEntry, initThreadloop, startTask } from '../../src/services/session-service.js';

afterEach(cleanupTemporaryState);

// Auto-initialization, live artifact snapshots, and explicit selection among several active sessions are proven
// end to end through the CLI in tests/integration/cli.test.ts.
describe('session service', () => {
  it('resolves sessions from tasks and sessions, never from the stored active-session projection', async () => {
    const repoDir = await makeRepo();
    await initThreadloop(repoDir);
    const task = (title: string) =>
      startTask({ cwd: repoDir, title, goal: `Own ${title}`, constraints: [], baseRef: null });
    const first = await task('First registry task');
    const second = await task('Second registry task');

    withStateDb(
      repoDir,
      (db) =>
        db.prepare(`UPDATE active_sessions SET task_id = ? WHERE session_id = ?`).run(second.task.id, first.session.id),
      { readOnly: false },
    );

    const captured = await captureEntry({
      cwd: repoDir,
      sessionId: first.session.id,
      kind: 'note',
      body: 'Attaches to the task that owns the session',
    });
    expect(captured.task.id).toBe(first.task.id);
  });
});
