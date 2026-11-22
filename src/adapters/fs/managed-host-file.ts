import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

const readRights = new Set([
  'read',
  'list',
  'search',
  'execute',
  'readattr',
  'readextattr',
  'readsecurity',
  'file_inherit',
  'directory_inherit',
  'limit_inherit',
  'only_inherit',
]);

function hasReadOnlyMacGrants(paths: string[]) {
  // Darwin ACLs can grant access beyond the POSIX mode. Numeric IDs and escaped filenames keep each ACL on its own line.
  const listing = execFileSync('/bin/ls', ['-dlenb', ...paths], {
    env: { LC_ALL: 'C' },
    cwd: '/',
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5000,
    maxBuffer: 256 * 1024,
  });
  return listing.split('\n').every((line) => {
    if (!/^\s*\d+: /.test(line) || line.includes(' deny ')) return true;
    const rights = line.split(' allow ')[1];
    return rights !== undefined && rights.split(',').every((right) => readRights.has(right));
  });
}

export function hasProtectedHostFilePath(filename: string): boolean {
  const uid = process.geteuid?.();
  if (
    uid === undefined ||
    !['linux', 'darwin'].includes(process.platform) ||
    !path.isAbsolute(filename) ||
    realpathSync(filename) !== filename
  )
    return false;
  const paths = [filename];
  for (let parent = path.dirname(filename); ; parent = path.dirname(parent)) {
    paths.push(parent);
    if (parent === path.dirname(parent)) break;
  }
  const installation = path.dirname(filename);
  for (const name of paths.reverse()) {
    const info = lstatSync(name);
    if ((info.uid !== 0 && info.uid !== uid) || (name === filename ? !info.isFile() : !info.isDirectory()))
      return false;
    // A sticky system temp directory protects the trusted owner's child directory entry.
    const protectedTemporaryAncestor =
      name !== filename && name !== installation && info.uid === 0 && (info.mode & 0o1000) !== 0;
    if ((info.mode & 0o022) !== 0 && !protectedTemporaryAncestor) return false;
  }
  return process.platform !== 'darwin' || hasReadOnlyMacGrants(paths);
}
