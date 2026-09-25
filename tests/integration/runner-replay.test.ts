import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parseJson, runCli, runCliFailure } from '../helpers/cli.js';
import { closeSqliteConnections } from '../../src/adapters/fs/sqlite-store.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

interface Envelope<T> {
  ok: true;
  command: string;
  data: T;
}

interface FailureEnvelope {
  ok: false;
  command: string;
  error: {
    code: string;
    details?: Record<string, unknown>;
  };
}

interface AuditShow {
  verification: { valid: boolean };
  events: Array<{
    event: {
      event_type: string;
      payload: Record<string, unknown>;
    };
  }>;
}

afterEach(async () => {
  closeSqliteConnections();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeQueuedSession() {
  const repoDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'threadloop-runner-')));
  temporaryDirectories.push(repoDir);
  await execFileAsync('git', ['init'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.email', 'runner@example.com'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'ThreadLoop Runner'], { cwd: repoDir });
  await writeFile(path.join(repoDir, 'README.md'), '# ThreadLoop runner delivery proof\n', 'utf8');
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-m', 'runner test baseline'], { cwd: repoDir });
  await execFileAsync('git', ['branch', '-M', 'issue-69/pre-pr-local-iteration'], { cwd: repoDir });

  const started = parseJson<Envelope<{ session_id: string }>>(
    (
      await runCli(repoDir, [
        'session',
        'start',
        'Runner lifecycle proof',
        '--goal',
        'Prove serialized wake and retry semantics',
        '--issue',
        '#69',
        '--json',
      ])
    ).stdout,
  );
  await execFileAsync('git', ['add', '.threadloop/config.json'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-m', 'initialize ThreadLoop'], { cwd: repoDir });
  return { repoDir, sessionId: started.data.session_id };
}

function transitionArgs(sessionId: string, key: string, input: Record<string, unknown> = {}) {
  return [
    'session',
    'transition',
    'framed',
    '--session',
    sessionId,
    '--expected-state-version',
    '0',
    '--idempotency-key',
    key,
    '--actor',
    'agent',
    '--input',
    JSON.stringify(input),
    '--json',
  ];
}

async function auditShow(repoDir: string, sessionId: string) {
  return parseJson<Envelope<AuditShow>>(
    (await runCli(repoDir, ['audit', 'show', '--session', sessionId, '--json'])).stdout,
  );
}

function transitionEvents(audit: AuditShow) {
  return audit.events.filter(({ event }) => event.event_type === 'transition_applied');
}

describe('threadloop runner v4 contract', () => {
  it('returns one stored result for an exact duplicate or lost response and rejects changed bytes', async () => {
    const { repoDir, sessionId } = await makeQueuedSession();
    const key = 'runner:v1:duplicate-delivery:0';
    const args = transitionArgs(sessionId, key);

    const [first, concurrentDuplicate] = await Promise.all([runCli(repoDir, args), runCli(repoDir, args)]);
    expect(concurrentDuplicate.stdout).toBe(first.stdout);
    const auditAfterDelivery = await auditShow(repoDir, sessionId);
    expect(transitionEvents(auditAfterDelivery.data)).toHaveLength(1);

    const lostResponseRetry = await runCli(repoDir, args);
    expect(lostResponseRetry.stdout).toBe(first.stdout);
    expect((await auditShow(repoDir, sessionId)).data).toEqual(auditAfterDelivery.data);

    const conflict = parseJson<FailureEnvelope>(
      (await runCliFailure(repoDir, transitionArgs(sessionId, key, { changed_request: true }))).stderr,
    );
    expect(conflict.error).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      details: { session_id: sessionId, idempotency_key: key },
    });
    expect(conflict.error.details?.request_sha256).not.toBe(conflict.error.details?.existing_request_sha256);
    expect(transitionEvents((await auditShow(repoDir, sessionId)).data)).toHaveLength(1);
  });

  it('allows only one transition when distinct serialized-wake identities race from one version', async () => {
    const { repoDir, sessionId } = await makeQueuedSession();
    const race = await Promise.allSettled([
      runCli(repoDir, transitionArgs(sessionId, 'runner:v1:race-left:0')),
      runCli(repoDir, transitionArgs(sessionId, 'runner:v1:race-right:0')),
    ]);
    expect(race.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const failure = race.find(({ status }) => status === 'rejected') as PromiseRejectedResult;
    const loser = parseJson<FailureEnvelope>((failure.reason as Error & { stderr?: string }).stderr);
    expect(loser.error).toMatchObject({
      code: 'STATE_VERSION_CONFLICT',
      details: { expected_state_version: 0, actual_state: 'framed', actual_state_version: 1 },
    });
    const audit = await auditShow(repoDir, sessionId);
    expect(transitionEvents(audit.data)).toHaveLength(1);
    expect(audit.data.verification.valid).toBe(true);
  });
});
