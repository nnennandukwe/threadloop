import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from '../../src/adapters/fs/sqlite-driver.js';
import { readRepoSnapshot } from '../../src/adapters/fs/sqlite-store.js';
import { isThreadloopError } from '../../src/contracts/errors.js';
import {
  captureEntry,
  finishSession,
  generateArtifact,
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
  it('auto-initializes a repo on startTask and records agent issue metadata', async () => {
    const repoDir = await makeRepo();

    const started = await startTask({
      cwd: repoDir,
      title: 'Auto init task',
      goal: 'Start without manual init',
      constraints: [],
      baseRef: null,
      issueRef: 'ISSUE-13',
      actor: 'agent',
      allowMultipleActive: true,
    });

    const status = await getStatus(repoDir, { sessionId: started.session.id });
    expect(status.active?.task.issueRef).toBe('ISSUE-13');
    expect(status.active?.task).toMatchObject({ status: 'queued', stateVersion: 0 });
    expect(status.entries[0]).toMatchObject({ kind: 'intent', source: 'agent' });
    expect(status.repoSnapshot).not.toBeNull();
  });

  it('uses a live snapshot when generating an artifact for an active session', async () => {
    const repoDir = await makeRepo();

    const started = await startTask({
      cwd: repoDir,
      title: 'Live artifact snapshot',
      goal: 'Refresh scope during artifact generation',
      constraints: [],
      baseRef: null,
      allowMultipleActive: true,
    });

    await writeFile(path.join(repoDir, 'feature.ts'), 'export const feature = true;\n', 'utf8');

    const artifact = await generateArtifact(repoDir, 'change-brief', { sessionId: started.session.id });
    const content = await readFile(artifact.fullPath, 'utf8');
    const storedSnapshot = await readRepoSnapshot(repoDir, started.session.id);

    expect(artifact.artifact.snapshotSource).toBe('live');
    expect(content).toContain('feature.ts');
    expect(storedSnapshot?.changedFiles).toContain('feature.ts');
  });

  it('requires explicit selection when multiple sessions are active', async () => {
    const repoDir = await makeRepo();
    await initThreadloop(repoDir);

    const first = await startTask({
      cwd: repoDir,
      title: 'First task',
      goal: 'Track first task',
      constraints: [],
      baseRef: null,
      allowMultipleActive: true,
    });
    const second = await startTask({
      cwd: repoDir,
      title: 'Second task',
      goal: 'Track second task',
      constraints: [],
      baseRef: null,
      allowMultipleActive: true,
    });

    await expect(
      captureEntry({
        cwd: repoDir,
        kind: 'note',
        body: 'Implicit capture should fail',
      }),
    ).rejects.toSatisfy((error: unknown) => {
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

  it('rejects a session registry entry whose projected task does not own the session', async () => {
    const repoDir = await makeRepo();
    await initThreadloop(repoDir);

    const first = await startTask({
      cwd: repoDir,
      title: 'First registry task',
      goal: 'Own the first session',
      constraints: [],
      baseRef: null,
      allowMultipleActive: true,
    });
    const second = await startTask({
      cwd: repoDir,
      title: 'Second registry task',
      goal: 'Own the second session',
      constraints: [],
      baseRef: null,
      allowMultipleActive: true,
    });

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'));
    try {
      db.prepare(`UPDATE active_sessions SET task_id = ? WHERE session_id = ?`).run(second.task.id, first.session.id);
    } finally {
      db.close();
    }

    await expect(
      captureEntry({
        cwd: repoDir,
        sessionId: first.session.id,
        kind: 'note',
        body: 'This must not attach to the wrong task',
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(isThreadloopError(error)).toBe(true);
      expect((error as { code?: string }).code).toBe('STATE_CORRUPTED');
      return true;
    });
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
      allowMultipleActive: true,
    });

    await finishSession(repoDir, { sessionId: started.session.id });

    const status = await getStatus(repoDir, { sessionId: started.session.id });
    expect(status.active?.session.id).toBe(started.session.id);
    expect(status.active?.session.endedAt).toBeTruthy();
    expect(status.repoSnapshot).toBeNull();

    const listed = await listSessions(repoDir);
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]?.active).toBe(false);
    expect(listed.sessions[0]?.task).toMatchObject({ status: 'completed', stateVersion: 1 });
    expect(listed.sessions[0]?.session.endedAt).toBeTruthy();
  });

  it('blocks legacy root start when a session is already active', async () => {
    const repoDir = await makeRepo();
    await initThreadloop(repoDir);

    await startTask({
      cwd: repoDir,
      title: 'Existing task',
      goal: 'Keep the repo occupied',
      constraints: [],
      baseRef: null,
      allowMultipleActive: true,
    });

    await expect(
      startTask({
        cwd: repoDir,
        title: 'Legacy task',
        goal: 'Should fail for legacy compatibility',
        constraints: [],
        baseRef: null,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(isThreadloopError(error)).toBe(true);
      expect((error as { code?: string }).code).toBe('SESSION_AMBIGUOUS');
      return true;
    });
  });

  it('returns no active session for legacy status when none exist', async () => {
    const repoDir = await makeRepo();
    await initThreadloop(repoDir);

    const status = await getStatus(repoDir, { allowLegacySingleActive: true });
    expect(status.active).toBeNull();
    expect(status.entries).toEqual([]);
    expect(status.repoSnapshot).toBeNull();
  });
});
