import { execFile } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { getChangedFiles, hasCommittedDiff } from '../../src/adapters/git/client.js';

const execFileAsync = promisify(execFile);
const temporaryRepos: string[] = [];

async function makeCommittedRepo() {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), 'threadloop-git-client-'));
  temporaryRepos.push(repoDir);
  await execFileAsync('git', ['init'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  await writeFile(path.join(repoDir, 'README.md'), '# fixture\n', 'utf8');
  await execFileAsync('git', ['add', 'README.md'], { cwd: repoDir });
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: repoDir });
  return repoDir;
}

afterEach(async () => {
  await Promise.all(temporaryRepos.splice(0).map((repoDir) => rm(repoDir, { recursive: true, force: true })));
});

describe('hasCommittedDiff', () => {
  it.each([
    ['a non-object sentinel', 'unobserved'],
    ['a well-formed but missing commit SHA', '0'.repeat(40)],
  ])('fails closed for %s', async (_scenario, baselineHead) => {
    const repoDir = await makeCommittedRepo();
    const currentHead = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();

    await expect(hasCommittedDiff(repoDir, baselineHead, currentHead)).resolves.toBe(false);
  });
});

describe('getChangedFiles', () => {
  it('reports exact paths for modified, spaced, and renamed files without a base ref', async () => {
    const repoDir = await makeCommittedRepo();
    await writeFile(path.join(repoDir, 'old name.txt'), 'rename me\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: repoDir });
    await execFileAsync('git', ['commit', '-m', 'add file'], { cwd: repoDir });

    await writeFile(path.join(repoDir, 'README.md'), '# changed\n', 'utf8');
    await rename(path.join(repoDir, 'old name.txt'), path.join(repoDir, 'new name.txt'));
    await execFileAsync('git', ['add', '-A'], { cwd: repoDir });

    await expect(getChangedFiles(repoDir, null)).resolves.toEqual(['README.md', 'new name.txt', 'old name.txt']);
  });
});
