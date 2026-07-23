import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();

async function writeExecutable(directory: string, name: string, contents: string): Promise<void> {
  const executable = path.join(directory, name);
  await writeFile(executable, contents);
  await chmod(executable, 0o755);
}

async function expectHookFailure(hook: string, expectedCode: number, env: NodeJS.ProcessEnv): Promise<void> {
  let hookFailure: unknown;

  try {
    await execFileAsync('sh', [path.join('.husky', hook)], {
      cwd: repositoryRoot,
      env,
    });
  } catch (error) {
    hookFailure = error;
  }

  expect(hookFailure, `${hook} unexpectedly succeeded`).toMatchObject({ code: expectedCode });
}

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
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'threadloop-pre-commit-'));
    const commandLog = path.join(temporaryDirectory, 'commands.log');

    try {
      await writeExecutable(
        temporaryDirectory,
        'git',
        `#!/usr/bin/env sh
printf '%s\\n' 'git diff --cached --check' >> "$THREADLOOP_HOOK_LOG"
exit 23
`,
      );
      await writeExecutable(
        temporaryDirectory,
        'npx',
        `#!/usr/bin/env sh
printf '%s\\n' 'npx lint-staged --concurrent false' >> "$THREADLOOP_HOOK_LOG"
`,
      );

      await expectHookFailure('pre-commit', 23, {
        ...process.env,
        PATH: `${temporaryDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
        THREADLOOP_HOOK_LOG: commandLog,
      });

      expect(await readFile(commandLog, 'utf8')).toBe('git diff --cached --check\n');
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('stops the pre-push hook when the test suite fails', async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'threadloop-pre-push-'));
    const commandLog = path.join(temporaryDirectory, 'commands.log');

    try {
      await writeExecutable(
        temporaryDirectory,
        'npm',
        `#!/usr/bin/env sh
printf 'npm %s\\n' "$*" >> "$THREADLOOP_HOOK_LOG"
if [ "$1" = 'test' ]; then
  exit 29
fi
`,
      );

      await expectHookFailure('pre-push', 29, {
        ...process.env,
        PATH: `${temporaryDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
        THREADLOOP_HOOK_LOG: commandLog,
      });

      expect(await readFile(commandLog, 'utf8')).toBe('npm test\n');
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
