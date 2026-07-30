import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parseJson, runCli, runCliFailure } from '../helpers/cli.js';
import { resetSqliteConnections } from '../../src/adapters/fs/sqlite-store.js';

const execFileAsync = promisify(execFile);
const projectRoot = process.cwd();
const skillPath = path.join(projectRoot, '.agents/skills/threadloop-runner/SKILL.md');
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
  await resetSqliteConnections();
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
  it('pins the public v4 protocol and fail-closed lifecycle authority', async () => {
    const [{ readFile }, protocolResult] = await Promise.all([
      import('node:fs/promises'),
      runCli(projectRoot, ['protocol', '--json']),
    ]);
    const skill = await readFile(skillPath, 'utf8');
    const protocol = parseJson<
      Envelope<{
        contractVersions: Record<string, number>;
        commands: Record<string, string>;
      }>
    >(protocolResult.stdout);

    expect(protocol.data.contractVersions).toMatchObject({
      protocol: 4,
      proofPlan: 3,
      sessionNext: 4,
      handoff: 3,
    });
    expect(protocol.data.commands['session next']).toContain('--session <id> [--json]');
    expect(protocol.data.commands['session transition']).toContain(
      '--expected-state-version <version> --idempotency-key <key> --actor <actor> --input <json-object>',
    );
    expect(protocol.data.commands['session gate run']).toContain('<gate-id> --session <id> [--json]');

    expect(skill).toContain('Require exactly these four explicit inputs:');
    expect(skill).toContain('A wake may do exactly one of these:');
    expect(skill).toContain('pre_pr_reviewing');
    expect(skill).toContain('SESSION_SCHEMA_MIGRATION_REQUIRED -> MIGRATE_SESSION_SCHEMA');
    expect(skill).toContain('PRE_PR_REVIEW_OUTCOME_REQUIRED -> RECORD_PRE_PR_REVIEW_OUTCOME');
    expect(skill).toContain('IMPLEMENTATION_BASIS_NOT_ADVANCED -> COMMIT_IMPLEMENTATION');
    expect(skill).toContain('may recur across any number of serialized pre-PR `implementing` wakes');
    expect(skill).toContain('historical repair budget does not stop pre-PR implementation work.');
    expect(skill).toContain('Repair-budget exhaustion alone is not a stop');
    expect(skill).toContain('return to `verifying`, refresh proof, and progress without entering a fourth repair');
    expect(skill).not.toContain('phase is `post_pr` and repair budget is exhausted');
    expect(skill).toContain('Do not accept review evidence as a fifth wake input.');
    expect(skill).toContain('Never switch branches, rebase, reset, clean, stash');
    expect(skill).toContain('Never push, force-push, create a pull request, approve, merge, deploy, publish');
  });

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
