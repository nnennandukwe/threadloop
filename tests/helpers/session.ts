import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { applySessionTransition, closeSqliteConnections } from '../../src/adapters/fs/sqlite-store.js';
import type { ProofSetupStep } from '../../src/domain/proof.js';
import { canonicalizeTransitionRequest, type TransitionRequest } from '../../src/domain/session-transition.js';
import { fixtureBranch, fixtureRepository, trustPolicy } from '../fixtures/receipts.js';
import { parseJson, runCli, transition } from './cli.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

/** A fresh canonical temporary directory, removed by `cleanupTemporaryState`. */
export async function makeTempDir(prefix = 'threadloop-test-') {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

/** Closes cached SQLite connections and removes every directory `makeTempDir` created. Use as `afterEach`. */
export async function cleanupTemporaryState() {
  closeSqliteConnections();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
}

/** Runs one Git command in `cwd` and returns its trimmed stdout. */
export async function git(cwd: string, ...args: string[]) {
  return (await execFileAsync('git', args, { cwd })).stdout.trim();
}

/** An initialized Git repository with a configured author and no commits. */
export async function makeRepo() {
  const repoDir = await makeTempDir('threadloop-repo-');
  await git(repoDir, 'init');
  await git(repoDir, 'config', 'user.email', 'test@example.com');
  await git(repoDir, 'config', 'user.name', 'Test User');
  return repoDir;
}

/** Writes `files`, commits exactly them, and returns the new HEAD. */
export async function commitFiles(repoDir: string, message: string, files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(path.join(repoDir, name), contents, 'utf8');
  }
  await git(repoDir, 'add', ...Object.keys(files));
  await git(repoDir, 'commit', '-m', message);
  return git(repoDir, 'rev-parse', 'HEAD');
}

/**
 * A repository with one commit on `branch`, whose `origin` is the fixture repository the signed-receipt trust
 * policies name. Pass `remote: null` for a repository without one.
 */
export async function makeCommittedRepo({
  branch = fixtureBranch,
  remote = fixtureRepository,
}: { branch?: string; remote?: string | null } = {}) {
  const repoDir = await makeRepo();
  if (remote) {
    await git(repoDir, 'remote', 'add', 'origin', `${remote}.git`);
  }
  await commitFiles(repoDir, 'fixture', { 'README.md': '# ThreadLoop fixture\n' });
  await git(repoDir, 'branch', '-M', branch);
  return repoDir;
}

/** Starts one session through the CLI and returns its ids. */
export async function startSession(repoDir: string, title = 'Fixture task', extraArgs: string[] = []) {
  const args = ['session', 'start', title, '--goal', 'Exercise the ThreadLoop lifecycle', ...extraArgs, '--json'];
  return parseJson<{ data: { session_id: string; task_id: string } }>((await runCli(repoDir, args)).stdout).data;
}

/**
 * Starts a session, commits the ThreadLoop config it created so the checkout is clean, and frames it through the
 * public CLI. A second session in the same repository has no config to commit and needs its own idempotency key.
 */
export async function startFramedSession(
  repoDir: string,
  { commitConfig = true, idempotencyKey = 'frame:fixture' }: { commitConfig?: boolean; idempotencyKey?: string } = {},
) {
  const { session_id: sessionId } = await startSession(repoDir, 'Fixture task', ['--issue', '#40']);
  if (commitConfig) {
    await git(repoDir, 'add', '.threadloop/config.json');
    await git(repoDir, 'commit', '-m', 'initialize ThreadLoop');
  }
  await transition(repoDir, sessionId, 'framed', 0, idempotencyKey);
  return sessionId;
}

/** A contract-v4 proof plan with one `check` gate, bound to the fixture gate and review trust policies. */
export function proofPlan({
  command = ['node', '-e', 'process.stdout.write("ok\\n")'],
  timeoutMs = 5_000,
  workingDirectory = '.',
  setup,
}: {
  command?: string[] | undefined;
  timeoutMs?: number;
  workingDirectory?: string;
  setup?: ProofSetupStep[] | undefined;
} = {}) {
  return {
    contract_version: 4,
    acceptance_criteria: ['All repository checks pass'],
    ci: trustPolicy('gate'),
    review: trustPolicy('review'),
    gates: [
      {
        id: 'check',
        ...(setup ? { setup } : {}),
        command,
        working_directory: workingDirectory,
        timeout_ms: timeoutMs,
      },
    ],
  };
}

type ProofPlan = ReturnType<typeof proofPlan>;

/** Records `plan` on a framed session through the public `proof_ready` transition. */
export async function recordProofPlan(
  repoDir: string,
  sessionId: string,
  plan = proofPlan(),
  idempotencyKey = 'proof-plan:fixture',
) {
  return transition(repoDir, sessionId, 'proof_ready', 1, idempotencyKey, { proof_plan: plan });
}

/**
 * Applies one transition through the store with an allow-all guard evaluator, to reach a lifecycle state without
 * producing the evidence its real guards would demand. Throws if the store still refuses it.
 */
export async function forceTransition(
  repoDir: string,
  sessionId: string,
  targetState: TransitionRequest['targetState'],
  expectedStateVersion: number,
  idempotencyKey = `fixture:${targetState}`,
  input: Record<string, unknown> = {},
) {
  const request: TransitionRequest = { sessionId, targetState, expectedStateVersion, actor: 'agent', input };
  const result = await applySessionTransition(
    repoDir,
    { ...request, idempotencyKey, ...canonicalizeTransitionRequest(request, sha256) },
    () => ({ allowed: true, guardFailures: [], requiredWork: [] }),
  );
  if (!result.ok) {
    throw new Error(`Could not force ${targetState} fixture: ${result.error.code}`);
  }
  return result;
}

/** Forces `targetStates` in order, starting from `fromVersion`. */
export async function forceStates(
  repoDir: string,
  sessionId: string,
  fromVersion: number,
  targetStates: Array<TransitionRequest['targetState']>,
  keyPrefix = 'fixture',
) {
  for (const [offset, targetState] of targetStates.entries()) {
    await forceTransition(repoDir, sessionId, targetState, fromVersion + offset, `${keyPrefix}:${targetState}`);
  }
}

/**
 * A framed session with `plan` recorded, forced into `verifying` at state version 4, in `repoDir` or a fresh
 * committed repository. Returns what signed evidence for it must be bound to.
 */
export async function makeVerifyingSession({
  plan = proofPlan(),
  repoDir,
}: { plan?: ProofPlan; repoDir?: string } = {}) {
  repoDir ??= await makeCommittedRepo();
  const sessionId = await startFramedSession(repoDir);
  const recorded = await recordProofPlan(repoDir, sessionId, plan);
  await forceStates(repoDir, sessionId, 2, ['implementing', 'verifying']);
  return {
    repoDir,
    sessionId,
    planSha256: recorded.data.proof_plan.sha256,
    head: await git(repoDir, 'rev-parse', 'HEAD'),
    gate: plan.gates[0]!,
  };
}
