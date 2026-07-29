import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from '../../src/adapters/fs/sqlite-driver.js';
import { resetSqliteConnections } from '../../src/adapters/fs/sqlite-store.js';

const execFileAsync = promisify(execFile);
const temporaryRepos: string[] = [];
const projectRoot = process.cwd();
const tsxCli = path.join(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliEntry = path.join(projectRoot, 'src/cli.ts');
const fixtureRepository = 'https://github.com/example/threadloop-fixture';
const fixtureBranch = 'issue-41/signed-receipts';
const sensorSha = 'a'.repeat(40);

async function runCli(cwd: string, args: string[]) {
  return execFileAsync('node', [tsxCli, cliEntry, ...args], { cwd });
}

async function runCliWithEnv(cwd: string, args: string[], env: Record<string, string>) {
  return execFileAsync('node', [tsxCli, cliEntry, ...args], { cwd, env: { ...process.env, ...env } });
}

async function runCliFailure(cwd: string, args: string[]) {
  try {
    await runCli(cwd, args);
    throw new Error(`Expected CLI command to fail: ${args.join(' ')}`);
  } catch (error) {
    return error as Error & { stdout?: string; stderr?: string };
  }
}

function parseJson<T>(value: string | undefined) {
  return JSON.parse(value ?? '') as T;
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

async function startFramedSession(repoDir: string) {
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
  await execFileAsync('git', ['add', '.threadloop/config.json'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-m', 'initialize ThreadLoop'], { cwd: repoDir });
  await runCli(repoDir, [
    'session',
    'transition',
    'framed',
    '--session',
    started.data.session_id,
    '--expected-state-version',
    '0',
    '--idempotency-key',
    'frame:gate-task',
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
    contract_version: 3,
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

async function forceVerifying(repoDir: string) {
  await resetSqliteConnections(repoDir);
  const db = new DatabaseSync(path.join(repoDir, '.threadloop/state/state.db'));
  try {
    db.prepare(`UPDATE tasks SET status = 'verifying', state_version = 4`).run();
  } finally {
    db.close();
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
      expect(db.prepare(`SELECT value FROM metadata WHERE key = 'schema_version'`).get()).toEqual({ value: '6' });
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
        plan_json: `{"acceptance_criteria":["All repository checks pass"],"ci":{"build_signer_sha":"${sensorSha}","build_signer_uri":"https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-gate-sensor.yml@${sensorSha}","certificate_identity":"${fixtureRepository}/.github/workflows/threadloop.yml@refs/heads/${fixtureBranch}","issuer":"https://token.actions.githubusercontent.com","provider":"github-actions","source_repository":"${fixtureRepository}"},"contract_version":3,"gates":[{"command":["node","-e","process.stdout.write(\\"ok\\\\n\\")"],"id":"repository-check","timeout_ms":5000,"working_directory":"."}],"review":{"build_signer_sha":"${sensorSha}","build_signer_uri":"https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-review-sensor.yml@${sensorSha}","certificate_identity":"${fixtureRepository}/.github/workflows/threadloop.yml@refs/heads/${fixtureBranch}","issuer":"https://token.actions.githubusercontent.com","provider":"github-actions","source_repository":"${fixtureRepository}"}}`,
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
    await forceVerifying(repoDir);

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
          sensor: { name: 'threadloop-local-gate', contract_version: 1 },
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
    await forceVerifying(repoDir);

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
    await forceVerifying(repoDir);

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
    await forceVerifying(repoDir);

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

  it('rejects gate execution after leaving the named proof-plan branch', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(repoDir, sessionId);
    await forceVerifying(repoDir);
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
      await forceVerifying(repoDir);

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
    await forceVerifying(repoDir);
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
      candidate: { target_state: 'repairing', executable: true },
      proof: { status: 'failed' },
    });
  });

  it('assigns deterministic distinct receipt sequences to concurrent completions', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(repoDir, sessionId);
    await forceVerifying(repoDir);
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
    await forceVerifying(repoDir);
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
    await forceVerifying(repoDir);
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
    await forceVerifying(repoDir);
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
      contract_version: 3,
      candidate: {
        from_state: 'verifying',
        target_state: 'reviewing',
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
    await forceVerifying(repoDir);
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
      candidate: { target_state: 'reviewing', executable: false },
      guard_failures: [{ code: 'PROOF_CHECKOUT_MISMATCH' }],
      required_work: [{ code: 'RESTORE_PROOF_CHECKOUT' }],
      proof: { status: 'passed' },
    });

    const failedTransition = await runCliFailure(repoDir, [
      'session',
      'transition',
      'reviewing',
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
      guard_failures: [{ code: 'COMMITTED_IMPLEMENTATION_REQUIRED' }],
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
      'reviewing',
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

  it('derives three repair cycles from transition history and makes blocked the only fourth outcome', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(
      repoDir,
      sessionId,
      proofPlan(['node', '-e', 'process.stderr.write("still failing\\n"); process.exit(1)']),
    );
    await transition(repoDir, sessionId, 'implementing', 2, 'repair:implement');
    await writeFile(path.join(repoDir, 'feature.txt'), 'initial implementation\n', 'utf8');
    await execFileAsync('git', ['add', 'feature.txt'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'initial implementation'], { cwd: repoDir });
    await transition(repoDir, sessionId, 'verifying', 3, 'repair:verify:0');

    let version = 4;
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json']);
      const next = parseJson<{
        data: {
          candidate: { target_state: string; executable: boolean };
          repair_budget: { attempts_used: number; remaining: number; exhausted: boolean };
        };
      }>((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout);
      expect(next.data).toMatchObject({
        candidate: { target_state: 'repairing', executable: true },
        repair_budget: { attempts_used: cycle - 1, remaining: 4 - cycle, exhausted: false },
      });
      await transition(repoDir, sessionId, 'repairing', version, `repair:open:${cycle}`);
      version += 1;
      await writeFile(path.join(repoDir, 'feature.txt'), `repair ${cycle}\n`, { flag: 'a' });
      await execFileAsync('git', ['add', 'feature.txt'], { cwd: repoDir });
      await execFileAsync('git', ['commit', '-m', `repair ${cycle}`], { cwd: repoDir });
      await transition(repoDir, sessionId, 'verifying', version, `repair:verify:${cycle}`);
      version += 1;
    }

    await runCli(repoDir, ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json']);
    const exhausted = parseJson<{
      data: {
        candidate: { target_state: string; executable: boolean };
        repair_budget: { attempts_used: number; remaining: number; exhausted: boolean };
      };
    }>((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout);
    expect(exhausted.data).toMatchObject({
      candidate: { target_state: 'blocked', executable: false },
      repair_budget: { attempts_used: 3, remaining: 0, exhausted: true },
    });

    const fourthRepair = await runCliFailure(repoDir, [
      'session',
      'transition',
      'repairing',
      '--session',
      sessionId,
      '--expected-state-version',
      String(version),
      '--idempotency-key',
      'repair:open:4',
      '--actor',
      'agent',
      '--input',
      '{}',
      '--json',
    ]);
    expect(
      parseJson<{ error: { code: string; details: { guard_failures: Array<{ code: string }> } } }>(fourthRepair.stderr),
    ).toMatchObject({
      error: {
        code: 'TRANSITION_GUARD_FAILED',
        details: { guard_failures: [{ code: 'REPAIR_BUDGET_EXHAUSTED' }] },
      },
    });

    await expect(
      transition(repoDir, sessionId, 'blocked', version, 'repair:blocked', {
        block: {
          reason: 'Local proof still fails after three repairs',
          evidence_ref: 'receipt:latest',
          recovery: 'Human decides whether to expand the repair budget',
          stop_code: 'REPAIR_BUDGET_EXHAUSTED',
        },
      }),
    ).resolves.toMatchObject({
      data: { lifecycle: { state: 'blocked', state_version: version + 1 } },
    });
  }, 60_000);

  it('marks a passing receipt stale after a commit and accepts a fresh current-HEAD rerun', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(repoDir, sessionId);
    await forceVerifying(repoDir);
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
      candidate: { target_state: 'reviewing' },
      proof: { status: 'passed' },
    });
  });

  it('treats a missing or altered receipt artifact as corrupt proof', async () => {
    const repoDir = await makeCommittedRepo();
    const sessionId = await startFramedSession(repoDir);
    await recordProofPlan(repoDir, sessionId);
    await forceVerifying(repoDir);
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
    await forceVerifying(repoDir);
    const args = ['session', 'gate', 'run', 'repository-check', '--session', sessionId, '--json'];
    await runCliWithEnv(repoDir, args, { THREADLOOP_GATE_EXIT: '0' });
    const failed = parseJson<{ data: { receipt: { id: string; sequence: number; result: string } } }>(
      (await runCliWithEnv(repoDir, args, { THREADLOOP_GATE_EXIT: '9' })).stdout,
    );
    expect(failed.data.receipt).toMatchObject({ sequence: 2, result: 'failed' });

    const next = parseJson<{
      data: {
        candidate: { target_state: string };
        proof: { status: string; gates: Array<{ receipt_id: string; result: string; status: string }> };
      };
    }>((await runCli(repoDir, ['session', 'next', '--session', sessionId, '--json'])).stdout);
    expect(next.data).toMatchObject({
      candidate: { target_state: 'repairing' },
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
        candidate: { target_state: string; executable: boolean };
        proof: { status: string };
        staleness: { status: string; is_stale: null };
        repair_budget: { status: string; attempts_used: null };
      };
    }>((await runCli(repoDir, ['session', 'next', '--session', started.data.session_id, '--json'])).stdout);
    expect(next.data).toMatchObject({
      candidate: { target_state: 'framed', executable: true },
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
