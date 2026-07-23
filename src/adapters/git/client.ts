import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RepoSnapshot } from '../../domain/types.js';
import { filterThreadloopPaths, isThreadloopOwnedPath } from './filter.js';

const execFileAsync = promisify(execFile);

async function git(repoRoot: string, args: string[]) {
  return (await gitRaw(repoRoot, args)).trim();
}

async function gitRaw(repoRoot: string, args: string[]) {
  const { stdout } = await execFileAsync('git', args, { cwd: repoRoot });
  return stdout;
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

export interface LiveRepositoryObservation {
  identity: {
    source: 'origin' | 'local';
    host: string | null;
    owner: string | null;
    name: string;
  };
  branch: string | null;
  headSha: string | null;
  worktree: {
    clean: boolean;
    changedFiles: string[];
  };
}

export interface ProofRepositoryObservation {
  branch: string | null;
  headSha: string;
  clean: boolean;
  changedFiles: string[];
}

export async function observeProofRepository(repoRoot: string): Promise<ProofRepositoryObservation> {
  const [rawBranch, headSha, rawStatus] = await Promise.all([
    git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
    git(repoRoot, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']),
    gitRaw(repoRoot, [
      '--no-optional-locks',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ]),
  ]);
  const changedFiles = parsePorcelainPaths(rawStatus);
  return {
    branch: rawBranch || null,
    headSha,
    clean: changedFiles.length === 0,
    changedFiles,
  };
}

export async function hasCommittedDiff(repoRoot: string, baselineHead: string, currentHead: string) {
  if (baselineHead === currentHead) {
    return false;
  }
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', baselineHead, currentHead], { cwd: repoRoot });
  } catch (error) {
    if (isExitCode(error, 1) || isExitCode(error, 128)) {
      return false;
    }
    throw error;
  }
  try {
    await execFileAsync('git', ['diff', '--quiet', baselineHead, currentHead, '--'], { cwd: repoRoot });
    return false;
  } catch (error) {
    if (isExitCode(error, 1)) {
      return true;
    }
    if (isExitCode(error, 128)) {
      return false;
    }
    throw error;
  }
}

export async function observeRepository(repoRoot: string): Promise<LiveRepositoryObservation> {
  const [rawOrigin, rawBranch, rawHead, rawStatus] = await Promise.all([
    git(repoRoot, ['config', '--get', 'remote.origin.url']).catch(() => ''),
    git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
    git(repoRoot, ['rev-parse', '--verify', 'HEAD']).catch(() => ''),
    gitRaw(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ]);
  const headSha = rawHead || null;
  const changedFiles = parsePorcelainPaths(rawStatus);

  return {
    identity: parseRepositoryIdentity(rawOrigin, repoRoot),
    branch: headSha && rawBranch ? rawBranch : null,
    headSha,
    worktree: {
      clean: changedFiles.length === 0,
      changedFiles,
    },
  };
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

function parseRepositoryIdentity(origin: string, repoRoot: string): LiveRepositoryObservation['identity'] {
  const fallback = {
    source: 'local' as const,
    host: null,
    owner: null,
    name: path.basename(repoRoot),
  };
  if (!origin) {
    return fallback;
  }

  const scp = parseScpOrigin(origin);
  if (scp) {
    return identityFromParts(scp.host, scp.repositoryPath) ?? fallback;
  }

  try {
    const parsed = new URL(origin);
    if (!parsed.hostname || !['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol)) {
      return fallback;
    }
    return identityFromParts(parsed.hostname, parsed.pathname) ?? fallback;
  } catch {
    return fallback;
  }
}

function parseScpOrigin(origin: string) {
  if (origin.includes('://')) {
    return null;
  }
  const separator = origin.indexOf(':');
  if (separator <= 0) {
    return null;
  }
  const authority = origin.slice(0, separator);
  const host = authority.slice(authority.lastIndexOf('@') + 1);
  const suffix = origin.slice(separator + 1);
  const queryIndex = suffix.search(/[?#]/);
  const repositoryPath = queryIndex >= 0 ? suffix.slice(0, queryIndex) : suffix;
  if (!host || !repositoryPath || host.includes('/') || /\s/.test(host)) {
    return null;
  }
  return { host, repositoryPath };
}

function identityFromParts(host: string, repositoryPath: string): LiveRepositoryObservation['identity'] | null {
  const parts = repositoryPath
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
  const rawName = parts.pop();
  if (!rawName || parts.length === 0) {
    return null;
  }
  const name = rawName.endsWith('.git') ? rawName.slice(0, -4) : rawName;
  if (!name) {
    return null;
  }

  return {
    source: 'origin',
    host: host.toLowerCase(),
    owner: parts.join('/'),
    name,
  };
}

function parsePorcelainPaths(output: string) {
  const records = output.split('\0');
  const paths: string[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) {
      continue;
    }
    const status = record.slice(0, 2);
    const changedPath = record.slice(3);
    if (changedPath) {
      paths.push(changedPath);
    }
    if (/[RC]/.test(status)) {
      const originalPath = records[index + 1];
      if (originalPath) {
        paths.push(originalPath);
      }
      index += 1;
    }
  }

  return Array.from(new Set(paths)).sort();
}

function isExitCode(error: unknown, code: number) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
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
