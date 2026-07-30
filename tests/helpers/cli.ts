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
