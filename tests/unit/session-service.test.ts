import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { isThreadloopError } from '../../src/contracts/errors.js';
import {
  captureEntry,
  finishSession,
  getStatus,
  initThreadloop,
  listSessions,
  startTask,
} from '../../src/services/session-service.js';

const execFileAsync = promisify(execFile);

async function makeRepo() {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), 'threadloop-service-'));
  await execFileAsync('git', ['init'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  return repoDir;
}

describe('session service', () => {
  it('requires explicit selection when multiple sessions are active', async () => {
    const repoDir = await makeRepo();
    await initThreadloop(repoDir);

    const first = await startTask({
      cwd: repoDir,
      title: 'First task',
      goal: 'Track first task',
      constraints: [],
      baseRef: null,
    });
    const second = await startTask({
      cwd: repoDir,
      title: 'Second task',
      goal: 'Track second task',
      constraints: [],
      baseRef: null,
    });

    await expect(captureEntry({
      cwd: repoDir,
      kind: 'note',
      body: 'Implicit capture should fail',
    })).rejects.toSatisfy((error: unknown) => {
      expect(isThreadloopError(error)).toBe(true);
      expect((error as { code?: string }).code).toBe('SESSION_AMBIGUOUS');
      return true;
    });

    const captured = await captureEntry({
      cwd: repoDir,
      sessionId: second.session.id,
      kind: 'decision',
      body: 'Explicit capture works',
      because: 'Machine consumers target sessions directly',
    });
    expect(captured.session.id).toBe(second.session.id);

    const listed = await listSessions(repoDir);
    expect(listed.sessions).toHaveLength(2);
    expect(listed.sessions.find((item) => item.session.id === first.session.id)?.active).toBe(true);
    expect(listed.sessions.find((item) => item.session.id === second.session.id)?.active).toBe(true);
  });

  it('keeps explicit status available after finishing a session', async () => {
    const repoDir = await makeRepo();
    await initThreadloop(repoDir);

    const started = await startTask({
      cwd: repoDir,
      title: 'Finishable task',
      goal: 'Retain ended session visibility',
      constraints: [],
      baseRef: null,
    });

    await finishSession(repoDir, { sessionId: started.session.id });

    const status = await getStatus(repoDir, { sessionId: started.session.id });
    expect(status.active?.session.id).toBe(started.session.id);
    expect(status.active?.session.endedAt).toBeTruthy();
    expect(status.repoSnapshot).toBeNull();

    const listed = await listSessions(repoDir);
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]?.active).toBe(false);
    expect(listed.sessions[0]?.session.endedAt).toBeTruthy();
  });
});
