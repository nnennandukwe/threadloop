import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RepoSnapshot } from '../../domain/types.js';
import { filterThreadloopPaths, isThreadloopOwnedPath } from './filter.js';

const execFileAsync = promisify(execFile);

async function git(repoRoot: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd: repoRoot });
  return stdout.trim();
}

export async function resolveRepoRoot(cwd: string) {
  try {
    return await git(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new Error('ThreadLoop requires a Git repository. Run `git init` first.');
  }
}

export async function resolveGitPath(repoRoot: string, relativePath: string) {
  const gitPath = await git(repoRoot, ['rev-parse', '--git-path', relativePath]);
  return path.isAbsolute(gitPath) ? gitPath : path.resolve(repoRoot, gitPath);
}

export async function refExists(repoRoot: string, ref: string) {
  try {
    await git(repoRoot, ['rev-parse', '--verify', ref]);
    return true;
  } catch {
    return false;
  }
}

export async function getBranch(repoRoot: string) {
  return git(repoRoot, ['branch', '--show-current']);
}

export async function getHeadSha(repoRoot: string) {
  try {
    return await git(repoRoot, ['rev-parse', 'HEAD']);
  } catch {
    return 'unborn';
  }
}

export async function getChangedFiles(repoRoot: string, baseRef: string | null) {
  if (baseRef && (await refExists(repoRoot, baseRef))) {
    const output = await git(repoRoot, ['diff', '--name-only', `${baseRef}...HEAD`]);
    return output ? filterThreadloopPaths(output.split('\n').filter(Boolean)) : [];
  }

  const output = await git(repoRoot, ['status', '--short']);
  const files = output
    ? output
        .split('\n')
        .map((line) => line.trim().slice(3))
        .filter(Boolean)
    : [];
  return filterThreadloopPaths(files);
}

export async function getDiffStats(repoRoot: string, baseRef: string | null) {
  const fallback = { files: 0, insertions: 0, deletions: 0 };

  try {
    if (baseRef && (await refExists(repoRoot, baseRef))) {
      const output = await git(repoRoot, ['diff', '--numstat', `${baseRef}...HEAD`]);
      return parseNumstat(output);
    }

    const [unstaged, staged, untracked] = await Promise.all([
      git(repoRoot, ['diff', '--numstat']).catch(() => ''),
      git(repoRoot, ['diff', '--numstat', '--cached']).catch(() => ''),
      git(repoRoot, ['ls-files', '--others', '--exclude-standard']).catch(() => ''),
    ]);

    const totals = [parseNumstat(unstaged), parseNumstat(staged)].reduce(
      (acc, item) => ({
        files: acc.files + item.files,
        insertions: acc.insertions + item.insertions,
        deletions: acc.deletions + item.deletions,
      }),
      fallback,
    );

    const untrackedFiles = filterThreadloopPaths(untracked ? untracked.split('\n').filter(Boolean) : []);
    return { ...totals, files: totals.files + untrackedFiles.length };
  } catch {
    return fallback;
  }
}

export async function getCommitRange(repoRoot: string, baseRef: string | null) {
  try {
    if (baseRef && (await refExists(repoRoot, baseRef))) {
      const output = await git(repoRoot, ['log', '--oneline', `${baseRef}..HEAD`]);
      return output ? output.split('\n').filter(Boolean) : [];
    }
    return [];
  } catch {
    return [];
  }
}

function parseNumstat(output: string) {
  if (!output) {
    return { files: 0, insertions: 0, deletions: 0 };
  }

  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter((parts) => parts.length >= 3 && !isThreadloopOwnedPath(parts[2] ?? ''))
    .reduce(
      (acc, parts) => ({
        files: acc.files + 1,
        insertions: acc.insertions + parseNumstatValue(parts[0] ?? ''),
        deletions: acc.deletions + parseNumstatValue(parts[1] ?? ''),
      }),
      { files: 0, insertions: 0, deletions: 0 },
    );
}

function parseNumstatValue(value: string) {
  return /^\d+$/.test(value) ? Number(value) : 0;
}

export async function snapshotRepo(repoRoot: string, sessionId: string, baseRef: string | null): Promise<RepoSnapshot> {
  const [branch, headSha, changedFiles, diffStats, commitRange] = await Promise.all([
    getBranch(repoRoot),
    getHeadSha(repoRoot),
    getChangedFiles(repoRoot, baseRef),
    getDiffStats(repoRoot, baseRef),
    getCommitRange(repoRoot, baseRef),
  ]);

  return {
    sessionId,
    branch,
    headSha,
    baseRef,
    changedFiles,
    diffStats,
    commitRange,
  };
}
