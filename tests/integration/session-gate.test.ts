import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  gateRunArgs,
  parseJson,
  runCli,
  runCliError,
  runCliFailure,
  runGate,
  sessionNext,
  transition,
  transitionArgs,
  transitionFailure,
  type ErrorEnvelope,
} from '../helpers/cli.js';
import {
  cleanupTemporaryState,
  commitFiles,
  forceStates,
  git,
  makeCommittedRepo,
  makeTempDir,
  makeVerifyingSession,
  proofPlan,
  recordProofPlan,
  startFramedSession,
} from '../helpers/session.js';
import {
  countRows,
  readLifecycle,
  tamperAuditEventHash,
  withStateDb,
  withTriggersDisabled,
} from '../helpers/state-db.js';
import { closeSqliteConnections } from '../../src/adapters/fs/sqlite-store.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import type { ProofSetupStep } from '../../src/domain/proof.js';
import { fixtureBranch, fixtureRepository, workflowSha } from '../fixtures/receipts.js';

const execFileAsync = promisify(execFile);

/** A gate command that proves whether it ever started by writing `markerPath`. */
const writeMarker = (markerPath: string) => [
  'node',
  '-e',
  `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started")`,
];

function unignoredInstall() {
  const files = Array.from(
    { length: 300 },
    (_, index) => `node_modules/${String(index).padStart(3, '0')}/${'x'.repeat(160)}.txt`,
  );
  const command = [
    'node',
    '-e',
    `const fs = require("node:fs");
     for (let index = 0; index < 300; index++) {
       const directory = "node_modules/" + String(index).padStart(3, "0");
       fs.mkdirSync(directory, { recursive: true });
       fs.writeFileSync(directory + "/" + "x".repeat(160) + ".txt", "installed");
     }`,
  ];
  return { files, command };
}

/** Applies inherited ignores only to one child invocation, without changing user settings. */
async function makeGlobalIgnoreConfig(repoDir: string) {
  const directory = await makeTempDir('threadloop-global-ignore-');
  const excludesPath = path.join(directory, 'ignore');
  const configPath = path.join(directory, 'gitconfig');
  await writeFile(excludesPath, 'node_modules/\n', 'utf8');
  await git(repoDir, 'config', '--file', configPath, 'core.excludesFile', excludesPath);
  return configPath;
}

async function readExecution(repoDir: string, artifactPath: string) {
  return JSON.parse(await readFile(path.join(repoDir, artifactPath), 'utf8')) as {
    stdout: { path: string; sha256: string; bytes: number };
    stderr: { path: string; sha256: string; bytes: number };
  };
}

/** A verifying session, one gate run on it, and the run's receipt. */
async function verifyingSessionWithReceipt(plan = proofPlan()) {
  const fixture = await makeVerifyingSession({ plan });
  return { ...fixture, receipt: await runGate(fixture.repoDir, fixture.sessionId) };
}

afterEach(cleanupTemporaryState);

describe('proof plan persistence', () => {
  it('atomically stores one canonical plan bound to a clean baseline', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    const head = await git(repoDir, 'rev-parse', 'HEAD');
    const result = await recordProofPlan(repoDir, sessionId);

    expect(result.data).toMatchObject({
      lifecycle: { state: 'proof_ready', state_version: 2 },
      proof_plan: { baseline_branch: fixtureBranch, baseline_head_sha: head },
    });
    expect(result.data.proof_plan.sha256).toMatch(/^[a-f0-9]{64}$/);

    closeSqliteConnections(repoDir);
    withStateDb(repoDir, (db) => {
      expect(db.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get()).toEqual({ value: '8' });
      expect(
        db
          .prepare(`SELECT session_id, plan_json, plan_sha256, baseline_branch, baseline_head_sha FROM proof_plans`)
          .get(),
      ).toMatchObject({
        session_id: sessionId,
        plan_json: `{"acceptance_criteria":["All repository checks pass"],"ci":{"build_signer_sha":"${workflowSha}","build_signer_uri":"https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-gate-sensor.yml@${workflowSha}","certificate_identity":"${fixtureRepository}/.github/workflows/threadloop.yml@refs/heads/${fixtureBranch}","issuer":"https://token.actions.githubusercontent.com","provider":"github-actions","source_repository":"${fixtureRepository}"},"contract_version":4,"gates":[{"command":["node","-e","process.stdout.write(\\"ok\\\\n\\")"],"id":"check","timeout_ms":5000,"working_directory":"."}],"review":{"build_signer_sha":"${workflowSha}","build_signer_uri":"https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-review-sensor.yml@${workflowSha}","certificate_identity":"${fixtureRepository}/.github/workflows/threadloop.yml@refs/heads/${fixtureBranch}","issuer":"https://token.actions.githubusercontent.com","provider":"github-actions","source_repository":"${fixtureRepository}"}}`,
        plan_sha256: result.data.proof_plan.sha256,
        baseline_branch: fixtureBranch,
        baseline_head_sha: head,
      });
    });
  });

  it('rejects a committed symlink whose working directory resolves outside the repository', async () => {
    const repoDir = await makeCommittedRepo();
    await symlink(await makeTempDir('threadloop-gate-outside-'), path.join(repoDir, 'escape'));
    await git(repoDir, 'add', 'escape');
    await git(repoDir, 'commit', '-m', 'add escape symlink fixture');
    const sessionId = await startFramedSession(repoDir);

    const failure = await transitionFailure(repoDir, sessionId, 'proof_ready', 1, 'proof-plan:symlink-escape', {
      proof_plan: proofPlan({ command: ['node', '-e', 'process.exit(0)'], workingDirectory: 'escape' }),
    });
    expect(failure.error.code).toBe('INVALID_ARGUMENT');
    expect(failure.error.message).toContain('resolves outside the repository');
    expect(readLifecycle(repoDir)).toEqual({ status: 'framed', state_version: 1 });
    expect(countRows(repoDir, 'proof_plans')).toBe(0);
  });

  it.each([
    {
      name: 'dirty worktree',
      expectedGuard: 'PROOF_BASELINE_DIRTY',
      prepare: (repoDir: string) => writeFile(path.join(repoDir, 'dirty.txt'), 'dirty\n', 'utf8'),
      recover: (repoDir: string) => rm(path.join(repoDir, 'dirty.txt')),
    },
    {
      name: 'detached HEAD',
      expectedGuard: 'PROOF_BASELINE_BRANCH_REQUIRED',
      prepare: (repoDir: string) => git(repoDir, 'checkout', '--detach', 'HEAD'),
      recover: (repoDir: string) => git(repoDir, 'checkout', fixtureBranch),
    },
  ])(
    'durably rejects a $name proof baseline so the same request cannot later succeed',
    async ({ expectedGuard, prepare, recover }) => {
      const repoDir = await makeCommittedRepo();
      const sessionId = await startFramedSession(repoDir);
      const idempotencyKey = `proof-plan:rejected:${expectedGuard}`;
      const args = transitionArgs(sessionId, 'proof_ready', 1, idempotencyKey, { proof_plan: proofPlan() });

      await prepare(repoDir);
      const first = await runCliFailure(repoDir, args);
      expect(parseJson<ErrorEnvelope>(first.stderr).error).toMatchObject({
        code: 'TRANSITION_GUARD_FAILED',
        details: { guard_failures: [{ code: expectedGuard }] },
      });

      await recover(repoDir);
      expect((await runCliFailure(repoDir, args)).stderr).toBe(first.stderr);

      expect(readLifecycle(repoDir)).toEqual({ status: 'framed', state_version: 1 });
      expect(countRows(repoDir, 'transition_idempotency', 'idempotency_key = ?', idempotencyKey)).toBe(1);
      expect(
        countRows(repoDir, 'transition_idempotency', `idempotency_key = ? AND outcome = 'rejected'`, idempotencyKey),
      ).toBe(1);
      expect(guardDecisionCount(repoDir, sessionId, idempotencyKey)).toBe(1);
      expect(countRows(repoDir, 'proof_plans')).toBe(0);
    },
  );

  it('does not cache a structurally invalid proof plan as an evaluated guard decision', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    const idempotencyKey = 'proof-plan:structurally-invalid';

    const failure = await transitionFailure(repoDir, sessionId, 'proof_ready', 1, idempotencyKey, {
      proof_plan: { ...proofPlan(), contract_version: 99 },
    });
    expect(failure.error.code).toBe('INVALID_ARGUMENT');
    expect(countRows(repoDir, 'transition_idempotency', 'idempotency_key = ?', idempotencyKey)).toBe(0);
    expect(guardDecisionCount(repoDir, sessionId, idempotencyKey)).toBe(0);
  });
});

function guardDecisionCount(repoDir: string, sessionId: string, idempotencyKey: string) {
  return countRows(
    repoDir,
    'audit_events',
    `session_id = ? AND event_type = 'guard_decision' AND json_extract(event_json, '$.payload.idempotency_key') = ?`,
    sessionId,
    idempotencyKey,
  );
}

describe('session gate run', () => {
  it('executes the stored argv and appends a digest-bound passing receipt without advancing state', async () => {
    const { repoDir, sessionId } = await makeVerifyingSession();

    const result = parseJson<{
      command: string;
      data: {
        receipt: { id: string; head_before: string; head_after: string; artifact: { path: string; sha256: string } };
      };
    }>((await runCli(repoDir, gateRunArgs(sessionId))).stdout);

    expect(result).toMatchObject({
      command: 'session gate run',
      data: {
        receipt: {
          sequence: 1,
          session_id: sessionId,
          gate_id: 'check',
          result: 'passed',
          command: ['node', '-e', 'process.stdout.write("ok\\n")'],
          working_directory: '.',
          timeout_ms: 5_000,
          exit_status: 0,
          signal: null,
          clean_before: true,
          clean_after: true,
          sensor: { name: 'threadloop-local-gate', contract_version: 2 },
        },
        lifecycle: { state: 'verifying', state_version: 4 },
      },
    });
    const { receipt } = result.data;
    expect(receipt.id).toMatch(/^receipt_/);
    expect(receipt.head_after).toBe(receipt.head_before);
    expect(receipt.artifact.path).toMatch(
      new RegExp(`^\\.threadloop/artifacts/receipts/${sessionId}/receipt_.+/execution\\.json$`),
    );
    expect(receipt.artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    const execution = await readExecution(repoDir, receipt.artifact.path);
    expect(await readFile(path.join(repoDir, execution.stdout.path), 'utf8')).toBe('ok\n');
    expect(execution.stdout).toMatchObject({ bytes: 3 });
    expect(execution.stderr).toMatchObject({ bytes: 0 });

    expect(countRows(repoDir, 'gate_receipts')).toBe(1);
    expect(readLifecycle(repoDir)).toEqual({ status: 'verifying', state_version: 4 });
  });

  it('preserves arguments and a working directory containing spaces without shell parsing', async () => {
    const repoDir = await makeCommittedRepo();
    const workingDirectory = 'directory with spaces';
    await mkdir(path.join(repoDir, workingDirectory));
    await commitFiles(repoDir, 'add spaced directory', { [`${workingDirectory}/fixture.txt`]: 'fixture\n' });
    const command = [
      'node',
      '-e',
      'process.stdout.write(`${process.cwd()}\\n${process.argv[1]}\\n`)',
      'argument with spaces',
    ];
    const { sessionId } = await makeVerifyingSession({ repoDir, plan: proofPlan({ command, workingDirectory }) });

    const execution = await readExecution(repoDir, (await runGate(repoDir, sessionId)).artifact.path);
    expect(await readFile(path.join(repoDir, execution.stdout.path), 'utf8')).toBe(
      `${path.join(repoDir, workingDirectory)}\nargument with spaces\n`,
    );
  });

  it('rejects undeclared and dirty-preflight gates before starting a process or writing a receipt', async () => {
    const repoDir = await makeCommittedRepo();
    const markerPath = path.join(repoDir, 'gate-started.txt');
    const { sessionId } = await makeVerifyingSession({
      repoDir,
      plan: proofPlan({ command: writeMarker(markerPath) }),
    });

    expect((await runCliError(repoDir, gateRunArgs(sessionId, 'not-declared'))).error.code).toBe('GATE_NOT_DECLARED');
    expect(existsSync(markerPath)).toBe(false);

    await writeFile(path.join(repoDir, 'dirty.txt'), 'dirty\n', 'utf8');
    expect((await runCliError(repoDir, gateRunArgs(sessionId))).error.code).toBe('GATE_PREFLIGHT_DIRTY');
    expect(existsSync(markerPath)).toBe(false);
    expect(countRows(repoDir, 'gate_receipts')).toBe(0);
  });

  it('rejects a corrupt audit chain before starting the gate process or creating proof artifacts', async () => {
    const repoDir = await makeCommittedRepo();
    const markerPath = path.join(repoDir, 'gate-started.txt');
    const { sessionId } = await makeVerifyingSession({
      repoDir,
      plan: proofPlan({ command: writeMarker(markerPath) }),
    });
    closeSqliteConnections(repoDir);
    tamperAuditEventHash(repoDir, 2);

    expect(await runCliError(repoDir, gateRunArgs(sessionId))).toMatchObject({
      error: {
        code: 'AUDIT_VERIFICATION_FAILED',
        details: { audit_error: { code: 'AUDIT_HASH_MISMATCH', sequence: 2 } },
      },
    });
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(path.join(repoDir, '.threadloop', 'artifacts', 'receipts', sessionId))).toBe(false);
    expect(countRows(repoDir, 'gate_receipts')).toBe(0);
  });

  it('rejects task-projection drift before recording local gate evidence', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(repoDir, sessionId);
    closeSqliteConnections(repoDir);
    withStateDb(repoDir, (db) => db.prepare(`UPDATE tasks SET status = 'verifying', state_version = 4`).run(), {
      readOnly: false,
    });
    const auditCount = countRows(repoDir, 'audit_events', 'session_id = ?', sessionId);

    const failure = await runCliError(repoDir, gateRunArgs(sessionId));
    expect(failure.error.code).toBe('STATE_CORRUPTED');
    expect(failure.error.message).toContain('current lifecycle projection does not match transition history');
    expect(countRows(repoDir, 'gate_receipts')).toBe(0);
    expect(countRows(repoDir, 'audit_events', 'session_id = ?', sessionId)).toBe(auditCount);
  });

  it('classifies an inconsistent lifecycle row as state corruption rather than a bad argument', async () => {
    const { repoDir, sessionId } = await makeVerifyingSession();
    closeSqliteConnections(repoDir);
    withStateDb(repoDir, (db) => db.prepare(`UPDATE tasks SET blocked_from_state = 'implementing'`).run(), {
      readOnly: false,
    });

    expect((await runCliError(repoDir, gateRunArgs(sessionId))).error).toMatchObject({
      code: 'STATE_CORRUPTED',
      message: `Session ${sessionId} has an inconsistent blocked prior state.`,
    });
  });

  it('rejects gate execution after leaving the named proof-plan branch', async () => {
    const { repoDir, sessionId } = await makeVerifyingSession();
    await git(repoDir, 'checkout', '--detach', 'HEAD');

    expect((await runCliError(repoDir, gateRunArgs(sessionId))).error.code).toBe('GATE_NOT_RUNNABLE');
    expect(countRows(repoDir, 'gate_receipts')).toBe(0);
  });

  it.each([
    {
      name: 'non-zero exit',
      command: ['node', '-e', 'process.stderr.write("failed\\n"); process.exit(7)'],
      timeoutMs: 5_000,
      expectedResult: 'failed',
      expectedExit: 7,
    },
    {
      name: 'timeout',
      command: ['node', '-e', 'setTimeout(() => {}, 10000)'],
      timeoutMs: 50,
      expectedResult: 'timed_out',
      expectedExit: null,
    },
    {
      name: 'spawn error',
      command: ['threadloop-executable-that-does-not-exist'],
      timeoutMs: 5_000,
      expectedResult: 'execution_error',
      expectedExit: -2,
    },
    {
      name: 'worktree mutation',
      command: ['node', '-e', 'require("node:fs").writeFileSync("drift.txt", "changed\\n")'],
      timeoutMs: 5_000,
      expectedResult: 'invalidated',
      expectedExit: 0,
    },
  ])(
    'retains immutable nonpassing evidence for $name',
    async ({ command, timeoutMs, expectedResult, expectedExit }) => {
      const { repoDir, receipt } = await verifyingSessionWithReceipt(proofPlan({ command, timeoutMs }));

      expect(receipt).toMatchObject({ result: expectedResult, exit_status: expectedExit });
      expect(existsSync(path.join(repoDir, receipt.artifact.path))).toBe(true);
      expect(withStateDb(repoDir, (db) => db.prepare(`SELECT result FROM gate_receipts`).get())).toEqual({
        result: expectedResult,
      });
    },
  );

  it('binds an invalidated receipt to the pre-run commit when post-run Git observation fails', async () => {
    const { repoDir, sessionId } = await makeVerifyingSession({
      plan: proofPlan({ command: ['node', '-e', 'require("node:fs").renameSync(".git/HEAD", ".git/HEAD.saved")'] }),
    });

    const receipt = await runGate(repoDir, sessionId).finally(() =>
      rename(path.join(repoDir, '.git', 'HEAD.saved'), path.join(repoDir, '.git', 'HEAD')),
    );

    expect(receipt).toMatchObject({ result: 'invalidated', head_after: receipt.head_before, clean_after: false });
    expect(receipt.head_after).toMatch(/^[a-f0-9]{40}$/);
    expect(await sessionNext(repoDir, sessionId)).toMatchObject({
      candidate: { target_state: 'implementing', executable: true },
      proof: { status: 'failed' },
    });
  });

  it('assigns deterministic distinct receipt sequences to concurrent completions', async () => {
    const { repoDir, sessionId } = await makeVerifyingSession();

    const receipts = (await Promise.all([runGate(repoDir, sessionId), runGate(repoDir, sessionId)])).sort(
      (left, right) => left.sequence - right.sequence,
    );
    expect(receipts.map((receipt) => receipt.sequence)).toEqual([1, 2]);
    expect(new Set(receipts.map((receipt) => receipt.id))).toHaveProperty('size', 2);
    expect(
      withStateDb(repoDir, (db) => db.prepare(`SELECT sequence, id FROM gate_receipts ORDER BY sequence`).all()),
    ).toEqual(receipts.map((receipt) => ({ sequence: receipt.sequence, id: receipt.id })));
  });

  it('rejects update, delete, and replace attempts against plans and receipts', async () => {
    const { repoDir } = await verifyingSessionWithReceipt();
    closeSqliteConnections(repoDir);

    withStateDb(
      repoDir,
      (db) => {
        expect(() => db.prepare(`UPDATE proof_plans SET baseline_branch = 'rewritten'`).run()).toThrow(
          'proof plans are immutable',
        );
        expect(() => db.prepare(`DELETE FROM proof_plans`).run()).toThrow('proof plans are immutable');
        expect(() =>
          db
            .prepare(
              `
                INSERT OR REPLACE INTO proof_plans
                SELECT session_id, plan_json, plan_sha256, baseline_branch, baseline_head_sha, created_at
                FROM proof_plans
              `,
            )
            .run(),
        ).toThrow('proof plans are immutable');
        expect(() => db.prepare(`UPDATE gate_receipts SET result = 'failed'`).run()).toThrow(
          'gate receipts are immutable',
        );
        expect(() => db.prepare(`DELETE FROM gate_receipts`).run()).toThrow('gate receipts are immutable');
        expect(() =>
          db
            .prepare(
              `
                INSERT OR REPLACE INTO gate_receipts (
                  sequence, id, session_id, gate_id, plan_sha256, head_before, head_after, result,
                  artifact_path, artifact_sha256, receipt_json, receipt_sha256, state_version, created_at
                )
                SELECT
                  sequence, id, session_id, gate_id, plan_sha256, head_before, head_after, result,
                  artifact_path, artifact_sha256, receipt_json, receipt_sha256, state_version, created_at
                FROM gate_receipts
              `,
            )
            .run(),
        ).toThrow('gate receipts are immutable');
      },
      { readOnly: false },
    );
  });
});

describe('proof-aware session next', () => {
  it('fails closed instead of throwing when a legacy receipt contains a non-commit head_after', async () => {
    const { repoDir, sessionId } = await verifyingSessionWithReceipt(
      proofPlan({ command: ['node', '-e', 'process.stderr.write("failed\\n"); process.exit(1)'] }),
    );
    closeSqliteConnections(repoDir);
    withStateDb(
      repoDir,
      (db) =>
        withTriggersDisabled(db, 'gate_receipts', () =>
          db.prepare(`UPDATE gate_receipts SET head_after = 'unobserved'`).run(),
        ),
      { readOnly: false },
    );

    expect(await sessionNext(repoDir, sessionId)).toMatchObject({
      candidate: null,
      proof: { status: 'corrupt', gates: [{ status: 'corrupt' }] },
      staleness: { status: 'corrupt' },
    });
  });

  it.each([
    {
      name: 'the worktree becomes dirty',
      mutateCheckout: (repoDir: string) => writeFile(path.join(repoDir, 'post-proof-change.txt'), 'uncommitted\n'),
    },
    {
      name: 'another branch points at the passing HEAD',
      mutateCheckout: (repoDir: string) => git(repoDir, 'switch', '-c', 'alternate-proof-branch'),
    },
  ])('denies review without mutating lifecycle state when $name', async ({ mutateCheckout }) => {
    const { repoDir, sessionId } = await verifyingSessionWithReceipt();
    await mutateCheckout(repoDir);

    expect(await sessionNext(repoDir, sessionId)).toMatchObject({
      candidate: { target_state: 'pre_pr_reviewing', executable: false },
      guard_failures: [{ code: 'PROOF_CHECKOUT_MISMATCH' }],
      required_work: [{ code: 'RESTORE_PROOF_CHECKOUT' }],
      proof: { status: 'passed' },
    });
    expect(await transitionFailure(repoDir, sessionId, 'pre_pr_reviewing', 4, 'review:unsafe-checkout')).toMatchObject({
      error: {
        code: 'TRANSITION_GUARD_FAILED',
        details: { guard_failures: [{ code: 'PROOF_CHECKOUT_MISMATCH' }] },
      },
    });
    expect(readLifecycle(repoDir)).toEqual({ status: 'verifying', state_version: 4 });
  });

  it('authorizes implementation and verification but rejects review without signed CI evidence', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(repoDir, sessionId);

    expect(await sessionNext(repoDir, sessionId)).toMatchObject({
      candidate: { target_state: 'implementing', executable: true },
      guard_failures: [],
    });
    await expect(transition(repoDir, sessionId, 'implementing', 2, 'implement:gate-task')).resolves.toMatchObject({
      data: { lifecycle: { state: 'implementing', state_version: 3 } },
    });
    expect(await sessionNext(repoDir, sessionId)).toMatchObject({
      candidate: { target_state: 'verifying', executable: false },
      guard_failures: [{ code: 'IMPLEMENTATION_BASIS_NOT_ADVANCED' }],
    });
    await commitFiles(repoDir, 'implement feature', { 'feature.txt': 'implemented\n' });
    expect(await sessionNext(repoDir, sessionId)).toMatchObject({
      candidate: { target_state: 'verifying', executable: true },
      guard_failures: [],
    });
    await expect(transition(repoDir, sessionId, 'verifying', 3, 'verify:gate-task')).resolves.toMatchObject({
      data: { lifecycle: { state: 'verifying', state_version: 4 } },
    });
    const receipt = await runGate(repoDir, sessionId);

    expect(await sessionNext(repoDir, sessionId)).toMatchObject({
      contract_version: 4,
      candidate: { from_state: 'verifying', target_state: 'pre_pr_reviewing', executable: false },
      guard_failures: [{ code: 'SIGNED_CI_PROOF_REQUIRED' }],
      proof: { status: 'passed', gates: [{ gate_id: 'check', status: 'passed', receipt_id: receipt.id }] },
      staleness: { status: 'current', is_stale: false, stale_receipt_ids: [] },
      repair_budget: { status: 'available', attempts_used: 0, limit: 3, remaining: 3, exhausted: false },
      ci_proof: { status: 'missing', gates: [{ status: 'missing' }] },
    });
    expect(await transitionFailure(repoDir, sessionId, 'pre_pr_reviewing', 4, 'review:gate-task')).toMatchObject({
      error: {
        code: 'TRANSITION_GUARD_FAILED',
        details: { guard_failures: [{ code: 'SIGNED_CI_PROOF_REQUIRED', owner_issue: 41 }] },
      },
    });
  });

  it('allows more than three pre-PR implementation cycles without consuming repair budget', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(
      repoDir,
      sessionId,
      proofPlan({ command: ['node', '-e', 'process.stderr.write("still failing\\n"); process.exit(1)'] }),
    );
    await transition(repoDir, sessionId, 'implementing', 2, 'iterate:implement');
    await commitFiles(repoDir, 'initial implementation', { 'feature.txt': 'initial implementation\n' });
    await transition(repoDir, sessionId, 'verifying', 3, 'iterate:verify:0');

    let version = 4;
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      const receipt = await runGate(repoDir, sessionId);
      const failedBasis = { head_sha: receipt.head_after, source: 'failed_local_proof' };
      expect(await sessionNext(repoDir, sessionId)).toMatchObject({
        candidate: { target_state: 'implementing', executable: true },
        implementation_basis: failedBasis,
        pre_pr_review: { iteration_count: cycle - 1 },
        repair_budget: { attempts_used: 0, remaining: 3, exhausted: false },
      });
      await transition(repoDir, sessionId, 'implementing', version, `iterate:open:${cycle}`);
      version += 1;
      await commitFiles(repoDir, `pre-pr iteration ${cycle}`, { 'feature.txt': `iteration ${cycle}\n` });
      expect(await sessionNext(repoDir, sessionId)).toMatchObject({
        candidate: { target_state: 'verifying', executable: true },
        implementation_basis: failedBasis,
      });
      await transition(repoDir, sessionId, 'verifying', version, `iterate:verify:${cycle}`);
      version += 1;
    }

    expect(countRows(repoDir, 'session_transitions', `to_state = 'repairing'`)).toBe(0);
    expect(countRows(repoDir, 'session_transitions', `to_state = 'implementing' AND from_state <> 'proof_ready'`)).toBe(
      4,
    );
  });

  it('accepts current pre-PR findings before signed CI and retains their audit summary', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(repoDir, sessionId);
    await transition(repoDir, sessionId, 'implementing', 2, 'pre-pr-review:implement');
    const headSha = await commitFiles(repoDir, 'initial implementation', { 'feature.txt': 'initial implementation\n' });
    await transition(repoDir, sessionId, 'verifying', 3, 'pre-pr-review:verify');
    await runGate(repoDir, sessionId);
    const reviewInput = {
      pre_pr_review: {
        outcome: 'changes_required',
        head_sha: headSha,
        evidence_ref: 'review-ledger:2026-07-30',
        evidence_sha256: 'a'.repeat(64),
        findings: [
          {
            id: 'capture-auth-no-mutation',
            summary: 'Auth rejection coverage does not prove no mutation.',
            path: 'tests/payments.test.ts',
          },
        ],
      },
    };

    await expect(
      transition(repoDir, sessionId, 'implementing', 4, 'pre-pr-review:changes', reviewInput),
    ).resolves.toMatchObject({ data: { lifecycle: { state: 'implementing', state_version: 5 } } });
    const reviewBasis = { head_sha: headSha, source: 'pre_pr_review' };
    expect(await sessionNext(repoDir, sessionId)).toMatchObject({
      pre_pr_review: { status: 'changes_required', iteration_count: 1, findings: [{ id: 'capture-auth-no-mutation' }] },
      implementation_basis: reviewBasis,
      repair_budget: { attempts_used: 0 },
    });
    const applied = withStateDb(
      repoDir,
      (db) =>
        db
          .prepare(`SELECT event_json FROM audit_events WHERE event_type = 'transition_applied' ORDER BY sequence DESC`)
          .get() as { event_json: string },
    );
    expect(JSON.parse(applied.event_json)).toMatchObject({
      payload: {
        pre_pr_review: {
          outcome: 'changes_required',
          head_sha: headSha,
          finding_count: 1,
          finding_ids: ['capture-auth-no-mutation'],
        },
      },
    });

    await transition(repoDir, sessionId, 'blocked', 5, 'pre-pr-review:block', {
      block: {
        stop_code: 'REVIEW_PAUSED',
        recovery: 'Obtain explicit approval to resume the same implementation work.',
        reason: 'Pause the session without changing its review authority.',
        evidence_ref: 'incident:pre-pr-review',
      },
    });
    await transition(repoDir, sessionId, 'implementing', 6, 'pre-pr-review:resume', {
      recovery: {
        approved_by: 'test-controller',
        evidence_ref: 'incident:pre-pr-review:resolved',
        reason: 'Resume the previously authorized implementation work.',
      },
    });
    expect(await sessionNext(repoDir, sessionId)).toMatchObject({
      candidate: { target_state: 'verifying', executable: false },
      guard_failures: [{ code: 'IMPLEMENTATION_BASIS_NOT_ADVANCED' }],
      implementation_basis: reviewBasis,
      pre_pr_review: { iteration_count: 1 },
    });

    await commitFiles(repoDir, 'address pre-pr finding', { 'finding-fix.txt': 'address current finding\n' });
    expect(await sessionNext(repoDir, sessionId)).toMatchObject({
      pre_pr_review: { status: 'stale', head_sha: headSha },
      implementation_basis: reviewBasis,
      proof: { status: 'stale' },
    });
  });

  it('rejects malformed pre-PR review input without lifecycle, evidence, or budget mutation', async () => {
    const { repoDir, sessionId, head } = await verifyingSessionWithReceipt();
    const counts = () => ({
      transitions: countRows(repoDir, 'session_transitions'),
      receipts: countRows(repoDir, 'gate_receipts'),
      repairs: countRows(repoDir, 'session_transitions', `to_state = 'repairing'`),
    });
    const before = counts();

    const failure = await transitionFailure(repoDir, sessionId, 'implementing', 4, 'pre-pr-review:invalid', {
      pre_pr_review: {
        outcome: 'clean',
        head_sha: head,
        evidence_ref: 'review-ledger:invalid',
        evidence_sha256: 'a'.repeat(64),
        findings: [{ id: 'finding-1', summary: 'Cannot accompany clean', path: 'src/index.ts' }],
      },
    });
    expect(failure).toMatchObject({
      error: {
        code: 'TRANSITION_GUARD_FAILED',
        details: {
          actual_state_version: 4,
          lifecycle_phase: 'pre_pr',
          guard_failures: [{ code: 'PRE_PR_REVIEW_FINDINGS_INVALID' }],
          unchanged: ['lifecycle', 'repair_budget', 'proof', 'review_evidence'],
        },
      },
    });
    expect(readLifecycle(repoDir)).toEqual({ status: 'verifying', state_version: 4 });
    expect(counts()).toEqual(before);
  });

  it('rejects an unrelated clean commit that does not descend from the failed implementation basis', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    const plan = await recordProofPlan(
      repoDir,
      sessionId,
      proofPlan({ command: ['node', '-e', 'process.stderr.write("expected failure\\n"); process.exit(1)'] }),
    );
    await transition(repoDir, sessionId, 'implementing', 2, 'basis:implement');
    await commitFiles(repoDir, 'first implementation', { 'feature.txt': 'first implementation\n' });
    await transition(repoDir, sessionId, 'verifying', 3, 'basis:verify');
    const failedReceipt = await runGate(repoDir, sessionId);
    await transition(repoDir, sessionId, 'implementing', 4, 'basis:reenter');

    await git(repoDir, 'reset', '--hard', plan.data.proof_plan.baseline_head_sha);
    await commitFiles(repoDir, 'unrelated sibling commit', { 'unrelated.txt': 'sibling history\n' });

    const rejected = await transitionFailure(repoDir, sessionId, 'verifying', 5, 'basis:unrelated');
    expect(rejected).toMatchObject({
      error: {
        code: 'TRANSITION_GUARD_FAILED',
        details: { guard_failures: [{ code: 'IMPLEMENTATION_BASIS_NOT_ADVANCED' }] },
      },
    });
    expect(rejected.error.details.guard_failures?.[0]?.message).toContain(
      `implementation basis ${failedReceipt.head_after}`,
    );
    expect(readLifecycle(repoDir)).toEqual({ status: 'implementing', state_version: 5 });
  });

  it('marks a passing receipt stale after a commit and accepts a fresh current-HEAD rerun', async () => {
    const { repoDir, sessionId, receipt: first } = await verifyingSessionWithReceipt();
    await commitFiles(repoDir, 'advance head', { 'new-head.txt': 'new head\n' });

    expect(await sessionNext(repoDir, sessionId)).toMatchObject({
      candidate: null,
      proof: { status: 'stale', gates: [{ status: 'stale', receipt_id: first.id }] },
      staleness: { status: 'stale', is_stale: true, stale_receipt_ids: [first.id] },
    });

    expect((await runGate(repoDir, sessionId)).sequence).toBe(2);
    expect(await sessionNext(repoDir, sessionId)).toMatchObject({
      candidate: { target_state: 'pre_pr_reviewing' },
      proof: { status: 'passed' },
    });
  });

  it('treats a missing or altered receipt artifact as corrupt proof', async () => {
    const { repoDir, sessionId, receipt } = await verifyingSessionWithReceipt();
    const execution = await readExecution(repoDir, receipt.artifact.path);
    await writeFile(path.join(repoDir, execution.stdout.path), 'tampered output\n', 'utf8');

    expect(await sessionNext(repoDir, sessionId)).toMatchObject({
      candidate: null,
      proof: { status: 'corrupt', gates: [{ status: 'corrupt' }] },
      staleness: { status: 'corrupt' },
    });
  });

  it('uses the latest receipt per gate so a later current-HEAD failure supersedes a pass', async () => {
    const { repoDir, sessionId } = await makeVerifyingSession({
      plan: proofPlan({ command: ['node', '-e', 'process.exit(Number(process.env.THREADLOOP_GATE_EXIT ?? "0"))'] }),
    });
    await runGate(repoDir, sessionId, { THREADLOOP_GATE_EXIT: '0' });
    const failed = await runGate(repoDir, sessionId, { THREADLOOP_GATE_EXIT: '9' });
    expect(failed).toMatchObject({ sequence: 2, result: 'failed' });

    expect(await sessionNext(repoDir, sessionId)).toMatchObject({
      candidate: { target_state: 'implementing' },
      proof: { status: 'failed', gates: [{ receipt_id: failed.id, result: 'failed', status: 'failed' }] },
    });
  });
});

describe('declared gate setup', () => {
  const step = (id: string, command: string[]): ProofSetupStep => ({
    id,
    command,
    working_directory: '.',
    timeout_ms: 5_000,
  });
  const failingSetup = [step('broken', ['node', '-e', 'process.exit(7)'])];

  it('records every declared setup step that ran on a passing receipt', async () => {
    // Provisioning output must land outside the repository, because a gate still requires a clean tree at
    // both ends and `git status --untracked-files=all` counts a new untracked file as dirty.
    const markerPath = path.join(await makeTempDir(), 'provisioned.txt');
    const setup = [step('provision', writeMarker(markerPath))];

    const { receipt } = await verifyingSessionWithReceipt(proofPlan({ setup }));

    expect(receipt.result).toBe('passed');
    expect(receipt.setup).toHaveLength(1);
    expect(receipt.setup[0]).toMatchObject({ id: 'provision', result: 'passed', exit_status: 0, clean_before: true });
  });

  it('records setup_failed without running the gate command when provisioning fails', async () => {
    const repoDir = await makeCommittedRepo();
    const gateMarker = path.join(repoDir, 'gate-ran.txt');
    const plan = proofPlan({
      command: writeMarker(gateMarker),
      setup: [...failingSetup, step('unreached', ['node', '-e', 'process.exit(0)'])],
    });
    const { sessionId } = await makeVerifyingSession({ repoDir, plan });

    const receipt = await runGate(repoDir, sessionId);
    expect(receipt.result).toBe('setup_failed');
    expect(receipt.setup.map((recorded) => recorded.id)).toEqual(['broken']);
    expect(receipt.setup[0]?.result).toBe('failed');
    expect(receipt.exit_status).toBeNull();
    expect(existsSync(gateMarker)).toBe(false);
  });

  it.each([0, 7])('names a mutating setup step with exit status %i and blocks later execution', async (exitStatus) => {
    const repoDir = await makeCommittedRepo();
    await commitFiles(repoDir, 'add locked dependency fixture', { 'package-lock.json': 'locked\n' });
    const scratchDirectory = await makeTempDir();
    const laterSetupMarker = path.join(scratchDirectory, 'later-setup-ran.txt');
    const gateMarker = path.join(scratchDirectory, 'gate-ran.txt');
    const { sessionId } = await makeVerifyingSession({
      repoDir,
      plan: proofPlan({
        setup: [
          step('sync', [
            'node',
            '-e',
            `require("node:fs").writeFileSync("package-lock.json", "changed\\n"); process.exit(${exitStatus})`,
          ]),
          step('unreached', writeMarker(laterSetupMarker)),
        ],
        command: writeMarker(gateMarker),
      }),
    });

    const gate = parseJson<{
      data: { receipt: { result: string; setup: unknown[]; artifact: { path: string } }; diagnostic: unknown };
    }>((await runCli(repoDir, gateRunArgs(sessionId))).stdout);

    expect(gate.data.receipt).toMatchObject({
      result: 'invalidated',
      setup: [{ id: 'sync', clean_after: false }],
    });
    expect(gate.data.diagnostic).toEqual({
      code: 'SETUP_MUTATED_REPOSITORY',
      message: 'Setup step sync changed the repository before the gate ran: "package-lock.json".',
      step_id: 'sync',
      changed_files: ['package-lock.json'],
      hint: 'Restore or commit the listed paths, change the setup declaration to use a frozen installer and gitignored output, then start a new session.',
    });
    expect(existsSync(laterSetupMarker)).toBe(false);
    expect(existsSync(gateMarker)).toBe(false);
    expect(gate.data.receipt).not.toHaveProperty('diagnostic');
    const artifact: unknown = JSON.parse(await readFile(path.join(repoDir, gate.data.receipt.artifact.path), 'utf8'));
    expect(artifact).not.toHaveProperty('diagnostic');
    expect(readLifecycle(repoDir)).toEqual({ status: 'verifying', state_version: 4 });
  });

  it('allows gitignored setup output without a mutation diagnostic', async () => {
    const repoDir = await makeCommittedRepo();
    await commitFiles(repoDir, 'ignore provisioning output', { '.gitignore': 'provisioned.txt\n' });
    const { sessionId } = await makeVerifyingSession({
      repoDir,
      plan: proofPlan({ setup: [step('provision', writeMarker(path.join(repoDir, 'provisioned.txt')))] }),
    });

    const gate = parseJson<{ data: { receipt: { result: string }; diagnostic: unknown } }>(
      (await runCli(repoDir, gateRunArgs(sessionId))).stdout,
    );

    expect(gate.data.receipt.result).toBe('passed');
    expect(gate.data.diagnostic).toBeNull();
    expect(await readFile(path.join(repoDir, 'provisioned.txt'), 'utf8')).toBe('started');
  });

  it('distinguishes a gate mutation from setup mutation and names the recovery path', async () => {
    const { repoDir, sessionId } = await makeVerifyingSession({
      plan: proofPlan({
        command: ['node', '-e', 'require("node:fs").writeFileSync("generated-report.json", "{}\\n")'],
      }),
    });

    const gate = parseJson<{
      data: { receipt: { result: string; setup: unknown[] }; diagnostic: unknown };
    }>((await runCli(repoDir, gateRunArgs(sessionId))).stdout);

    expect(gate.data.receipt).toMatchObject({ result: 'invalidated', setup: [] });
    expect(gate.data.diagnostic).toEqual({
      code: 'GATE_MUTATED_REPOSITORY',
      message: 'Gate command changed the repository while it ran: "generated-report.json".',
      step_id: null,
      changed_files: ['generated-report.json'],
      hint: 'Restore or commit the listed paths, change the gate to write generated output outside the repository or to gitignored paths, then start a new session.',
    });
  });

  it('prints the mutation cause and recovery action in text mode', async () => {
    const { repoDir, sessionId } = await makeVerifyingSession({
      plan: proofPlan({
        setup: [step('sync', ['node', '-e', 'require("node:fs").writeFileSync("package-lock.json", "changed\\n")'])],
      }),
    });

    const result = await runCli(repoDir, ['session', 'gate', 'run', 'check', '--session', sessionId]);

    expect(result.stdout).toContain(
      'Setup step sync changed the repository before the gate ran: "package-lock.json".\n' +
        'Recovery: Restore or commit the listed paths, change the setup declaration to use a frozen installer and gitignored output, then start a new session.\n',
    );
  });

  it.each([
    { actor: 'setup', json: true },
    { actor: 'gate', json: false },
  ] as const)('bounds large-install diagnostics for local $actor, JSON $json', async ({ actor, json }) => {
    const { files, command } = unignoredInstall();
    const { repoDir, sessionId } = await makeVerifyingSession({
      plan: proofPlan(actor === 'setup' ? { setup: [step('install', command)] } : { command }),
    });
    const configPath = await makeGlobalIgnoreConfig(repoDir);
    const result = await runCli(
      repoDir,
      ['session', 'gate', 'run', 'check', '--session', sessionId, ...(json ? ['--json'] : [])],
      { GIT_CONFIG_GLOBAL: configPath },
    );

    if (json) {
      const output = parseJson<{
        data: { receipt: { result: string }; diagnostic: { message: string; changed_files: string[]; hint: string } };
      }>(result.stdout);
      expect(output.data.receipt.result).toBe('invalidated');
      expect(output.data.diagnostic.changed_files).toEqual(files);
      expect(output.data.diagnostic.message.length).toBeLessThan(4_096);
      expect(output.data.diagnostic.message).toContain('5 of 300 paths shown');
      expect(output.data.diagnostic.message).toContain('long paths shortened');
      expect(output.data.diagnostic.hint).toContain('git status --short --untracked-files=all');
    } else {
      expect(result.stdout.length).toBeLessThan(4_096);
      expect(result.stdout).toContain('5 of 300 paths shown');
      expect(result.stdout).toContain('long paths shortened');
      expect(result.stdout).toContain('Recovery:');
      expect(result.stdout).toContain('git status --short --untracked-files=all');
    }
  });

  it.each(['setup', 'gate'] as const)(
    'names the original HEAD when %s changes it without dirty paths',
    async (actor) => {
      const changeHead = ['git', 'commit', '--allow-empty', '-m', 'change fixture HEAD'];
      const { repoDir, sessionId, head } = await makeVerifyingSession({
        plan: proofPlan(actor === 'setup' ? { setup: [step('commit', changeHead)] } : { command: changeHead }),
      });
      const result = parseJson<{
        data: { receipt: { result: string }; diagnostic: { changed_files: string[]; hint: string } };
      }>((await runCli(repoDir, gateRunArgs(sessionId))).stdout);

      expect(result.data.receipt.result).toBe('invalidated');
      expect(result.data.diagnostic.changed_files).toEqual([]);
      expect(result.data.diagnostic.hint).toContain(head);
      expect(result.data.diagnostic.hint).not.toContain('listed paths');
    },
  );

  it.each([
    { actor: 'setup', detached: false },
    { actor: 'gate', detached: false },
    { actor: 'setup', detached: true },
    { actor: 'gate', detached: true },
  ] as const)(
    'names the bound branch when $actor switches branches at the same HEAD, detached $detached',
    async ({ actor, detached }) => {
      const scratch = await makeTempDir();
      const laterMarker = path.join(scratch, 'later-setup.txt');
      const gateMarker = path.join(scratch, 'gate.txt');
      const switchBranch = detached
        ? ['git', 'checkout', '--detach', 'HEAD']
        : ['git', 'checkout', '-b', 'other-verification-\u202e-branch'];
      const { repoDir, sessionId, head } = await makeVerifyingSession({
        plan: proofPlan(
          actor === 'setup'
            ? {
                setup: [step('switch', switchBranch), step('later', writeMarker(laterMarker))],
                command: writeMarker(gateMarker),
              }
            : { command: switchBranch },
        ),
      });
      const result = parseJson<{
        data: {
          receipt: { result: string; head_after: string };
          diagnostic: { code: string; message: string; step_id: string | null; changed_files: string[]; hint: string };
        };
      }>((await runCli(repoDir, gateRunArgs(sessionId))).stdout);

      expect(result.data.receipt).toMatchObject({ result: 'invalidated', head_after: head });
      expect(result.data.diagnostic).toMatchObject({
        code: actor === 'setup' ? 'SETUP_MUTATED_REPOSITORY' : 'GATE_MUTATED_REPOSITORY',
        step_id: actor === 'setup' ? 'switch' : null,
        changed_files: [],
      });
      expect(result.data.diagnostic.hint).toContain(fixtureBranch);
      expect(result.data.diagnostic.message).not.toMatch(/\p{Cf}/u);
      if (!detached) {
        expect(result.data.diagnostic.message).toContain('other-verification-\\u202e-branch');
      }
      if (actor === 'setup') {
        expect(existsSync(laterMarker)).toBe(false);
        expect(existsSync(gateMarker)).toBe(false);
      }
      expect(readLifecycle(repoDir)).toEqual({ status: 'verifying', state_version: 4 });
    },
  );

  it.each([true, false])('escapes control characters in human diagnostics with JSON mode %s', async (json) => {
    const fileName =
      'report\n::add-mask::forged\u001b[31m\u0085\u2028\u202e\u202c\u2066\u2069\u200e\u200f\u061c\u{e0061}.txt';
    const { repoDir, sessionId } = await makeVerifyingSession({
      plan: proofPlan({ command: writeMarker(fileName) }),
    });
    const result = await runCli(repoDir, [
      'session',
      'gate',
      'run',
      'check',
      '--session',
      sessionId,
      ...(json ? ['--json'] : []),
    ]);

    if (json) {
      const output = parseJson<{ data: { diagnostic: { message: string; changed_files: string[] } } }>(result.stdout);
      expect(output.data.diagnostic.changed_files).toEqual([fileName]);
      expect(output.data.diagnostic.message).not.toMatch(/\p{Cc}|\p{Cf}|[\u2028\u2029]/u);
      expect(output.data.diagnostic.message).toContain('\\udb40\\udc61');
    } else {
      expect(result.stdout.trimEnd().split('\n')).toHaveLength(4);
      expect(result.stdout).not.toContain('\n::add-mask::');
      expect(result.stdout).not.toContain('\u001b');
      expect(result.stdout).not.toContain('\u0085');
      expect(result.stdout).not.toContain('\u2028');
      expect(result.stdout).not.toMatch(/\p{Cf}/u);
    }
  });

  it('projects setup failure as an operator handoff that consumes no repair budget', async () => {
    const { repoDir, sessionId } = await verifyingSessionWithReceipt(proofPlan({ setup: failingSetup }));

    const next = await sessionNext<{ repair_budget: unknown }>(repoDir, sessionId);
    expect(next).toMatchObject({
      candidate: null,
      proof: { status: 'setup_failed', gates: [{ status: 'setup_failed', result: 'setup_failed' }] },
      guard_failures: [{ code: 'PROOF_GATE_SETUP_FAILED' }],
      required_work: [{ code: 'CORRECT_GATE_SETUP' }],
    });
    // A broken toolchain is a configuration problem, so it must not spend the post-PR repair allowance.
    expect(next.repair_budget).toMatchObject({ attempts_used: 0, exhausted: false });
  });

  it('treats a receipt whose recorded setup does not match the declared plan as corrupt', async () => {
    const { repoDir, sessionId } = await verifyingSessionWithReceipt(
      proofPlan({ setup: [step('provision', ['node', '-e', 'process.exit(0)'])] }),
    );
    closeSqliteConnections(repoDir);
    withStateDb(
      repoDir,
      (db) => {
        const stored = db.prepare(`SELECT receipt_json FROM gate_receipts`).get() as { receipt_json: string };
        const payload = JSON.parse(stored.receipt_json) as { setup: Array<{ command: string[] }> };
        payload.setup[0]!.command = ['node', '-e', 'process.exit(1)'];
        withTriggersDisabled(db, 'gate_receipts', () =>
          db.prepare(`UPDATE gate_receipts SET receipt_json = ?`).run(canonicalJson(payload)),
        );
      },
      { readOnly: false },
    );

    expect(await sessionNext(repoDir, sessionId)).toMatchObject({ proof: { status: 'corrupt' } });
  });
});

describe('gate receipt result domain migration', () => {
  it('widens a pre-v8 gate_receipts result domain while preserving every stored receipt', async () => {
    const { repoDir, sessionId, receipt: first } = await verifyingSessionWithReceipt();

    // Rebuild the table with the pre-v8 result domain, which is the current one without `setup_failed`, and roll
    // the recorded version back, so the next CLI invocation exercises the real migration against stored evidence.
    closeSqliteConnections(repoDir);
    withStateDb(
      repoDir,
      (db) => {
        const definition = (key: string) =>
          (db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(key) as { sql: string }).sql;
        const table = definition('gate_receipts');
        const index = definition('gate_receipts_session_gate_sequence_idx');
        const narrowTable = table.replace(`, 'setup_failed'`, '');
        expect(narrowTable).not.toContain('setup_failed');
        withTriggersDisabled(db, 'gate_receipts', () => {
          db.exec(`
            DROP INDEX gate_receipts_session_gate_sequence_idx;
            ALTER TABLE gate_receipts RENAME TO gate_receipts_downgraded;
            ${narrowTable};
            INSERT INTO gate_receipts SELECT * FROM gate_receipts_downgraded;
            DROP TABLE gate_receipts_downgraded;
            ${index};
          `);
        });
        db.prepare(`UPDATE metadata SET value = '7' WHERE key = 'schema_version'`).run();
      },
      { readOnly: false },
    );
    closeSqliteConnections(repoDir);

    // A schema at or above v6 but below current requires an explicit operator migration, so reads report
    // migration_required rather than silently rewriting stored evidence.
    expect(await sessionNext(repoDir, sessionId)).toMatchObject({
      lifecycle: { contract_status: 'migration_required' },
    });

    await runCli(repoDir, ['init']);

    closeSqliteConnections(repoDir);
    withStateDb(repoDir, (db) => {
      expect(db.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get()).toEqual({ value: '8' });
      const definition = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'gate_receipts'`)
        .get() as { sql: string };
      expect(definition.sql).toContain('setup_failed');
      expect(
        db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'gate_receipts_%'`).all(),
      ).toEqual([]);
      expect(db.prepare(`SELECT sequence, id, result FROM gate_receipts ORDER BY sequence`).all()).toEqual([
        { sequence: first.sequence, id: first.id, result: 'passed' },
      ]);
      for (const trigger of ['gate_receipts_no_update', 'gate_receipts_no_delete', 'gate_receipts_no_replace']) {
        expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(trigger)).toEqual({
          name: trigger,
        });
      }
    });

    // The widened domain must actually be usable after the migration, not merely present in the DDL.
    const secondSession = await startFramedSession(repoDir, {
      commitConfig: false,
      idempotencyKey: 'frame:migrated-setup',
    });
    await recordProofPlan(
      repoDir,
      secondSession,
      proofPlan({
        setup: [
          { id: 'broken', command: ['node', '-e', 'process.exit(9)'], working_directory: '.', timeout_ms: 5_000 },
        ],
      }),
      'proof-plan:migrated-setup',
    );
    await forceStates(repoDir, secondSession, 2, ['implementing', 'verifying']);
    expect((await runGate(repoDir, secondSession)).result).toBe('setup_failed');
  });
});

describe('local and CI receipts describe setup identically', { timeout: 60_000 }, () => {
  it.each(['setup', 'gate'] as const)('bounds large-install diagnostics for CI %s', async (actor) => {
    const { command } = unignoredInstall();
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    const plan = proofPlan(
      actor === 'setup'
        ? { setup: [{ id: 'install', command, working_directory: '.', timeout_ms: 5_000 }] }
        : { command },
    );
    const recorded = await recordProofPlan(repoDir, sessionId, plan);
    const reportPath = path.join(await makeTempDir(), 'gate-report.json');
    const configPath = await makeGlobalIgnoreConfig(repoDir);
    const failure = await execFileAsync('npm', ['run', '--silent', 'sensor:ci-gate:run'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: configPath,
        THREADLOOP_SESSION_ID: sessionId,
        THREADLOOP_PLAN_SHA256: recorded.data.proof_plan.sha256,
        THREADLOOP_GATE_ID: 'check',
        THREADLOOP_GATE_JSON: canonicalJson(plan.gates[0]),
        THREADLOOP_SOURCE_ROOT: repoDir,
        THREADLOOP_REPORT_PATH: reportPath,
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'example/threadloop-fixture',
        GITHUB_REF: `refs/heads/${fixtureBranch}`,
        GITHUB_SHA: await git(repoDir, 'rev-parse', 'HEAD'),
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '1',
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
      },
    }).then(
      () => null,
      (error: Error & { stderr?: string }) => error,
    );

    expect(failure).not.toBeNull();
    expect(failure?.stderr?.length).toBeLessThan(4_096);
    expect(failure?.stderr).toContain('5 of 300 paths shown');
    expect(failure?.stderr).toContain('long paths shortened');
    expect(failure?.stderr).toContain('Recovery:');
    expect(failure?.stderr).toContain('git status --short --untracked-files=all');
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as { result: string };
    expect(report.result).toBe('invalidated');
    expect(report).not.toHaveProperty('diagnostic');
  });

  it('records the same setup for the same HEAD through both execution paths', async () => {
    const plan = proofPlan({
      setup: [
        {
          id: 'provision',
          command: ['node', '-e', 'process.stdout.write("provisioned\\n")'],
          working_directory: '.',
          timeout_ms: 5_000,
        },
      ],
    });
    const { repoDir, sessionId, planSha256, head, receipt: local } = await verifyingSessionWithReceipt(plan);

    // Drive the real CI sensor against the same HEAD and the same declared gate.
    const reportPath = path.join(await makeTempDir(), 'gate-report.json');
    await execFileAsync('npm', ['run', '--silent', 'sensor:ci-gate:run'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        THREADLOOP_SESSION_ID: sessionId,
        THREADLOOP_PLAN_SHA256: planSha256,
        THREADLOOP_GATE_ID: 'check',
        THREADLOOP_GATE_JSON: canonicalJson(plan.gates[0]),
        THREADLOOP_SOURCE_ROOT: repoDir,
        THREADLOOP_REPORT_PATH: reportPath,
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'example/project',
        GITHUB_REF: `refs/heads/${fixtureBranch}`,
        GITHUB_SHA: head,
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '1',
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
      },
    });
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      schema_version: number;
      result: string;
      setup: Record<string, unknown>[];
    };

    // Timestamps and durations legitimately differ between two runs; everything describing *what ran* and how
    // it turned out must not.
    const describable = (step: Record<string, unknown>) => ({
      id: step.id,
      command: step.command,
      working_directory: step.working_directory,
      timeout_ms: step.timeout_ms,
      result: step.result,
      exit_status: step.exit_status,
      signal: step.signal,
      clean_before: step.clean_before,
      clean_after: step.clean_after,
      head_unchanged: step.head_before === step.head_after,
    });

    expect(report.schema_version).toBe(2);
    expect(report.setup.map(describable)).toEqual(local.setup.map(describable));
    expect(report.result).toBe(local.result);
    expect(report.result).toBe('passed');
    // The digests are of the same command's output, so they must agree byte for byte.
    expect(report.setup[0]?.output).toEqual(local.setup[0]?.output);
  });

  it.each([
    { actor: 'setup', dirty: false, malicious: false, mutates: true },
    { actor: 'gate', dirty: false, malicious: false, mutates: true },
    { actor: 'gate', dirty: true, malicious: false, mutates: true },
    { actor: 'gate', dirty: true, malicious: false, mutates: false },
    { actor: 'setup', dirty: true, malicious: false, mutates: false },
    { actor: 'setup', dirty: true, malicious: false, mutates: false, cleansBaseline: true },
    { actor: 'gate', dirty: true, malicious: false, mutates: false, cleansBaseline: true },
    { actor: 'setup', dirty: true, malicious: false, mutates: true },
    { actor: 'setup', dirty: true, malicious: false, mutates: true, mutatesExisting: true },
    { actor: 'setup', dirty: true, malicious: true, mutates: true, mutatesExisting: true },
    { actor: 'gate', dirty: false, malicious: true, mutates: true },
  ] as const)(
    'keeps CI diagnostics accurate for $actor, dirty $dirty, malicious $malicious, mutates $mutates',
    async (scenario) => {
      const { actor, dirty, malicious, mutates } = scenario;
      const mutatesExisting = 'mutatesExisting' in scenario && scenario.mutatesExisting;
      const cleansBaseline = 'cleansBaseline' in scenario && scenario.cleansBaseline;
      const repoDir = await makeCommittedRepo();
      const sessionId = await startFramedSession(repoDir);
      const fileName = malicious
        ? 'report\n::add-mask::forged\u001b[31m\u0085\u2028\u202e\u202c\u2066\u2069\u200e\u200f\u061c\u{e0061}.txt'
        : 'package-lock.json';
      const setupStep = {
        id: 'sync',
        command: cleansBaseline
          ? ['node', '-e', 'require("node:fs").rmSync("pre-existing.txt")']
          : mutates
            ? writeMarker(fileName)
            : ['node', '-e', 'process.exit(0)'],
        working_directory: '.',
        timeout_ms: 5_000,
      };
      const laterStep = { ...setupStep, id: 'later', command: ['node', '-e', 'process.exit(0)'] };
      const plan = proofPlan(
        actor === 'setup'
          ? { setup: cleansBaseline ? [setupStep, laterStep] : [setupStep] }
          : { command: setupStep.command },
      );
      const recorded = await recordProofPlan(repoDir, sessionId, plan);
      const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();
      const reportPath = path.join(await makeTempDir(), 'gate-report.json');
      if (dirty) {
        await writeFile(path.join(repoDir, 'pre-existing.txt'), 'dirty before the gate\n');
        if (mutatesExisting) {
          await writeFile(path.join(repoDir, fileName), 'dirty before setup\n');
        }
      }

      const failure = await execFileAsync('npm', ['run', '--silent', 'sensor:ci-gate:run'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          THREADLOOP_SESSION_ID: sessionId,
          THREADLOOP_PLAN_SHA256: recorded.data.proof_plan.sha256,
          THREADLOOP_GATE_ID: 'check',
          THREADLOOP_GATE_JSON: canonicalJson(plan.gates[0]),
          THREADLOOP_SOURCE_ROOT: repoDir,
          THREADLOOP_REPORT_PATH: reportPath,
          GITHUB_SERVER_URL: 'https://github.com',
          GITHUB_REPOSITORY: 'example/threadloop-fixture',
          GITHUB_REF: `refs/heads/${fixtureBranch}`,
          GITHUB_SHA: head,
          GITHUB_RUN_ID: '123',
          GITHUB_RUN_ATTEMPT: '1',
          RUNNER_OS: 'Linux',
          RUNNER_ARCH: 'X64',
        },
      }).then(
        () => null,
        (error: Error & { stderr?: string }) => error,
      );

      expect(failure).not.toBeNull();
      const message =
        actor === 'setup'
          ? 'Setup step sync changed the repository before the gate ran: "package-lock.json".'
          : 'Gate command changed the repository while it ran: "package-lock.json".';
      const recoveryPaths = dirty
        ? 'all dirty paths (use git status --short --untracked-files=all for the full list)'
        : 'the listed paths';
      const hint =
        actor === 'setup'
          ? `Restore or commit ${recoveryPaths}, change the setup declaration to use a frozen installer and gitignored output, then start a new session.`
          : `Restore or commit ${recoveryPaths}, change the gate to write generated output outside the repository or to gitignored paths, then start a new session.`;
      if (dirty && (!mutates || mutatesExisting)) {
        const subject = actor === 'setup' ? 'Setup step sync' : 'Gate command';
        expect(failure?.stderr).toContain(`${subject} ran with an already-dirty repository:`);
        expect(failure?.stderr).toContain('pre-existing.txt');
        if (cleansBaseline) {
          expect(failure?.stderr).toContain(
            'The repository was clean after this command, but the run started from a dirty baseline.',
          );
          expect(failure?.stderr).toContain(
            'Inspect the run output, then start a new session from a clean repository.',
          );
        } else {
          expect(failure?.stderr).toContain("Git status can't attribute edits to those existing dirty paths.");
          expect(failure?.stderr).toContain('Restore or commit the pre-existing dirty paths');
        }
        expect(failure?.stderr).not.toContain('changed the repository');
        expect(failure?.stderr?.trimEnd().split('\n')).toHaveLength(2);
        expect(failure?.stderr?.replaceAll('\n', '')).not.toMatch(/\p{Cc}|\p{Cf}|[\u2028\u2029]/u);
      } else if (malicious) {
        expect(failure?.stderr?.trimEnd().split('\n')).toHaveLength(2);
        expect(failure?.stderr?.replaceAll('\n', '')).not.toMatch(/\p{Cc}|\p{Cf}|[\u2028\u2029]/u);
        expect(failure?.stderr).toContain(
          'report\\n::add-mask::forged\\u001b[31m\\u0085\\u2028\\u202e\\u202c\\u2066\\u2069\\u200e\\u200f\\u061c\\udb40\\udc61.txt',
        );
      } else {
        expect(failure?.stderr).toContain(`${message}\nRecovery: ${hint}\n`);
      }
      const report = JSON.parse(await readFile(reportPath, 'utf8')) as { result: string };
      expect(report.result).toBe('invalidated');
      expect(report).not.toHaveProperty('diagnostic');
    },
  );
  it.each(['setup', 'gate'] as const)('preserves SHA-only CI binding when %s switches branches', async (actor) => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    const switchBranch = ['git', 'checkout', '-b', 'other-ci-branch'];
    const marker = path.join(await makeTempDir(), 'ci-gate.txt');
    const plan = proofPlan(
      actor === 'setup'
        ? {
            setup: [{ id: 'switch', command: switchBranch, working_directory: '.', timeout_ms: 5_000 }],
            command: writeMarker(marker),
          }
        : { command: switchBranch },
    );
    const recorded = await recordProofPlan(repoDir, sessionId, plan);
    const head = await git(repoDir, 'rev-parse', 'HEAD');
    const reportPath = path.join(await makeTempDir(), 'gate-report.json');

    const output = await execFileAsync('npm', ['run', '--silent', 'sensor:ci-gate:run'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        THREADLOOP_SESSION_ID: sessionId,
        THREADLOOP_PLAN_SHA256: recorded.data.proof_plan.sha256,
        THREADLOOP_GATE_ID: 'check',
        THREADLOOP_GATE_JSON: canonicalJson(plan.gates[0]),
        THREADLOOP_SOURCE_ROOT: repoDir,
        THREADLOOP_REPORT_PATH: reportPath,
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'example/project',
        GITHUB_REF: `refs/heads/${fixtureBranch}`,
        GITHUB_SHA: head,
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '1',
        RUNNER_OS: 'Linux',
        RUNNER_ARCH: 'X64',
      },
    });
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as { result: string; head_after: string };
    expect(report).toMatchObject({ result: 'passed', head_after: head });
    expect(output.stderr).toBe('');
    expect(await git(repoDir, 'branch', '--show-current')).toBe('other-ci-branch');
    if (actor === 'setup') expect(existsSync(marker)).toBe(true);
  });
});
