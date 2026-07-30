import { execFile } from 'node:child_process';
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
const tsxCli = path.join(projectRoot, 'node_modules/tsx/dist/cli.mjs');
const cliSource = path.join(projectRoot, 'src/cli.ts');

/**
 * Resolves the argv prefix used to invoke the CLI under test.
 *
 * `vitest run` always gets a fresh bundle from global setup. `vitest --watch`
 * does not rebuild when `src/` changes, so the bundle can go stale underneath a
 * watcher.
 *
 * TODO(nnenna): choose the stale/missing-bundle policy.
 *   - throw          — loud, but every `vitest --watch` run needs a manual build
 *   - rebuild lazily — compare bundle mtime against `src/**`, rebuild on drift
 *                      (correct, costs a stat per invocation)
 *   - fall back      — current behaviour below: silently use `tsx`, which never
 *                      breaks but hides that you are measuring the slow path
 */
function cliArgvPrefix(): string[] {
  const bundledCli = process.env[THREADLOOP_TEST_CLI_ENV];
  if (bundledCli) {
    return [bundledCli];
  }

  return [tsxCli, cliSource];
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
