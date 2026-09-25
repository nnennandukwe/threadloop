import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Path to the CLI bundle built once per suite run by `tests/global-setup.ts`.
 * Published as an environment variable so plain helper functions can read it
 * without threading a vitest test context through every fixture builder.
 */
export const THREADLOOP_TEST_CLI_ENV = 'THREADLOOP_TEST_CLI';

const MAX_BUFFER = 10 * 1024 * 1024;

const projectRoot = process.cwd();
const sourceDirectory = path.join(projectRoot, 'src');

function newestSourceModifiedMs() {
  let newest = 0;

  for (const entry of readdirSync(sourceDirectory, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const modified = statSync(path.join(entry.parentPath, entry.name)).mtimeMs;
    if (modified > newest) {
      newest = modified;
    }
  }

  return newest;
}

/**
 * Resolves the CLI bundle built by `tests/global-setup.ts`, failing closed when
 * it is missing or older than `src/`.
 *
 * Both failure modes are silent if unguarded, and both are worse than a loud
 * error. A missing bundle used to fall back to `tsx`, which still passes but
 * runs the slow path the bundle exists to avoid — the suite just gets several
 * times slower with no explanation. A stale bundle is worse than slow: it is
 * wrong. Measured against vitest 4, `--watch` runs global setup exactly once, so
 * editing `src/` reruns the tests without rebuilding, and they would assert
 * against the previous build.
 *
 * Rebuilding lazily here was the alternative. It keeps `--watch` usable but each
 * worker would need its own output directory to avoid concurrent writes to a
 * bundle another worker is reading, and those directories need cleaning up. Fail
 * closed instead, and say exactly how to recover.
 */
export function resolveTestCliBundle(): string {
  const bundledCli = process.env[THREADLOOP_TEST_CLI_ENV];

  if (!bundledCli) {
    throw new Error(
      `${THREADLOOP_TEST_CLI_ENV} is not set, so there is no CLI bundle to test against. ` +
        'tests/global-setup.ts publishes it; run the suite through `npm test` or `vitest` so global setup executes.',
    );
  }

  const bundleModified = statSync(bundledCli, { throwIfNoEntry: false })?.mtimeMs;
  if (bundleModified === undefined) {
    throw new Error(
      `${THREADLOOP_TEST_CLI_ENV} points at ${bundledCli}, which does not exist. ` +
        'Restart the suite so tests/global-setup.ts rebuilds the CLI bundle.',
    );
  }

  const sourceModified = newestSourceModifiedMs();
  if (sourceModified > bundleModified) {
    throw new Error(
      `The CLI bundle at ${bundledCli} is older than src/, so these tests would assert against a stale build. ` +
        'Global setup builds the bundle once per run and `vitest --watch` does not rebuild it, so restart vitest ' +
        '(or use `npm test`) after changing src/.',
    );
  }

  return bundledCli;
}

let resolvedCliBundle: string | null = null;

function cliArgvPrefix(): string[] {
  // Resolved once per module load, which vitest gives us per test file, so the
  // src/ scan costs one pass per file rather than one per CLI invocation.
  resolvedCliBundle ??= resolveTestCliBundle();

  return [resolvedCliBundle];
}

export async function runCli(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  return execFileAsync(process.execPath, [...cliArgvPrefix(), ...args], {
    cwd,
    maxBuffer: MAX_BUFFER,
    env: env ? { ...process.env, ...env } : process.env,
  });
}

export async function runCliFailure(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  const failure = await runCli(cwd, args, env).then(
    () => null,
    (error: Error & { stdout?: string; stderr?: string }) => error,
  );

  if (!failure) {
    throw new Error(`Expected CLI command to fail: ${args.join(' ')}`);
  }

  return failure;
}

export function parseJson<T>(value: string | undefined) {
  return JSON.parse(value ?? '') as T;
}

/** The `--json` failure envelope every command writes to stderr. */
export interface ErrorEnvelope {
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
    details: Record<string, unknown> & {
      guard_failures?: Array<{ code: string; message: string; owner_issue?: number }>;
    };
  };
}

/** Runs a command that must fail and returns its parsed `--json` error envelope. */
export async function runCliError(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  return parseJson<ErrorEnvelope>((await runCliFailure(cwd, args, env)).stderr);
}

/** The argv for one `session transition --json`; `input` is an object to serialize or raw `--input` text. */
export function transitionArgs(
  sessionId: string,
  targetState: string,
  expectedStateVersion: number | string,
  idempotencyKey: string,
  input: Record<string, unknown> | string = {},
  actor = 'agent',
) {
  return [
    'session',
    'transition',
    targetState,
    '--session',
    sessionId,
    '--expected-state-version',
    String(expectedStateVersion),
    '--idempotency-key',
    idempotencyKey,
    '--actor',
    actor,
    '--input',
    typeof input === 'string' ? input : JSON.stringify(input),
    '--json',
  ];
}

interface TransitionEnvelope {
  ok: true;
  command: string;
  data: {
    session_id: string;
    task_id: string;
    transition: { from_state: string; to_state: string };
    lifecycle: { state: string; state_version: number; blocked_from_state: string | null };
    session: { ended_at: string | null };
    proof_plan: { sha256: string; baseline_branch: string; baseline_head_sha: string };
  };
}

/** Applies one transition through the public CLI and returns its parsed success envelope. */
export async function transition(cwd: string, ...args: Parameters<typeof transitionArgs>) {
  return parseJson<TransitionEnvelope>((await runCli(cwd, transitionArgs(...args))).stdout);
}

/** Attempts one transition that must be refused and returns its parsed error envelope. */
export async function transitionFailure(cwd: string, ...args: Parameters<typeof transitionArgs>) {
  return runCliError(cwd, transitionArgs(...args));
}

/** The `data` of `session next --json`. Pass `T` to read fields beyond a `toMatchObject` comparison. */
export async function sessionNext<T = Record<string, unknown>>(cwd: string, sessionId: string) {
  return parseJson<{ data: T }>((await runCli(cwd, ['session', 'next', '--session', sessionId, '--json'])).stdout).data;
}

interface GateReceipt {
  id: string;
  sequence: number;
  result: string;
  exit_status: number | null;
  head_before: string;
  head_after: string;
  clean_after: boolean;
  artifact: { path: string; sha256: string };
  setup: Array<Record<string, unknown>>;
}

export function gateRunArgs(sessionId: string, gateId = 'check') {
  return ['session', 'gate', 'run', gateId, '--session', sessionId, '--json'];
}

/** Runs one declared gate through `session gate run --json` and returns the receipt it appended. */
export async function runGate(cwd: string, sessionId: string, env?: NodeJS.ProcessEnv) {
  return parseJson<{ data: { receipt: GateReceipt } }>((await runCli(cwd, gateRunArgs(sessionId), env)).stdout).data
    .receipt;
}
