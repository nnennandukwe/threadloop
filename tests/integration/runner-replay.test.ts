import { afterEach, describe, expect, it } from 'vitest';
import { parseJson, runCli, runCliError, transitionArgs, type ErrorEnvelope } from '../helpers/cli.js';
import { cleanupTemporaryState, git, makeCommittedRepo, startSession } from '../helpers/session.js';

interface AuditShow {
  verification: { valid: boolean };
  events: Array<{ event: { event_type: string; payload: Record<string, unknown> } }>;
}

afterEach(cleanupTemporaryState);

async function makeQueuedSession() {
  const repoDir = await makeCommittedRepo({ branch: 'issue-69/pre-pr-local-iteration', remote: null });
  const { session_id: sessionId } = await startSession(repoDir, 'Runner lifecycle proof', ['--issue', '#69']);
  await git(repoDir, 'add', '.threadloop/config.json');
  await git(repoDir, 'commit', '-m', 'initialize ThreadLoop');
  return { repoDir, sessionId };
}

/** One serialized runner wake that frames the queued session. */
const frameArgs = (sessionId: string, key: string, input: Record<string, unknown> = {}) =>
  transitionArgs(sessionId, 'framed', 0, key, input);

async function auditShow(repoDir: string, sessionId: string) {
  return parseJson<{ data: AuditShow }>(
    (await runCli(repoDir, ['audit', 'show', '--session', sessionId, '--json'])).stdout,
  ).data;
}

function transitionEvents(audit: AuditShow) {
  return audit.events.filter(({ event }) => event.event_type === 'transition_applied');
}

describe('threadloop runner v4 contract', () => {
  it('returns one stored result for an exact duplicate or lost response and rejects changed bytes', async () => {
    const { repoDir, sessionId } = await makeQueuedSession();
    const key = 'runner:v1:duplicate-delivery:0';
    const args = frameArgs(sessionId, key);

    const [first, concurrentDuplicate] = await Promise.all([runCli(repoDir, args), runCli(repoDir, args)]);
    expect(concurrentDuplicate.stdout).toBe(first.stdout);
    const auditAfterDelivery = await auditShow(repoDir, sessionId);
    expect(transitionEvents(auditAfterDelivery)).toHaveLength(1);

    const lostResponseRetry = await runCli(repoDir, args);
    expect(lostResponseRetry.stdout).toBe(first.stdout);
    expect(await auditShow(repoDir, sessionId)).toEqual(auditAfterDelivery);

    const { error } = await runCliError(repoDir, frameArgs(sessionId, key, { changed_request: true }));
    expect(error).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      details: { session_id: sessionId, idempotency_key: key },
    });
    expect(error.details.request_sha256).not.toBe(error.details.existing_request_sha256);
    expect(transitionEvents(await auditShow(repoDir, sessionId))).toHaveLength(1);
  });

  it('allows only one transition when distinct serialized-wake identities race from one version', async () => {
    const { repoDir, sessionId } = await makeQueuedSession();
    const race = await Promise.allSettled([
      runCli(repoDir, frameArgs(sessionId, 'runner:v1:race-left:0')),
      runCli(repoDir, frameArgs(sessionId, 'runner:v1:race-right:0')),
    ]);
    expect(race.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const failure = race.find(({ status }) => status === 'rejected') as PromiseRejectedResult;
    const loser = parseJson<ErrorEnvelope>((failure.reason as Error & { stderr?: string }).stderr);
    expect(loser.error).toMatchObject({
      code: 'STATE_VERSION_CONFLICT',
      details: { expected_state_version: 0, actual_state: 'framed', actual_state_version: 1 },
    });
    const audit = await auditShow(repoDir, sessionId);
    expect(transitionEvents(audit)).toHaveLength(1);
    expect(audit.verification.valid).toBe(true);
  });
});
