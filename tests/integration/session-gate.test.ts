import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parseJson, runCli, runCliFailure } from '../helpers/cli.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { DatabaseSync } from '../../src/adapters/fs/sqlite-driver.js';
import { applySessionTransition, resetSqliteConnections } from '../../src/adapters/fs/sqlite-store.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { canonicalizeTransitionRequest, type TransitionRequest } from '../../src/domain/session-transition.js';

const execFileAsync = promisify(execFile);
const temporaryRepos: string[] = [];
const fixtureRepository = 'https://github.com/example/threadloop-fixture';
const fixtureBranch = 'issue-41/signed-receipts';
const sensorSha = 'a'.repeat(40);

async function makeScratchDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'threadloop-gate-scratch-'));
  temporaryRepos.push(directory);
  return directory;
}

async function makeCommittedRepo() {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), 'threadloop-gate-'));
  temporaryRepos.push(repoDir);
  await execFileAsync('git', ['init'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  await execFileAsync('git', ['remote', 'add', 'origin', `${fixtureRepository}.git`], { cwd: repoDir });
  await writeFile(path.join(repoDir, 'README.md'), '# gate fixture\n', 'utf8');
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repoDir });
  await execFileAsync('git', ['branch', '-M', fixtureBranch], { cwd: repoDir });
  return repoDir;
}

async function startFramedSession(
  repoDir: string,
  // A second session in the same repository has nothing new to commit, and needs its own idempotency key.
  options: { commitConfig?: boolean; idempotencyKey?: string } = {},
) {
  const started = parseJson<{ data: { session_id: string } }>(
    (
      await runCli(repoDir, [
        'session',
        'start',
        'Gate task',
        '--goal',
        'Prove repository checks',
        '--issue',
        '#40',
        '--json',
      ])
    ).stdout,
  );
  if (options.commitConfig !== false) {
    await execFileAsync('git', ['add', '.threadloop/config.json'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'initialize ThreadLoop'], { cwd: repoDir });
  }
  await runCli(repoDir, [
    'session',
    'transition',
    'framed',
    '--session',
    started.data.session_id,
    '--expected-state-version',
    '0',
    '--idempotency-key',
    options.idempotencyKey ?? 'frame:gate-task',
    '--actor',
    'agent',
    '--input',
    '{}',
    '--json',
  ]);
  return started.data.session_id;
}

function proofPlan(
  command = ['node', '-e', 'process.stdout.write("ok\\n")'],
  timeoutMs = 5_000,
  workingDirectory = '.',
) {
  return {
    contract_version: 4,
    acceptance_criteria: ['All repository checks pass'],
    ci: {
      provider: 'github-actions',
      issuer: 'https://token.actions.githubusercontent.com',
      certificate_identity: `${fixtureRepository}/.github/workflows/threadloop.yml@refs/heads/${fixtureBranch}`,
      source_repository: fixtureRepository,
      build_signer_uri: `https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-gate-sensor.yml@${sensorSha}`,
      build_signer_sha: sensorSha,
    },
    review: {
      provider: 'github-actions',
      issuer: 'https://token.actions.githubusercontent.com',
      certificate_identity: `${fixtureRepository}/.github/workflows/threadloop.yml@refs/heads/${fixtureBranch}`,
      source_repository: fixtureRepository,
      build_signer_uri: `https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-review-sensor.yml@${sensorSha}`,
      build_signer_sha: sensorSha,
    },
    gates: [
      {
        id: 'repository-check',
        command,
        working_directory: workingDirectory,
        timeout_ms: timeoutMs,
      },
    ],
  };
}

async function recordProofPlan(
  repoDir: string,
  sessionId: string,
  plan = proofPlan(),
  idempotencyKey = 'proof-plan:gate-task',
) {
  return parseJson<{
    data: {
      lifecycle: { state: string; state_version: number };
      proof_plan: { sha256: string; baseline_branch: string; baseline_head_sha: string };
    };
  }>(
    (
      await runCli(repoDir, [
        'session',
        'transition',
        'proof_ready',
        '--session',
        sessionId,
        '--expected-state-version',
        '1',
        '--idempotency-key',
        idempotencyKey,
        '--actor',
        'agent',
        '--input',
        JSON.stringify({ proof_plan: plan }),
        '--json',
      ])
    ).stdout,
  );
}

async function forceVerifying(repoDir: string, sessionId: string) {
  for (const [targetState, expectedStateVersion] of [
    ['implementing', 2],
    ['verifying', 3],
  ] as const) {
    const request: TransitionRequest = {
      sessionId,
      targetState,
      expectedStateVersion,
      actor: 'agent',
      input: {},
    };
    const result = await applySessionTransition(
      repoDir,
      {
        ...request,
        idempotencyKey: `fixture:${targetState}`,
        ...canonicalizeTransitionRequest(request, sha256),
      },
      () => ({ allowed: true, guardFailures: [], requiredWork: [] }),
    );
    if (!result.ok) {
      throw new Error(`Could not prepare verifying fixture: ${result.error.code}`);
    }
  }
}

async function transition(
  repoDir: string,
  sessionId: string,
  targetState: string,
  expectedVersion: number,
  idempotencyKey: string,
  input: Record<string, unknown> = {},
) {
  return parseJson<{
    data: { lifecycle: { state: string; state_version: number }; transition: { from_state: string; to_state: string } };
  }>(
    (
      await runCli(repoDir, [
        'session',
        'transition',
        targetState,
        '--session',
        sessionId,
        '--expected-state-version',
        String(expectedVersion),
        '--idempotency-key',
        idempotencyKey,
        '--actor',
        'agent',
        '--input',
        JSON.stringify(input),
        '--json',
      ])
    ).stdout,
  );
}

afterEach(async () => {
  await resetSqliteConnections();
  await Promise.all(temporaryRepos.splice(0).map((repoDir) => rm(repoDir, { recursive: true, force: true })));
  temporaryRepos.length = 0;
});

describe('proof plan persistence', { timeout: 20_000 }, () => {
  it('atomically stores one canonical plan bound to a clean baseline', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();
    const branch = (await execFileAsync('git', ['branch', '--show-current'], { cwd: repoDir })).stdout.trim();
    const result = await recordProofPlan(repoDir, sessionId);

    expect(result.data).toMatchObject({
      lifecycle: { state: 'proof_ready', state_version: 2 },
      proof_plan: {
        baseline_branch: branch,
        baseline_head_sha: head,
      },
    });
    expect(result.data.proof_plan.sha256).toMatch(/^[a-f0-9]{64}$/);

    await resetSqliteConnections(repoDir);
    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get()).toEqual({ value: '8' });
      expect(
        db
          .prepare(
            `
              SELECT session_id, plan_json, plan_sha256, baseline_branch, baseline_head_sha
              FROM proof_plans
            `,
          )
          .get(),
      ).toMatchObject({
        session_id: sessionId,
        plan_json: `{"acceptance_criteria":["All repository checks pass"],"ci":{"build_signer_sha":"${sensorSha}","build_signer_uri":"https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-gate-sensor.yml@${sensorSha}","certificate_identity":"${fixtureRepository}/.github/workflows/threadloop.yml@refs/heads/${fixtureBranch}","issuer":"https://token.actions.githubusercontent.com","provider":"github-actions","source_repository":"${fixtureRepository}"},"contract_version":4,"gates":[{"command":["node","-e","process.stdout.write(\\"ok\\\\n\\")"],"id":"repository-check","timeout_ms":5000,"working_directory":"."}],"review":{"build_signer_sha":"${sensorSha}","build_signer_uri":"https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-review-sensor.yml@${sensorSha}","certificate_identity":"${fixtureRepository}/.github/workflows/threadloop.yml@refs/heads/${fixtureBranch}","issuer":"https://token.actions.githubusercontent.com","provider":"github-actions","source_repository":"${fixtureRepository}"}}`,
        plan_sha256: result.data.proof_plan.sha256,
        baseline_branch: branch,
        baseline_head_sha: head,
      });
    } finally {
      db.close();
    }
  });

  it('rejects a committed symlink whose working directory resolves outside the repository', async () => {
    const repoDir = await makeCommittedRepo();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'threadloop-gate-outside-'));
    temporaryRepos.push(outside);
    await symlink(outside, path.join(repoDir, 'escape'));
    await execFileAsync('git', ['add', 'escape'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'add escape symlink fixture'], { cwd: repoDir });
    const sessionId = await startFramedSession(repoDir);

    const failure = await runCliFailure(repoDir, [
      'session',
      'transition',
      'proof_ready',
      '--session',
      sessionId,
      '--expected-state-version',
      '1',
      '--idempotency-key',
      'proof-plan:symlink-escape',
      '--actor',
      'agent',
      '--input',
      JSON.stringify({ proof_plan: proofPlan(['node', '-e', 'process.exit(0)'], 5_000, 'escape') }),
      '--json',
    ]);
    const body = parseJson<{ error: { code: string; message: string } }>(failure.stderr);
    expect(body.error.code).toBe('INVALID_ARGUMENT');
    expect(body.error.message).toContain('resolves outside the repository');

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT status, state_version FROM tasks`).get()).toEqual({
        status: 'framed',
        state_version: 1,
      });
      expect(db.prepare(`SELECT COUNT(*) AS count FROM proof_plans`).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it.each([
    {
      name: 'dirty worktree',
      expectedGuard: 'PROOF_BASELINE_DIRTY',
      prepare: async (repoDir: string) => {
        await writeFile(path.join(repoDir, 'dirty.txt'), 'dirty\n', 'utf8');
      },
      recover: async (repoDir: string) => {
        await rm(path.join(repoDir, 'dirty.txt'));
      },
    },
    {
      name: 'detached HEAD',
      expectedGuard: 'PROOF_BASELINE_BRANCH_REQUIRED',
      prepare: async (repoDir: string) => {
        await execFileAsync('git', ['checkout', '--detach', 'HEAD'], { cwd: repoDir });
      },
      recover: async (repoDir: string) => {
        await execFileAsync('git', ['checkout', fixtureBranch], { cwd: repoDir });
      },
    },
  ])(
    'durably rejects a $name proof baseline so the same request cannot later succeed',
    async ({ expectedGuard, prepare, recover }) => {
      const repoDir = await makeCommittedRepo();
      const sessionId = await startFramedSession(repoDir);
      const idempotencyKey = `proof-plan:rejected:${expectedGuard}`;
      const args = [
        'session',
        'transition',
        'proof_ready',
        '--session',
        sessionId,
        '--expected-state-version',
        '1',
        '--idempotency-key',
        idempotencyKey,
        '--actor',
        'agent',
        '--input',
        JSON.stringify({ proof_plan: proofPlan() }),
        '--json',
      ];

      await prepare(repoDir);
      const first = await runCliFailure(repoDir, args);
      const firstBody = parseJson<{
        error: { code: string; details: { guard_failures: Array<{ code: string }> } };
      }>(first.stderr);
      expect(firstBody.error).toMatchObject({
        code: 'TRANSITION_GUARD_FAILED',
        details: { guard_failures: [{ code: expectedGuard }] },
      });

      await recover(repoDir);
      const replay = await runCliFailure(repoDir, args);
      expect(replay.stderr).toBe(first.stderr);

      const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
      try {
        expect(db.prepare(`SELECT status, state_version FROM tasks`).get()).toEqual({
          status: 'framed',
          state_version: 1,
        });
        expect(
          db
            .prepare(`SELECT outcome, COUNT(*) AS count FROM transition_idempotency WHERE idempotency_key = ?`)
            .get(idempotencyKey),
        ).toEqual({ outcome: 'rejected', count: 1 });
        expect(
          db
            .prepare(
              `
                SELECT COUNT(*) AS count
                FROM audit_events
                WHERE session_id = ? AND event_type = 'guard_decision'
                  AND json_extract(event_json, '$.payload.idempotency_key') = ?
              `,
            )
            .get(sessionId, idempotencyKey),
        ).toEqual({ count: 1 });
        expect(db.prepare(`SELECT COUNT(*) AS count FROM proof_plans`).get()).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    },
  );

  it('does not cache a structurally invalid proof plan as an evaluated guard decision', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    const idempotencyKey = 'proof-plan:structurally-invalid';
    const invalidPlan = { ...proofPlan(), contract_version: 99 };
    const failure = await runCliFailure(repoDir, [
      'session',
      'transition',
      'proof_ready',
      '--session',
      sessionId,
      '--expected-state-version',
      '1',
      '--idempotency-key',
      idempotencyKey,
      '--actor',
      'agent',
      '--input',
      JSON.stringify({ proof_plan: invalidPlan }),
      '--json',
    ]);
    expect(parseJson<{ error: { code: string } }>(failure.stderr).error.code).toBe('INVALID_ARGUMENT');

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(
        db
          .prepare(`SELECT COUNT(*) AS count FROM transition_idempotency WHERE idempotency_key = ?`)
          .get(idempotencyKey),
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare(
            `
              SELECT COUNT(*) AS count
              FROM audit_events
              WHERE session_id = ? AND event_type = 'guard_decision'
                AND json_extract(event_json, '$.payload.idempotency_key') = ?
            `,
          )
          .get(sessionId, idempotencyKey),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});

describe('session gate run', { timeout: 20_000 }, () => {
  it('executes the stored argv and appends a digest-bound passing receipt without advancing state', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(repoDir, sessionId);
    await forceVerifying(repoDir, sessionId);

    const result = parseJson<{
      command: string;
      data: {
        receipt: {
          id: string;
          sequence: number;
          session_id: string;
          gate_id: string;
          result: string;
          command: string[];
          working_directory: string;
          timeout_ms: number;
          exit_status: number | null;
          signal: string | null;
          head_before: string;
          head_after: string;
          clean_before: boolean;
          clean_after: boolean;
          artifact: { path: string; sha256: string };
          sensor: { name: string; contract_version: number };
        };
        lifecycle: { state: string; state_version: number };
      };
    }>(
      (await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json'])).stdout,
    );

    expect(result).toMatchObject({
      command: 'session gate run',
      data: {
        receipt: {
          sequence: 1,
          session_id: sessionId,
          gate_id: 'repository-check',
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
    expect(result.data.receipt.id).toMatch(/^receipt_/);
    expect(result.data.receipt.head_after).toBe(result.data.receipt.head_before);
    expect(result.data.receipt.artifact.path).toMatch(
      new RegExp(`^\\.threadloop/artifacts/receipts/${sessionId}/receipt_.+/execution\\.json$`),
    );
    expect(result.data.receipt.artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    const execution = JSON.parse(await readFile(path.join(repoDir, result.data.receipt.artifact.path), 'utf8')) as {
      stdout: { path: string; sha256: string; bytes: number };
      stderr: { path: string; sha256: string; bytes: number };
    };
    expect(await readFile(path.join(repoDir, execution.stdout.path), 'utf8')).toBe('ok\n');
    expect(execution.stdout).toMatchObject({ bytes: 3 });
    expect(execution.stderr).toMatchObject({ bytes: 0 });

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM gate_receipts`).get()).toEqual({ count: 1 });
      expect(db.prepare(`SELECT status, state_version FROM tasks`).get()).toEqual({
        status: 'verifying',
        state_version: 4,
      });
    } finally {
      db.close();
    }
  });

  it('preserves arguments and a working directory containing spaces without shell parsing', async () => {
    const repoDir = await makeCommittedRepo();
    const workingDirectory = 'directory with spaces';
    await mkdir(path.join(repoDir, workingDirectory));
    await writeFile(path.join(repoDir, workingDirectory, 'fixture.txt'), 'fixture\n', 'utf8');
    await execFileAsync('git', ['add', workingDirectory], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'add spaced directory'], { cwd: repoDir });
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(
      repoDir,
      sessionId,
      proofPlan(
        ['node', '-e', 'process.stdout.write(`${process.cwd()}\\n${process.argv[1]}\\n`)', 'argument with spaces'],
        5_000,
        workingDirectory,
      ),
    );
    await forceVerifying(repoDir, sessionId);

    const result = parseJson<{ data: { receipt: { artifact: { path: string } } } }>(
      (await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json'])).stdout,
    );
    const execution = JSON.parse(await readFile(path.join(repoDir, result.data.receipt.artifact.path), 'utf8')) as {
      stdout: { path: string };
    };
    const canonicalRepo = await realpath(repoDir);
    expect(await readFile(path.join(repoDir, execution.stdout.path), 'utf8')).toBe(
      `${path.join(canonicalRepo, workingDirectory)}\nargument with spaces\n`,
    );
  });

  it('rejects undeclared and dirty-preflight gates before starting a process or writing a receipt', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    const markerPath = path.join(repoDir, 'gate-started.txt');
    await recordProofPlan(
      repoDir,
      sessionId,
      proofPlan(['node', '-e', `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started")`]),
    );
    await forceVerifying(repoDir, sessionId);

    const undeclared = await runCliFailure(repoDir, [
      'session',
      'gate',
      'run',
      'not-declared',
      '--session',
      sessionId,
      '--json',
    ]);
    expect(parseJson<{ error: { code: string } }>(undeclared.stderr).error.code).toBe('GATE_NOT_DECLARED');
    expect(existsSync(markerPath)).toBe(false);

    await writeFile(path.join(repoDir, 'dirty.txt'), 'dirty\n', 'utf8');
    const dirty = await runCliFailure(repoDir, [
      'session',
      'gate',
      'run',
      'repository-check',
      '--session',
      sessionId,
      '--json',
    ]);
    expect(parseJson<{ error: { code: string } }>(dirty.stderr).error.code).toBe('GATE_PREFLIGHT_DIRTY');
    expect(existsSync(markerPath)).toBe(false);

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM gate_receipts`).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('rejects a corrupt audit chain before starting the gate process or creating proof artifacts', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    const markerPath = path.join(repoDir, 'gate-started.txt');
    await recordProofPlan(
      repoDir,
      sessionId,
      proofPlan(['node', '-e', `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started")`]),
    );
    await forceVerifying(repoDir, sessionId);

    await resetSqliteConnections(repoDir);
    const dbPath = path.join(repoDir, '.threadloop/state/state.db');
    const corrupt = new DatabaseSync(dbPath);
    try {
      corrupt.prepare(`DROP TRIGGER audit_events_no_update`).run();
      corrupt.prepare(`UPDATE audit_events SET event_sha256 = ? WHERE sequence = 2`).run('0'.repeat(64));
    } finally {
      corrupt.close();
    }

    const failure = await runCliFailure(repoDir, [
      'session',
      'gate',
      'run',
      'repository-check',
      '--session',
      sessionId,
      '--json',
    ]);
    expect(
      parseJson<{
        error: { code: string; details: { audit_error: { code: string; sequence: number } } };
      }>(failure.stderr),
    ).toMatchObject({
      error: {
        code: 'AUDIT_VERIFICATION_FAILED',
        details: { audit_error: { code: 'AUDIT_HASH_MISMATCH', sequence: 2 } },
      },
    });
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(path.join(repoDir, '.threadloop', 'artifacts', 'receipts', sessionId))).toBe(false);

    const state = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(state.prepare(`SELECT COUNT(*) AS count FROM gate_receipts`).get()).toEqual({ count: 0 });
    } finally {
      state.close();
    }
  });

  it('rejects task-projection drift before recording local gate evidence', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(repoDir, sessionId);
    await resetSqliteConnections(repoDir);
    const dbPath = path.join(repoDir, '.threadloop/state/state.db');
    const corrupt = new DatabaseSync(dbPath);
    corrupt.prepare(`UPDATE tasks SET status = 'verifying', state_version = 4`).run();
    const beforeAuditCount = (
      corrupt.prepare(`SELECT COUNT(*) AS count FROM audit_events WHERE session_id = ?`).get(sessionId) as {
        count: number;
      }
    ).count;
    corrupt.close();

    const failure = parseJson<{ error: { code: string; message: string } }>(
      (await runCliFailure(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json']))
        .stderr,
    );
    expect(failure.error.code).toBe('STATE_CORRUPTED');
    expect(failure.error.message).toContain('current lifecycle projection does not match transition history');

    const unchanged = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(unchanged.prepare(`SELECT COUNT(*) AS count FROM gate_receipts`).get()).toEqual({ count: 0 });
      expect(
        unchanged.prepare(`SELECT COUNT(*) AS count FROM audit_events WHERE session_id = ?`).get(sessionId),
      ).toEqual({ count: beforeAuditCount });
    } finally {
      unchanged.close();
    }
  });

  it('rejects gate execution after leaving the named proof-plan branch', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(repoDir, sessionId);
    await forceVerifying(repoDir, sessionId);
    await execFileAsync('git', ['checkout', '--detach', 'HEAD'], { cwd: repoDir });

    const failure = await runCliFailure(repoDir, [
      'session',
      'gate',
      'run',
      'repository-check',
      '--session',
      sessionId,
      '--json',
    ]);
    expect(parseJson<{ error: { code: string } }>(failure.stderr).error.code).toBe('GATE_NOT_RUNNABLE');

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM gate_receipts`).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
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
      const repoDir = await makeCommittedRepo();
      const sessionId = await startFramedSession(repoDir);
      await recordProofPlan(repoDir, sessionId, proofPlan(command, timeoutMs));
      await forceVerifying(repoDir, sessionId);

      const result = parseJson<{
        data: {
          receipt: {
            result: string;
            exit_status: number | null;
            artifact: { path: string };
          };
        };
      }>(
        (await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json']))
          .stdout,
      );

      expect(result.data.receipt).toMatchObject({
        result: expectedResult,
        exit_status: expectedExit,
      });
      expect(existsSync(path.join(repoDir, result.data.receipt.artifact.path))).toBe(true);
      const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
      try {
        expect(db.prepare(`SELECT result FROM gate_receipts`).get()).toEqual({ result: expectedResult });
      } finally {
        db.close();
      }
    },
  );

  it('binds an invalidated receipt to the pre-run commit when post-run Git observation fails', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(
      repoDir,
      sessionId,
      proofPlan(['node', '-e', 'require("node:fs").renameSync(".git/HEAD", ".git/HEAD.saved")']),
    );
    await forceVerifying(repoDir, sessionId);
    const headPath = path.join(repoDir, '.git', 'HEAD');
    const savedHeadPath = path.join(repoDir, '.git', 'HEAD.saved');

    const gateRun = await (async () => {
      try {
        return await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json']);
      } finally {
        await rename(savedHeadPath, headPath);
      }
    })();
    const result = parseJson<{
      data: {
        receipt: {
          result: string;
          head_before: string;
          head_after: string;
          clean_after: boolean;
        };
      };
    }>(gateRun.stdout);

    expect(result.data.receipt).toMatchObject({
      result: 'invalidated',
      head_after: result.data.receipt.head_before,
      clean_after: false,
    });
    expect(result.data.receipt.head_after).toMatch(/^[a-f0-9]{40}$/);

    const next = parseJson<{
      data: {
        candidate: { target_state: string; executable: boolean };
        proof: { status: string };
      };
    }>((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout);
    expect(next.data).toMatchObject({
      candidate: { target_state: 'implementing', executable: true },
      proof: { status: 'failed' },
    });
  });

  it('assigns deterministic distinct receipt sequences to concurrent completions', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(repoDir, sessionId);
    await forceVerifying(repoDir, sessionId);
    const args = ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json'];

    const results = await Promise.all([runCli(repoDir, args), runCli(repoDir, args)]);
    const receipts = results
      .map((result) => parseJson<{ data: { receipt: { id: string; sequence: number } } }>(result.stdout).data.receipt)
      .sort((left, right) => left.sequence - right.sequence);
    expect(receipts.map((receipt) => receipt.sequence)).toEqual([1, 2]);
    expect(new Set(receipts.map((receipt) => receipt.id))).toHaveProperty('size', 2);

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT sequence, id FROM gate_receipts ORDER BY sequence`).all()).toEqual(
        receipts.map((receipt) => ({ sequence: receipt.sequence, id: receipt.id })),
      );
    } finally {
      db.close();
    }
  });

  it('rejects update, delete, and replace attempts against plans and receipts', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(repoDir, sessionId);
    await forceVerifying(repoDir, sessionId);
    await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json']);
    await resetSqliteConnections(repoDir);

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'));
    try {
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
    } finally {
      db.close();
    }
  });
});

describe('proof-aware session next', { timeout: 20_000 }, () => {
  it('fails closed instead of throwing when a legacy receipt contains a non-commit head_after', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(
      repoDir,
      sessionId,
      proofPlan(['node', '-e', 'process.stderr.write("failed\\n"); process.exit(1)']),
    );
    await forceVerifying(repoDir, sessionId);
    await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json']);

    await resetSqliteConnections(repoDir);
    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'));
    try {
      db.exec(`DROP TRIGGER gate_receipts_no_update`);
      db.prepare(`UPDATE gate_receipts SET head_after = 'unobserved'`).run();
      db.exec(`
        CREATE TRIGGER gate_receipts_no_update
        BEFORE UPDATE ON gate_receipts
        BEGIN
          SELECT RAISE(ABORT, 'gate receipts are immutable');
        END
      `);
    } finally {
      db.close();
    }

    const next = parseJson<{
      data: {
        candidate: null;
        proof: { status: string; gates: Array<{ status: string }> };
        staleness: { status: string };
      };
    }>((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout);
    expect(next.data).toMatchObject({
      candidate: null,
      proof: { status: 'corrupt', gates: [{ status: 'corrupt' }] },
      staleness: { status: 'corrupt' },
    });
  });

  it('keeps review blocked when local proof passes but signed CI proof is missing', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(repoDir, sessionId);
    await forceVerifying(repoDir, sessionId);
    const gate = parseJson<{ data: { receipt: { id: string } } }>(
      (await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json'])).stdout,
    );

    const next = parseJson<{
      data: {
        contract_version: number;
        candidate: { from_state: string; target_state: string; executable: boolean };
        proof: {
          status: string;
          gates: Array<{ gate_id: string; status: string; receipt_id: string }>;
        };
        staleness: { status: string; is_stale: boolean; stale_receipt_ids: string[] };
        repair_budget: { status: string; attempts_used: number; limit: number; remaining: number; exhausted: boolean };
        ci_proof: { status: string; gates: Array<{ status: string }> };
        guard_failures: Array<{ code: string }>;
      };
    }>((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout);

    expect(next.data).toMatchObject({
      contract_version: 4,
      candidate: {
        from_state: 'verifying',
        target_state: 'pre_pr_reviewing',
        executable: false,
      },
      guard_failures: [{ code: 'SIGNED_CI_PROOF_REQUIRED' }],
      proof: {
        status: 'passed',
        gates: [{ gate_id: 'repository-check', status: 'passed', receipt_id: gate.data.receipt.id }],
      },
      staleness: {
        status: 'current',
        is_stale: false,
        stale_receipt_ids: [],
      },
      repair_budget: {
        status: 'available',
        attempts_used: 0,
        limit: 3,
        remaining: 3,
        exhausted: false,
      },
      ci_proof: { status: 'missing', gates: [{ status: 'missing' }] },
    });
  });

  it.each([
    {
      name: 'the worktree becomes dirty',
      mutateCheckout: async (repoDir: string) => {
        await writeFile(path.join(repoDir, 'post-proof-change.txt'), 'uncommitted\n', 'utf8');
      },
    },
    {
      name: 'another branch points at the passing HEAD',
      mutateCheckout: async (repoDir: string) => {
        await execFileAsync('git', ['switch', '-c', 'alternate-proof-branch'], { cwd: repoDir });
      },
    },
  ])('denies review without mutating lifecycle state when $name', async ({ mutateCheckout }) => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(repoDir, sessionId);
    await forceVerifying(repoDir, sessionId);
    await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json']);
    await mutateCheckout(repoDir);

    const next = parseJson<{
      data: {
        candidate: { target_state: string; executable: boolean };
        guard_failures: Array<{ code: string }>;
        required_work: Array<{ code: string }>;
        proof: { status: string };
      };
    }>((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout);
    expect(next.data).toMatchObject({
      candidate: { target_state: 'pre_pr_reviewing', executable: false },
      guard_failures: [{ code: 'PROOF_CHECKOUT_MISMATCH' }],
      required_work: [{ code: 'RESTORE_PROOF_CHECKOUT' }],
      proof: { status: 'passed' },
    });

    const failedTransition = await runCliFailure(repoDir, [
      'session',
      'transition',
      'pre_pr_reviewing',
      '--session',
      sessionId,
      '--expected-state-version',
      '4',
      '--idempotency-key',
      'review:unsafe-checkout',
      '--actor',
      'agent',
      '--input',
      '{}',
      '--json',
    ]);
    expect(
      parseJson<{ error: { code: string; details: { guard_failures: Array<{ code: string }> } } }>(
        failedTransition.stderr,
      ),
    ).toMatchObject({
      error: {
        code: 'TRANSITION_GUARD_FAILED',
        details: { guard_failures: [{ code: 'PROOF_CHECKOUT_MISMATCH' }] },
      },
    });

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT status, state_version FROM tasks`).get()).toEqual({
        status: 'verifying',
        state_version: 4,
      });
    } finally {
      db.close();
    }
  });

  it('authorizes implementation and verification but rejects review without signed CI evidence', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(repoDir, sessionId);

    const proofReadyNext = parseJson<{
      data: { candidate: { target_state: string; executable: boolean }; guard_failures: unknown[] };
    }>((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout);
    expect(proofReadyNext.data).toMatchObject({
      candidate: { target_state: 'implementing', executable: true },
      guard_failures: [],
    });
    await expect(transition(repoDir, sessionId, 'implementing', 2, 'implement:gate-task')).resolves.toMatchObject({
      data: { lifecycle: { state: 'implementing', state_version: 3 } },
    });
    const uncommittedNext = parseJson<{
      data: { candidate: { target_state: string; executable: boolean }; guard_failures: Array<{ code: string }> };
    }>((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout);
    expect(uncommittedNext.data).toMatchObject({
      candidate: { target_state: 'verifying', executable: false },
      guard_failures: [{ code: 'IMPLEMENTATION_BASIS_NOT_ADVANCED' }],
    });
    await writeFile(path.join(repoDir, 'feature.txt'), 'implemented\n', 'utf8');
    await execFileAsync('git', ['add', 'feature.txt'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'implement feature'], { cwd: repoDir });
    const committedNext = parseJson<{
      data: { candidate: { target_state: string; executable: boolean }; guard_failures: unknown[] };
    }>((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout);
    expect(committedNext.data).toMatchObject({
      candidate: { target_state: 'verifying', executable: true },
      guard_failures: [],
    });
    await expect(transition(repoDir, sessionId, 'verifying', 3, 'verify:gate-task')).resolves.toMatchObject({
      data: { lifecycle: { state: 'verifying', state_version: 4 } },
    });
    await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json']);
    const rejectedReview = await runCliFailure(repoDir, [
      'session',
      'transition',
      'pre_pr_reviewing',
      '--session',
      sessionId,
      '--expected-state-version',
      '4',
      '--idempotency-key',
      'review:gate-task',
      '--actor',
      'agent',
      '--input',
      '{}',
      '--json',
    ]);
    expect(
      parseJson<{ error: { code: string; details: { guard_failures: Array<{ code: string; owner_issue: number }> } } }>(
        rejectedReview.stderr,
      ),
    ).toMatchObject({
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
      proofPlan(['node', '-e', 'process.stderr.write("still failing\\n"); process.exit(1)']),
    );
    await transition(repoDir, sessionId, 'implementing', 2, 'iterate:implement');
    await writeFile(path.join(repoDir, 'feature.txt'), 'initial implementation\n', 'utf8');
    await execFileAsync('git', ['add', 'feature.txt'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'initial implementation'], { cwd: repoDir });
    await transition(repoDir, sessionId, 'verifying', 3, 'iterate:verify:0');

    let version = 4;
    for (let cycle = 1; cycle <= 4; cycle += 1) {
      const receipt = parseJson<{ data: { receipt: { head_after: string } } }>(
        (await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json']))
          .stdout,
      );
      const next = parseJson<{
        data: {
          candidate: { target_state: string; executable: boolean };
          repair_budget: { attempts_used: number; remaining: number; exhausted: boolean };
          implementation_basis: { head_sha: string; source: string };
          pre_pr_review: { iteration_count: number };
        };
      }>((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout);
      expect(next.data).toMatchObject({
        candidate: { target_state: 'implementing', executable: true },
        implementation_basis: {
          head_sha: receipt.data.receipt.head_after,
          source: 'failed_local_proof',
        },
        pre_pr_review: { iteration_count: cycle - 1 },
        repair_budget: { attempts_used: 0, remaining: 3, exhausted: false },
      });
      await transition(repoDir, sessionId, 'implementing', version, `iterate:open:${cycle}`);
      version += 1;
      await writeFile(path.join(repoDir, 'feature.txt'), `iteration ${cycle}\n`, { flag: 'a' });
      await execFileAsync('git', ['add', 'feature.txt'], { cwd: repoDir });
      await execFileAsync('git', ['commit', '-m', `pre-pr iteration ${cycle}`], { cwd: repoDir });
      const committedNext = parseJson<{
        data: {
          candidate: { target_state: string; executable: boolean };
          implementation_basis: { head_sha: string; source: string };
        };
      }>((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout);
      expect(committedNext.data).toMatchObject({
        candidate: { target_state: 'verifying', executable: true },
        implementation_basis: {
          head_sha: receipt.data.receipt.head_after,
          source: 'failed_local_proof',
        },
      });
      await transition(repoDir, sessionId, 'verifying', version, `iterate:verify:${cycle}`);
      version += 1;
    }

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(
        db.prepare(`SELECT COUNT(*) AS count FROM session_transitions WHERE to_state = 'repairing'`).get(),
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM session_transitions WHERE to_state = 'implementing' AND from_state <> 'proof_ready'`,
          )
          .get(),
      ).toEqual({ count: 4 });
    } finally {
      db.close();
    }
  });

  it('accepts current pre-PR findings before signed CI and retains their audit summary', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(repoDir, sessionId);
    await transition(repoDir, sessionId, 'implementing', 2, 'pre-pr-review:implement');
    await writeFile(path.join(repoDir, 'feature.txt'), 'initial implementation\n', 'utf8');
    await execFileAsync('git', ['add', 'feature.txt'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'initial implementation'], { cwd: repoDir });
    await transition(repoDir, sessionId, 'verifying', 3, 'pre-pr-review:verify');
    await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json']);
    const headSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();
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
    ).resolves.toMatchObject({
      data: { lifecycle: { state: 'implementing', state_version: 5 } },
    });

    const next = parseJson<{
      data: {
        pre_pr_review: { status: string; iteration_count: number; findings: Array<{ id: string }> };
        implementation_basis: { head_sha: string; source: string };
        repair_budget: { attempts_used: number };
      };
    }>((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout);
    expect(next.data).toMatchObject({
      pre_pr_review: {
        status: 'changes_required',
        iteration_count: 1,
        findings: [{ id: 'capture-auth-no-mutation' }],
      },
      implementation_basis: { head_sha: headSha, source: 'pre_pr_review' },
      repair_budget: { attempts_used: 0 },
    });

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      const row = db
        .prepare(`SELECT event_json FROM audit_events WHERE event_type = 'transition_applied' ORDER BY sequence DESC`)
        .get() as { event_json: string };
      expect(JSON.parse(row.event_json)).toMatchObject({
        payload: {
          pre_pr_review: {
            outcome: 'changes_required',
            head_sha: headSha,
            finding_count: 1,
            finding_ids: ['capture-auth-no-mutation'],
          },
        },
      });
    } finally {
      db.close();
    }

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
    const resumed = parseJson<{
      data: {
        candidate: { target_state: string; executable: boolean };
        guard_failures: Array<{ code: string }>;
        implementation_basis: { head_sha: string; source: string };
        pre_pr_review: { iteration_count: number };
      };
    }>((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout);
    expect(resumed.data).toMatchObject({
      candidate: { target_state: 'verifying', executable: false },
      guard_failures: [{ code: 'IMPLEMENTATION_BASIS_NOT_ADVANCED' }],
      implementation_basis: { head_sha: headSha, source: 'pre_pr_review' },
      pre_pr_review: { iteration_count: 1 },
    });

    await writeFile(path.join(repoDir, 'finding-fix.txt'), 'address current finding\n', 'utf8');
    await execFileAsync('git', ['add', 'finding-fix.txt'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'address pre-pr finding'], { cwd: repoDir });
    const staleAfterCommit = parseJson<{
      data: {
        pre_pr_review: { status: string; head_sha: string };
        implementation_basis: { head_sha: string; source: string };
        proof: { status: string };
      };
    }>((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout);
    expect(staleAfterCommit.data).toMatchObject({
      pre_pr_review: { status: 'stale', head_sha: headSha },
      implementation_basis: { head_sha: headSha, source: 'pre_pr_review' },
      proof: { status: 'stale' },
    });
  });

  it('rejects malformed pre-PR review input without lifecycle, evidence, or budget mutation', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(repoDir, sessionId);
    await forceVerifying(repoDir, sessionId);
    await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json']);
    const headSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();

    const before = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    const counts = {
      transitions: (before.prepare(`SELECT COUNT(*) AS count FROM session_transitions`).get() as { count: number })
        .count,
      receipts: (before.prepare(`SELECT COUNT(*) AS count FROM gate_receipts`).get() as { count: number }).count,
      repairs: (
        before.prepare(`SELECT COUNT(*) AS count FROM session_transitions WHERE to_state = 'repairing'`).get() as {
          count: number;
        }
      ).count,
    };
    before.close();

    const failure = parseJson<{
      error: {
        code: string;
        details: {
          actual_state_version: number;
          lifecycle_phase: string;
          guard_failures: Array<{ code: string }>;
          unchanged: string[];
        };
      };
    }>(
      (
        await runCliFailure(repoDir, [
          'session',
          'transition',
          'implementing',
          '--session',
          sessionId,
          '--expected-state-version',
          '4',
          '--idempotency-key',
          'pre-pr-review:invalid',
          '--actor',
          'agent',
          '--input',
          JSON.stringify({
            pre_pr_review: {
              outcome: 'clean',
              head_sha: headSha,
              evidence_ref: 'review-ledger:invalid',
              evidence_sha256: 'a'.repeat(64),
              findings: [{ id: 'finding-1', summary: 'Cannot accompany clean', path: 'src/index.ts' }],
            },
          }),
          '--json',
        ])
      ).stderr,
    );
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

    const after = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(after.prepare(`SELECT status, state_version FROM tasks`).get()).toEqual({
        status: 'verifying',
        state_version: 4,
      });
      expect(after.prepare(`SELECT COUNT(*) AS count FROM session_transitions`).get()).toEqual({
        count: counts.transitions,
      });
      expect(after.prepare(`SELECT COUNT(*) AS count FROM gate_receipts`).get()).toEqual({
        count: counts.receipts,
      });
      expect(
        after.prepare(`SELECT COUNT(*) AS count FROM session_transitions WHERE to_state = 'repairing'`).get(),
      ).toEqual({ count: counts.repairs });
    } finally {
      after.close();
    }
  });

  it('rejects an unrelated clean commit that does not descend from the failed implementation basis', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    const plan = await recordProofPlan(
      repoDir,
      sessionId,
      proofPlan(['node', '-e', 'process.stderr.write("expected failure\\n"); process.exit(1)']),
    );
    await transition(repoDir, sessionId, 'implementing', 2, 'basis:implement');
    await writeFile(path.join(repoDir, 'feature.txt'), 'first implementation\n', 'utf8');
    await execFileAsync('git', ['add', 'feature.txt'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'first implementation'], { cwd: repoDir });
    await transition(repoDir, sessionId, 'verifying', 3, 'basis:verify');
    const failedReceipt = parseJson<{ data: { receipt: { head_after: string } } }>(
      (await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json'])).stdout,
    );
    await transition(repoDir, sessionId, 'implementing', 4, 'basis:reenter');

    await execFileAsync('git', ['reset', '--hard', plan.data.proof_plan.baseline_head_sha], { cwd: repoDir });
    await writeFile(path.join(repoDir, 'unrelated.txt'), 'sibling history\n', 'utf8');
    await execFileAsync('git', ['add', 'unrelated.txt'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'unrelated sibling commit'], { cwd: repoDir });

    const rejected = parseJson<{
      error: { code: string; details: { guard_failures: Array<{ code: string; message: string }> } };
    }>(
      (
        await runCliFailure(repoDir, [
          'session',
          'transition',
          'verifying',
          '--session',
          sessionId,
          '--expected-state-version',
          '5',
          '--idempotency-key',
          'basis:unrelated',
          '--actor',
          'agent',
          '--input',
          '{}',
          '--json',
        ])
      ).stderr,
    );
    expect(rejected).toMatchObject({
      error: {
        code: 'TRANSITION_GUARD_FAILED',
        details: {
          guard_failures: [
            {
              code: 'IMPLEMENTATION_BASIS_NOT_ADVANCED',
            },
          ],
        },
      },
    });
    expect(rejected.error.details.guard_failures[0]?.message).toContain(
      `implementation basis ${failedReceipt.data.receipt.head_after}`,
    );

    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(db.prepare(`SELECT status, state_version FROM tasks`).get()).toEqual({
        status: 'implementing',
        state_version: 5,
      });
    } finally {
      db.close();
    }
  });

  it('marks a passing receipt stale after a commit and accepts a fresh current-HEAD rerun', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(repoDir, sessionId);
    await forceVerifying(repoDir, sessionId);
    const first = parseJson<{ data: { receipt: { id: string } } }>(
      (await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json'])).stdout,
    );
    await writeFile(path.join(repoDir, 'new-head.txt'), 'new head\n', 'utf8');
    await execFileAsync('git', ['add', 'new-head.txt'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'advance head'], { cwd: repoDir });

    const stale = parseJson<{
      data: {
        candidate: null;
        proof: { status: string; gates: Array<{ status: string; receipt_id: string }> };
        staleness: { status: string; is_stale: boolean; stale_receipt_ids: string[] };
      };
    }>((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout);
    expect(stale.data).toMatchObject({
      candidate: null,
      proof: { status: 'stale', gates: [{ status: 'stale', receipt_id: first.data.receipt.id }] },
      staleness: { status: 'stale', is_stale: true, stale_receipt_ids: [first.data.receipt.id] },
    });

    const fresh = parseJson<{ data: { receipt: { id: string; sequence: number } } }>(
      (await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json'])).stdout,
    );
    expect(fresh.data.receipt.sequence).toBe(2);
    const current = parseJson<{ data: { candidate: { target_state: string }; proof: { status: string } } }>(
      (await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout,
    );
    expect(current.data).toMatchObject({
      candidate: { target_state: 'pre_pr_reviewing' },
      proof: { status: 'passed' },
    });
  });

  it('treats a missing or altered receipt artifact as corrupt proof', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(repoDir, sessionId);
    await forceVerifying(repoDir, sessionId);
    const gate = parseJson<{ data: { receipt: { artifact: { path: string } } } }>(
      (await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json'])).stdout,
    );
    const execution = JSON.parse(await readFile(path.join(repoDir, gate.data.receipt.artifact.path), 'utf8')) as {
      stdout: { path: string };
    };
    await writeFile(path.join(repoDir, execution.stdout.path), 'tampered output\n', 'utf8');

    const next = parseJson<{
      data: {
        candidate: null;
        proof: { status: string; gates: Array<{ status: string }> };
        staleness: { status: string };
      };
    }>((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout);
    expect(next.data).toMatchObject({
      candidate: null,
      proof: { status: 'corrupt', gates: [{ status: 'corrupt' }] },
      staleness: { status: 'corrupt' },
    });
  });

  it('uses the latest receipt per gate so a later current-HEAD failure supersedes a pass', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(
      repoDir,
      sessionId,
      proofPlan(['node', '-e', 'process.exit(Number(process.env.THREADLOOP_GATE_EXIT ?? "0"))']),
    );
    await forceVerifying(repoDir, sessionId);
    const args = ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json'];
    await runCli(repoDir, args, { THREADLOOP_GATE_EXIT: '0' });
    const failed = parseJson<{ data: { receipt: { id: string; sequence: number; result: string } } }>(
      (await runCli(repoDir, args, { THREADLOOP_GATE_EXIT: '9' })).stdout,
    );
    expect(failed.data.receipt).toMatchObject({ sequence: 2, result: 'failed' });

    const next = parseJson<{
      data: {
        candidate: { target_state: string };
        proof: { status: string; gates: Array<{ receipt_id: string; result: string; status: string }> };
      };
    }>((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout);
    expect(next.data).toMatchObject({
      candidate: { target_state: 'implementing' },
      proof: {
        status: 'failed',
        gates: [{ receipt_id: failed.data.receipt.id, result: 'failed', status: 'failed' }],
      },
    });
  });

  it('reports proof migration for schema v3 without mutating the database', async () => {
    const repoDir = await makeCommittedRepo();
    const started = parseJson<{ data: { session_id: string } }>(
      (await runCli(repoDir, ['session', 'start', 'Legacy proof state', '--goal', 'Read without migration', '--json']))
        .stdout,
    );
    const dbPath = path.join(repoDir, '.threadloop/state/state.db');
    await resetSqliteConnections(repoDir);
    const downgrade = new DatabaseSync(dbPath);
    try {
      downgrade.exec(`
        DROP TABLE gate_receipts;
        DROP TABLE proof_plans;
        UPDATE metadata SET value = '3' WHERE key = 'schema_version';
      `);
    } finally {
      downgrade.close();
    }
    const before = await readFile(dbPath);

    const next = parseJson<{
      data: {
        candidate: null;
        proof: { status: string };
        staleness: { status: string; is_stale: null };
        repair_budget: { status: string; attempts_used: null };
      };
    }>((await runCli(repoDir, ['session', 'next', '--session', started.data.session_id, '--json'])).stdout);
    expect(next.data).toMatchObject({
      candidate: null,
      guard_failures: [{ code: 'SESSION_SCHEMA_MIGRATION_REQUIRED' }],
      proof: { status: 'migration_required' },
      staleness: { status: 'migration_required', is_stale: null },
      repair_budget: { status: 'migration_required', attempts_used: null },
    });
    expect(await readFile(dbPath)).toEqual(before);

    const unchanged = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(unchanged.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get()).toEqual({
        value: '3',
      });
      expect(
        unchanged
          .prepare(
            `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('proof_plans', 'gate_receipts')`,
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      unchanged.close();
    }
  });
});

describe('declared gate setup', { timeout: 20_000 }, () => {
  function planWithSetup(setup: unknown[], gateCommand = ['node', '-e', 'process.exit(0)']) {
    const base = proofPlan(gateCommand);
    return { ...base, gates: [{ ...base.gates[0], setup }] };
  }

  async function runSetupGate(repoDir: string, sessionId: string, plan: unknown) {
    await recordProofPlan(repoDir, sessionId, plan as ReturnType<typeof proofPlan>);
    await forceVerifying(repoDir, sessionId);
    return runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json']);
  }

  it('records every declared setup step that ran on a passing receipt', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    // Provisioning output must land outside the repository, because a gate still requires a clean tree at
    // both ends and `git status --untracked-files=all` counts a new untracked file as dirty.
    const markerPath = path.join(await makeScratchDirectory(), 'provisioned.txt');

    const gate = parseJson<{
      data: {
        receipt: {
          result: string;
          setup: Array<{ id: string; result: string; exit_status: number | null; clean_before: boolean }>;
        };
      };
    }>(
      (
        await runSetupGate(
          repoDir,
          sessionId,
          planWithSetup([
            {
              id: 'provision',
              // Writes outside the repository so the tree stays clean, which the gate still requires.
              command: ['node', '-e', `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ok")`],
              working_directory: '.',
              timeout_ms: 5_000,
            },
          ]),
        )
      ).stdout,
    );

    expect(gate.data.receipt.result).toBe('passed');
    expect(gate.data.receipt.setup).toHaveLength(1);
    expect(gate.data.receipt.setup[0]).toMatchObject({
      id: 'provision',
      result: 'passed',
      exit_status: 0,
      clean_before: true,
    });
  });

  it('records setup_failed without running the gate command when provisioning fails', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    const gateMarker = path.join(repoDir, 'gate-ran.txt');

    const gate = parseJson<{
      data: { receipt: { result: string; exit_status: number | null; setup: Array<{ id: string; result: string }> } };
    }>(
      (
        await runSetupGate(
          repoDir,
          sessionId,
          planWithSetup(
            [
              { id: 'broken', command: ['node', '-e', 'process.exit(7)'], working_directory: '.', timeout_ms: 5_000 },
              {
                id: 'unreached',
                command: ['node', '-e', 'process.exit(0)'],
                working_directory: '.',
                timeout_ms: 5_000,
              },
            ],
            ['node', '-e', `require("node:fs").writeFileSync(${JSON.stringify(gateMarker)}, "ran")`],
          ),
        )
      ).stdout,
    );

    expect(gate.data.receipt.result).toBe('setup_failed');
    expect(gate.data.receipt.setup.map((step) => step.id)).toEqual(['broken']);
    expect(gate.data.receipt.setup[0]?.result).toBe('failed');
    expect(gate.data.receipt.exit_status).toBeNull();
    await expect(readFile(gateMarker, 'utf8')).rejects.toThrow();
  });

  it('names the setup step and changed paths when provisioning invalidates the repository', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    const scratchDirectory = await makeScratchDirectory();
    const laterSetupMarker = path.join(scratchDirectory, 'later-setup-ran.txt');
    const gateMarker = path.join(scratchDirectory, 'gate-ran.txt');

    const gate = parseJson<{
      data: {
        receipt: { result: string; setup: Array<{ id: string; clean_after: boolean }> };
        diagnostic: {
          code: string;
          message: string;
          step_id: string | null;
          changed_files: string[];
          hint: string;
        } | null;
      };
    }>(
      (
        await runSetupGate(
          repoDir,
          sessionId,
          planWithSetup(
            [
              {
                id: 'sync',
                command: ['node', '-e', 'require("node:fs").writeFileSync("package-lock.json", "changed\\n")'],
                working_directory: '.',
                timeout_ms: 5_000,
              },
              {
                id: 'unreached',
                command: ['node', '-e', `require("node:fs").writeFileSync(${JSON.stringify(laterSetupMarker)}, "ran")`],
                working_directory: '.',
                timeout_ms: 5_000,
              },
            ],
            ['node', '-e', `require("node:fs").writeFileSync(${JSON.stringify(gateMarker)}, "ran")`],
          ),
        )
      ).stdout,
    );

    expect(gate.data.receipt).toMatchObject({
      result: 'invalidated',
      setup: [{ id: 'sync', clean_after: false }],
    });
    expect(gate.data.diagnostic).toEqual({
      code: 'SETUP_MUTATED_REPOSITORY',
      message: 'Setup step sync changed the repository before the gate ran: package-lock.json.',
      step_id: 'sync',
      changed_files: ['package-lock.json'],
      hint: 'Restore or commit the listed paths, change the setup declaration to use a frozen installer and gitignored output, then start a new session.',
    });
    await expect(readFile(laterSetupMarker, 'utf8')).rejects.toThrow();
    await expect(readFile(gateMarker, 'utf8')).rejects.toThrow();
  });

  it('distinguishes a gate mutation from setup mutation and names the recovery path', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);

    const gate = parseJson<{
      data: {
        receipt: { result: string; setup: unknown[] };
        diagnostic: {
          code: string;
          message: string;
          step_id: string | null;
          changed_files: string[];
          hint: string;
        } | null;
      };
    }>(
      (
        await runSetupGate(
          repoDir,
          sessionId,
          planWithSetup([], ['node', '-e', 'require("node:fs").writeFileSync("generated-report.json", "{}\\n")']),
        )
      ).stdout,
    );

    expect(gate.data.receipt).toMatchObject({ result: 'invalidated', setup: [] });
    expect(gate.data.diagnostic).toEqual({
      code: 'GATE_MUTATED_REPOSITORY',
      message: 'Gate command changed the repository while it ran: generated-report.json.',
      step_id: null,
      changed_files: ['generated-report.json'],
      hint: 'Restore or commit the listed paths, change the gate to write generated output outside the repository or to gitignored paths, then start a new session.',
    });
  });

  it('prints the mutation cause and recovery action in text mode', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(
      repoDir,
      sessionId,
      planWithSetup([
        {
          id: 'sync',
          command: ['node', '-e', 'require("node:fs").writeFileSync("package-lock.json", "changed\\n")'],
          working_directory: '.',
          timeout_ms: 5_000,
        },
      ]) as ReturnType<typeof proofPlan>,
    );
    await forceVerifying(repoDir, sessionId);

    const result = await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId]);

    expect(result.stdout).toContain(
      'Setup step sync changed the repository before the gate ran: package-lock.json.\n' +
        'Recovery: Restore or commit the listed paths, change the setup declaration to use a frozen installer and gitignored output, then start a new session.\n',
    );
  });

  it('projects setup failure as an operator handoff that consumes no repair budget', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await runSetupGate(
      repoDir,
      sessionId,
      planWithSetup([
        { id: 'broken', command: ['node', '-e', 'process.exit(7)'], working_directory: '.', timeout_ms: 5_000 },
      ]),
    );

    const next = parseJson<{
      data: {
        candidate: null;
        proof: { status: string; gates: Array<{ status: string; result: string }> };
        repair_budget: { attempts_used: number; remaining: number; exhausted: boolean };
        guard_failures: Array<{ code: string }>;
        required_work: Array<{ code: string }>;
      };
    }>((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout);

    expect(next.data).toMatchObject({
      candidate: null,
      proof: { status: 'setup_failed', gates: [{ status: 'setup_failed', result: 'setup_failed' }] },
      guard_failures: [{ code: 'PROOF_GATE_SETUP_FAILED' }],
      required_work: [{ code: 'CORRECT_GATE_SETUP' }],
    });
    // A broken toolchain is a configuration problem, so it must not spend the post-PR repair allowance.
    expect(next.data.repair_budget).toMatchObject({ attempts_used: 0, exhausted: false });
  });

  it('treats a receipt whose recorded setup does not match the declared plan as corrupt', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await runSetupGate(
      repoDir,
      sessionId,
      planWithSetup([
        { id: 'provision', command: ['node', '-e', 'process.exit(0)'], working_directory: '.', timeout_ms: 5_000 },
      ]),
    );

    await resetSqliteConnections(repoDir);
    const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'));
    try {
      const stored = db.prepare(`SELECT receipt_json FROM gate_receipts`).get() as { receipt_json: string };
      const payload = JSON.parse(stored.receipt_json) as { setup: Array<{ command: string[] }> };
      payload.setup[0]!.command = ['node', '-e', 'process.exit(1)'];
      db.exec(`DROP TRIGGER gate_receipts_no_update`);
      db.prepare(`UPDATE gate_receipts SET receipt_json = ?`).run(canonicalJson(payload));
      db.exec(`
        CREATE TRIGGER gate_receipts_no_update
        BEFORE UPDATE ON gate_receipts
        BEGIN
          SELECT RAISE(ABORT, 'gate receipts are immutable');
        END
      `);
    } finally {
      db.close();
    }

    const next = parseJson<{ data: { proof: { status: string } } }>(
      (await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout,
    );
    expect(next.data.proof.status).toBe('corrupt');
  });
});

describe('gate receipt result domain migration', { timeout: 20_000 }, () => {
  it('widens a pre-v8 gate_receipts result domain while preserving every stored receipt', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(repoDir, sessionId);
    await forceVerifying(repoDir, sessionId);
    const first = parseJson<{ data: { receipt: { id: string; sequence: number } } }>(
      (await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json'])).stdout,
    );

    // Rebuild the table with the pre-v8 narrow result domain and roll the recorded version back, so the next
    // CLI invocation exercises the real migration path against real stored evidence.
    await resetSqliteConnections(repoDir);
    const downgrade = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'));
    try {
      downgrade.exec(`
        DROP TRIGGER gate_receipts_no_update;
        DROP TRIGGER gate_receipts_no_delete;
        DROP TRIGGER gate_receipts_no_replace;
        DROP INDEX gate_receipts_session_gate_sequence_idx;
        ALTER TABLE gate_receipts RENAME TO gate_receipts_downgraded;
        CREATE TABLE gate_receipts (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          gate_id TEXT NOT NULL,
          plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256) = 64),
          head_before TEXT NOT NULL,
          head_after TEXT NOT NULL,
          result TEXT NOT NULL CHECK(
            result IN (
              'passed', 'failed', 'timed_out', 'aborted', 'invalidated',
              'execution_error', 'cleanup_failed'
            )
          ),
          artifact_path TEXT NOT NULL,
          artifact_sha256 TEXT NOT NULL CHECK(length(artifact_sha256) = 64),
          receipt_json TEXT NOT NULL,
          receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256) = 64),
          state_version INTEGER NOT NULL CHECK(state_version >= 0),
          created_at TEXT NOT NULL
        );
        INSERT INTO gate_receipts SELECT * FROM gate_receipts_downgraded;
        DROP TABLE gate_receipts_downgraded;
        CREATE INDEX gate_receipts_session_gate_sequence_idx
          ON gate_receipts(session_id, gate_id, sequence DESC);
        CREATE TRIGGER gate_receipts_no_update
        BEFORE UPDATE ON gate_receipts
        BEGIN
          SELECT RAISE(ABORT, 'gate receipts are immutable');
        END;
        CREATE TRIGGER gate_receipts_no_delete
        BEFORE DELETE ON gate_receipts
        BEGIN
          SELECT RAISE(ABORT, 'gate receipts are immutable');
        END;
        CREATE TRIGGER gate_receipts_no_replace
        BEFORE INSERT ON gate_receipts
        WHEN EXISTS (
          SELECT 1 FROM gate_receipts
          WHERE id = NEW.id OR (session_id = NEW.session_id AND gate_id = NEW.gate_id AND sequence = NEW.sequence)
        )
        BEGIN
          SELECT RAISE(ABORT, 'gate receipts are immutable');
        END;
      `);
      downgrade.prepare(`UPDATE metadata SET value = '7' WHERE key = 'schema_version'`).run();
    } finally {
      downgrade.close();
    }
    await resetSqliteConnections(repoDir);

    // A schema at or above v6 but below current requires an explicit operator migration, so reads report
    // migration_required rather than silently rewriting stored evidence.
    const beforeMigration = parseJson<{ data: { lifecycle: { contract_status: string } } }>(
      (await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout,
    );
    expect(beforeMigration.data.lifecycle.contract_status).toBe('migration_required');

    await runCli(repoDir, ['init']);

    await resetSqliteConnections(repoDir);
    const migrated = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'), { readOnly: true });
    try {
      expect(migrated.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get()).toEqual({
        value: '8',
      });
      const definition = migrated
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'gate_receipts'`)
        .get() as { sql: string };
      expect(definition.sql).toContain('setup_failed');
      expect(
        migrated.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'gate_receipts_%'`).all(),
      ).toEqual([]);

      const receipts = migrated.prepare(`SELECT sequence, id, result FROM gate_receipts ORDER BY sequence`).all();
      expect(receipts).toEqual([
        { sequence: first.data.receipt.sequence, id: first.data.receipt.id, result: 'passed' },
      ]);
      for (const trigger of ['gate_receipts_no_update', 'gate_receipts_no_delete', 'gate_receipts_no_replace']) {
        expect(
          migrated.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(trigger),
        ).toEqual({ name: trigger });
      }
    } finally {
      migrated.close();
    }

    // The widened domain must actually be usable after the migration, not merely present in the DDL.
    const setupPlan = (() => {
      const base = proofPlan();
      return {
        ...base,
        gates: [
          {
            ...base.gates[0]!,
            setup: [
              { id: 'broken', command: ['node', '-e', 'process.exit(9)'], working_directory: '.', timeout_ms: 5_000 },
            ],
          },
        ],
      };
    })();
    const secondSession = await startFramedSession(repoDir, {
      commitConfig: false,
      idempotencyKey: 'frame:migrated-setup',
    });
    await recordProofPlan(repoDir, secondSession, setupPlan, 'proof-plan:migrated-setup');
    await forceVerifying(repoDir, secondSession);
    const migratedRun = parseJson<{ data: { receipt: { result: string } } }>(
      (await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', secondSession, '--json']))
        .stdout,
    );
    expect(migratedRun.data.receipt.result).toBe('setup_failed');
  });
});

describe('local and CI receipts describe setup identically', { timeout: 60_000 }, () => {
  it('records the same setup for the same HEAD through both execution paths', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    const setupStep = {
      id: 'provision',
      command: ['node', '-e', 'process.stdout.write("provisioned\\n")'],
      working_directory: '.',
      timeout_ms: 5_000,
    };
    const base = proofPlan();
    const plan = { ...base, gates: [{ ...base.gates[0]!, setup: [setupStep] }] };
    const recorded = await recordProofPlan(repoDir, sessionId, plan);
    await forceVerifying(repoDir, sessionId);

    const local = parseJson<{ data: { receipt: { setup: Record<string, unknown>[]; result: string } } }>(
      (await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json'])).stdout,
    );

    // Drive the real CI sensor against the same HEAD and the same declared gate.
    const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();
    const reportPath = path.join(await makeScratchDirectory(), 'gate-report.json');
    await execFileAsync('npx', ['tsx', 'scripts/run-ci-gate-sensor.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        THREADLOOP_SESSION_ID: sessionId,
        THREADLOOP_PLAN_SHA256: recorded.data.proof_plan.sha256,
        THREADLOOP_GATE_ID: 'repository-check',
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
    expect(report.setup.map(describable)).toEqual(local.data.receipt.setup.map(describable));
    expect(report.result).toBe(local.data.receipt.result);
    expect(report.result).toBe('passed');
    // The digests are of the same command's output, so they must agree byte for byte.
    expect(report.setup[0]?.output).toEqual(local.data.receipt.setup[0]?.output);
  });

  it('emits the same setup-mutation diagnostic from the CI sensor', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    const setupStep = {
      id: 'sync',
      command: ['node', '-e', 'require("node:fs").writeFileSync("package-lock.json", "changed\\n")'],
      working_directory: '.',
      timeout_ms: 5_000,
    };
    const base = proofPlan();
    const plan = { ...base, gates: [{ ...base.gates[0]!, setup: [setupStep] }] };
    const recorded = await recordProofPlan(repoDir, sessionId, plan);
    const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();
    const reportPath = path.join(await makeScratchDirectory(), 'gate-report.json');

    const failure = await execFileAsync('npx', ['tsx', 'scripts/run-ci-gate-sensor.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        THREADLOOP_SESSION_ID: sessionId,
        THREADLOOP_PLAN_SHA256: recorded.data.proof_plan.sha256,
        THREADLOOP_GATE_ID: 'repository-check',
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
    expect(failure?.stderr).toContain(
      'Setup step sync changed the repository before the gate ran: package-lock.json.\n' +
        'Recovery: Restore or commit the listed paths, change the setup declaration to use a frozen installer and gitignored output, then start a new session.\n',
    );
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as { result: string };
    expect(report.result).toBe('invalidated');
  });
});
