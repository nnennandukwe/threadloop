import { execFileSync } from 'node:child_process';
import { lstatSync, readSync, realpathSync } from 'node:fs';
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

export function hasProtectedHostFilePath(filename: string, kind: 'file' | 'directory' = 'file'): boolean {
  const uid = process.geteuid?.();
  if (
    uid === undefined ||
    !['linux', 'darwin'].includes(process.platform) ||
    !path.isAbsolute(filename) ||
    !lstatSync(filename, { throwIfNoEntry: false }) ||
    realpathSync(filename) !== filename
  )
    return false;
  const paths = [filename];
  for (let parent = path.dirname(filename); ; parent = path.dirname(parent)) {
    paths.push(parent);
    if (parent === path.dirname(parent)) break;
  }
  const installation = kind === 'directory' ? filename : path.dirname(filename);
  for (const name of paths.reverse()) {
    const info = lstatSync(name);
    if (
      (info.uid !== 0 && info.uid !== uid) ||
      (name === filename && kind === 'file' ? !info.isFile() : !info.isDirectory())
    )
      return false;
    // A sticky system temp directory protects the trusted owner's child directory entry.
    const protectedTemporaryAncestor =
      name !== filename && name !== installation && info.uid === 0 && (info.mode & 0o1000) !== 0;
    if ((info.mode & 0o022) !== 0 && !protectedTemporaryAncestor) return false;
  }
  return process.platform !== 'darwin' || hasReadOnlyMacGrants(paths);
}

// ELF e_machine values for the architectures supported by Node.
const elfMachine: Record<NodeJS.Architecture, number> = {
  arm: 40,
  arm64: 183,
  ia32: 3,
  loong64: 258,
  mips: 8,
  mipsel: 8,
  ppc64: 21,
  riscv64: 243,
  s390x: 22,
  x64: 62,
};

/** Read the entry image header from the same descriptor as its content digest. */
export function isNativeHostProgram(fd: number, size: number): boolean {
  const header = Buffer.alloc(32);
  if (readSync(fd, header, 0, header.length, 0) !== header.length) return false;
  if (process.platform === 'linux') {
    if (
      header.readUInt32BE(0) !== 0x7f454c46 ||
      ![1, 2].includes(header[4]!) ||
      ![1, 2].includes(header[5]!) ||
      header[6] !== 1
    )
      return false;
    const word = (offset: number) => (header[5] === 1 ? header.readUInt16LE(offset) : header.readUInt16BE(offset));
    const executableType = word(16);
    const entry = header.subarray(24, header[4] === 1 ? 28 : 32);
    // ET_EXEC and position-independent ET_DYN executables both specify an entry point.
    return (
      size >= (header[4] === 1 ? 52 : 64) &&
      word(18) === elfMachine[process.arch] &&
      (executableType === 2 || executableType === 3) &&
      entry.some((byte) => byte !== 0)
    );
  }
  if (process.platform !== 'darwin') return false;
  const cpu = process.arch === 'arm64' ? 0x0100000c : process.arch === 'x64' ? 0x01000007 : 0;
  if (!cpu) return false;
  function executableSlice(bytes: Buffer) {
    return bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === cpu && bytes.readUInt32LE(12) === 2;
  }
  if (executableSlice(header)) return true;
  // Universal Mach-O files use a big-endian architecture table followed by their individual images.
  const magic = header.readUInt32BE(0);
  if (magic !== 0xcafebabe && magic !== 0xcafebabf) return false;
  const count = header.readUInt32BE(4),
    stride = magic === 0xcafebabe ? 20 : 32;
  if (count === 0 || count > 64 || 8 + count * stride > size) return false;
  const record = Buffer.alloc(stride);
  for (let index = 0; index < count; index++) {
    if (readSync(fd, record, 0, stride, 8 + index * stride) !== stride) return false;
    if (record.readUInt32BE(0) !== cpu) continue;
    const offset = stride === 20 ? record.readUInt32BE(8) : Number(record.readBigUInt64BE(8));
    const length = stride === 20 ? record.readUInt32BE(12) : Number(record.readBigUInt64BE(16));
    if (
      length >= header.length &&
      offset >= 8 + count * stride &&
      offset + length <= size &&
      readSync(fd, header, 0, header.length, offset) === header.length &&
      executableSlice(header)
    )
      return true;
  }
  return false;
}
