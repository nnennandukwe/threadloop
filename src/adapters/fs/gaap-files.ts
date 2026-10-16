import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { gaapContentDigest, gaapObjectDigest } from '../../domain/gaap-content.js';
import { GaapEvidenceError } from '../../domain/gaap-json.js';

/** No symlink traversal, device reads or receipt-directed filenames. */
export function readGaapFile(filename: string, maximum: number): Buffer {
  requireGaapDirectory(path.dirname(path.resolve(filename)));
  const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > maximum)
      throw new GaapEvidenceError('file.limit', 'Evidence requires a bounded regular file.');
    const bytes = Buffer.alloc(maximum + 1);
    let count = 0;
    while (count <= maximum) {
      const received = readSync(descriptor, bytes, count, bytes.length - count, null);
      if (received === 0) break;
      count += received;
    }
    const after = fstatSync(descriptor);
    if (count > maximum || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new GaapEvidenceError('file.changed', 'Evidence changed during its bounded read.');
    return bytes.subarray(0, count);
  } finally {
    closeSync(descriptor);
  }
}

export function requireGaapDirectory(directory: string): string {
  const absolute = path.resolve(directory);
  const actual = realpathSync(absolute);
  if (actual !== absolute || !lstatSync(actual).isDirectory())
    throw new GaapEvidenceError('file.directory', 'Select an existing real directory without symlink components.');
  return actual;
}

export function observeGaapWorkspace(workspace: string) {
  const root = requireGaapDirectory(workspace);
  const manifest: Record<string, unknown> = {};
  const files = new Map<string, { bytes: Buffer; executable: boolean }>();
  let descendants = 0;
  function collect(directory: string, relative: string, depth: number): void {
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || depth > 8)
      throw new GaapEvidenceError(
        'snapshot.directory',
        'Workspace directories must fit the portable snapshot profile.',
      );
    manifest[relative || '.'] = { kind: 'directory', mode: metadata.mode & 0o7777 };
    for (const name of readdirSync(directory).sort()) {
      if (!relative && name === '.git') continue;
      const entry = relative ? relative + '/' + name : name;
      if (++descendants > 64 || Buffer.byteLength(entry) > 1024 || name.includes('\\') || depth >= 8)
        throw new GaapEvidenceError('snapshot.limit', 'Workspace entries exceed the portable snapshot profile.');
      const filename = path.join(directory, name);
      const stat = lstatSync(filename);
      if (stat.isDirectory()) collect(filename, entry, depth + 1);
      else if (stat.isFile() && !stat.isSymbolicLink()) {
        const bytes = readGaapFile(filename, 8192);
        files.set(entry, { bytes, executable: (stat.mode & 0o100) !== 0 });
        manifest[entry] = {
          kind: 'file',
          mode: stat.mode & 0o7777,
          digest: gaapContentDigest(bytes),
        };
      } else
        throw new GaapEvidenceError('snapshot.kind', 'Workspace snapshots support only regular files and directories.');
    }
  }
  collect(root, '', 0);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  // A nested directory mustn't borrow a parent repository's revision.
  if (realpathSync(git('rev-parse', '--show-toplevel')) !== root)
    throw new GaapEvidenceError('snapshot.repository', 'The subject must be the Git repository root.');
  const revision = git('rev-parse', '--verify', 'HEAD');
  if (!/^[a-f0-9]{40,64}$/.test(revision))
    throw new GaapEvidenceError('snapshot.revision', 'The subject requires an existing Git commit.');
  // Read committed objects directly. `git status` can invoke repository-configured clean filters or fsmonitor.
  const tracked = git('ls-tree', '-rz', '--full-tree', 'HEAD').split('\0').filter(Boolean);
  const index = git('ls-files', '--stage', '-z').split('\0').filter(Boolean);
  const staged = new Set(index.map((entry) => entry.replace(/^([0-7]{6}) ([a-f0-9]{40,64}) 0\t/, '$1 blob $2\t')));
  const clean =
    index.length === tracked.length &&
    staged.size === tracked.length &&
    tracked.every((entry) => staged.has(entry)) &&
    tracked.length === files.size &&
    tracked.every((entry) => {
      const match = /^([0-7]{6}) blob ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(entry);
      if (!match) return false;
      const file = files.get(match[3]!);
      if (!file || match[1] !== (file.executable ? '100755' : '100644')) return false;
      const objectId = createHash(revision.length === 40 ? 'sha1' : 'sha256')
        .update(`blob ${file.bytes.length}\0`)
        .update(file.bytes)
        .digest('hex');
      return objectId === match[2];
    });
  return {
    manifest,
    digest: gaapObjectDigest(manifest).slice(7),
    revision,
    branch: git('branch', '--show-current'),
    clean,
  };
}
