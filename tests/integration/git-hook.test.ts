import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

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
