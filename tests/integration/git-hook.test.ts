import { execFile } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupTemporaryState, makeTempDir } from '../helpers/session.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();

async function writeExecutable(directory: string, name: string, contents: string): Promise<void> {
  const executable = path.join(directory, name);
  await writeFile(executable, contents);
  await chmod(executable, 0o755);
}

/** Runs `hook` with `binDirectory` first on PATH and requires it to exit with `expectedCode`. */
async function expectHookFailure(hook: string, expectedCode: number, binDirectory: string, commandLog: string) {
  await expect(
    execFileAsync('sh', [path.join('.husky', hook)], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
        THREADLOOP_HOOK_LOG: commandLog,
      },
    }),
    `${hook} unexpectedly succeeded`,
  ).rejects.toMatchObject({ code: expectedCode });
}

afterEach(cleanupTemporaryState);

describe('Git hook command environment', () => {
  it('removes repository-local Git variables without removing ordinary environment variables', async () => {
    const runner = path.join(process.cwd(), '.husky', 'run-with-clean-git-env');
    const probe = `
      process.stdout.write(JSON.stringify({
        gitDir: process.env.GIT_DIR ?? null,
        gitWorkTree: process.env.GIT_WORK_TREE ?? null,
        gitIndexFile: process.env.GIT_INDEX_FILE ?? null,
        ordinary: process.env.THREADLOOP_HOOK_TEST ?? null,
      }));
    `;

    const { stdout } = await execFileAsync('sh', [runner, process.execPath, '--input-type=module', '--eval', probe], {
      env: {
        ...process.env,
        GIT_DIR: '/tmp/source.git',
        GIT_INDEX_FILE: '/tmp/source.index',
        GIT_WORK_TREE: '/tmp/source-worktree',
        THREADLOOP_HOOK_TEST: 'present',
      },
    });

    expect(JSON.parse(stdout)).toEqual({
      gitDir: null,
      gitWorkTree: null,
      gitIndexFile: null,
      ordinary: 'present',
    });
  });
});

describe('Git hook failure handling', () => {
  it('stops the pre-commit hook when the whitespace check fails', async () => {
    const binDirectory = await makeTempDir('threadloop-pre-commit-');
    const commandLog = path.join(binDirectory, 'commands.log');
    await writeExecutable(
      binDirectory,
      'git',
      `#!/usr/bin/env sh
printf '%s\\n' 'git diff --cached --check' >> "$THREADLOOP_HOOK_LOG"
exit 23
`,
    );
    await writeExecutable(
      binDirectory,
      'npx',
      `#!/usr/bin/env sh
printf '%s\\n' 'npx lint-staged --concurrent false' >> "$THREADLOOP_HOOK_LOG"
`,
    );

    await expectHookFailure('pre-commit', 23, binDirectory, commandLog);
    expect(await readFile(commandLog, 'utf8')).toBe('git diff --cached --check\n');
  });

  it('stops the pre-push hook when the test suite fails', async () => {
    const binDirectory = await makeTempDir('threadloop-pre-push-');
    const commandLog = path.join(binDirectory, 'commands.log');
    await writeExecutable(
      binDirectory,
      'npm',
      `#!/usr/bin/env sh
printf 'npm %s\\n' "$*" >> "$THREADLOOP_HOOK_LOG"
if [ "$1" = 'test' ]; then
  exit 29
fi
`,
    );

    await expectHookFailure('pre-push', 29, binDirectory, commandLog);
    expect(await readFile(commandLog, 'utf8')).toBe('npm test\n');
  });
});
