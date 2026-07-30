import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { THREADLOOP_TEST_CLI_ENV } from './helpers/cli.js';

const execFileAsync = promisify(execFile);

/**
 * Builds the CLI once for the whole suite instead of re-transpiling the
 * `src/cli.ts` import graph on every subprocess invocation. The bundle costs
 * ~45ms to produce and roughly halves the cost of each CLI call.
 */
export default async function setup() {
  const projectRoot = process.cwd();
  const cacheDirectory = path.join(projectRoot, 'node_modules', '.cache');
  await mkdir(cacheDirectory, { recursive: true });
  const bundleDirectory = await realpath(await mkdtemp(path.join(cacheDirectory, 'threadloop-test-cli-')));

  await execFileAsync(
    process.execPath,
    [
      path.join(projectRoot, 'node_modules/tsup/dist/cli-default.js'),
      path.join(projectRoot, 'src/cli.ts'),
      '--format',
      'esm',
      '--clean',
      '--out-dir',
      bundleDirectory,
      '--tsconfig',
      path.join(projectRoot, 'tsconfig.build.json'),
    ],
    { cwd: projectRoot, maxBuffer: 10 * 1024 * 1024 },
  );

  process.env[THREADLOOP_TEST_CLI_ENV] = path.join(bundleDirectory, 'cli.js');

  return async () => {
    delete process.env[THREADLOOP_TEST_CLI_ENV];
    await rm(bundleDirectory, { recursive: true, force: true });
  };
}
