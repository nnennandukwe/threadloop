import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { corpusDirectory, loadCorpus } from '../../scripts/controller-conformance/files.js';
import { conformanceDigest } from '../../scripts/controller-conformance/codec.js';
import { manifestSchema } from '../../scripts/controller-conformance/contracts.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});
const actual = await vi.importActual<typeof fs>('node:fs/promises');
let directory: string;
let artifact: string;
let replacement: string;
const handles: FileHandle[] = [];

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'threadloop-artifact-race-'));
  await fs.cp(corpusDirectory, directory, { recursive: true });
  artifact = join(directory, 'manifest.json');
  replacement = join(directory, 'replacement.json');
  const manifest = manifestSchema.parse(JSON.parse(await fs.readFile(artifact, 'utf8')));
  manifest.manifest.compatibility_digest = '0'.repeat(64);
  manifest.corpus_digest = conformanceDigest(manifest.manifest);
  await fs.writeFile(replacement, JSON.stringify(manifest));
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await actual.open(...args);
    handles.push(handle);
    return handle;
  });
});

afterEach(async () => {
  vi.mocked(fs.lstat).mockImplementation(actual.lstat);
  vi.mocked(fs.open).mockImplementation(actual.open);
  try {
    for (const handle of handles) expect(handle.fd).toBe(-1);
  } finally {
    for (const handle of handles.splice(0)) await handle.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('does not follow a symlink installed after the path was inspected (d04d03ed)', async () => {
  const original: unknown = JSON.parse(await fs.readFile(artifact, 'utf8'));
  let replaced = false;
  vi.mocked(fs.lstat).mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
    const metadata = await actual.lstat(...args);
    if (args[0] === artifact && !replaced) {
      replaced = true;
      await fs.rename(artifact, artifact + '.original');
      await fs.symlink(replacement, artifact);
    }
    return metadata;
  });
  const loaded = await loadCorpus(directory);
  expect(replaced).toBe(true);
  expect(loaded.manifest).toEqual(original);
});

it.each(['symlink', 'regular'])('rejects a %s replacement of an already opened artifact', async (kind) => {
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await actual.open(...args);
    handles.push(handle);
    if (args[0] === artifact) {
      await fs.rename(artifact, artifact + '.original');
      if (kind === 'symlink') await fs.symlink(replacement, artifact);
      else await fs.copyFile(replacement, artifact);
    }
    return handle;
  });
  await expect(loadCorpus(directory)).rejects.toThrow(/manifest.json.*regular file/);
  expect(handles).toHaveLength(1);
});

it('bounds bytes read when an artifact grows after size inspection', async () => {
  let grew = false;
  vi.mocked(fs.lstat).mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
    const metadata = await actual.lstat(...args);
    if (args[0] === artifact && !grew) {
      grew = true;
      await fs.appendFile(artifact, ' '.repeat(16 * 1024 * 1024));
    }
    return metadata;
  });
  let bytesRead = 0;
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await actual.open(...args);
    handles.push(handle);
    const read = handle.read.bind(handle);
    vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
      const result = await read(...readArgs);
      bytesRead += result.bytesRead;
      return result;
    });
    return handle;
  });
  await expect(loadCorpus(directory)).rejects.toThrow(/manifest.json.*byte limit/);
  expect(grew).toBe(true);
  expect(bytesRead).toBe(16 * 1024 * 1024 + 1);
});

it('closes the descriptor and preserves the cause after a read failure', async () => {
  const failure = new Error('injected artifact read failure');
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await actual.open(...args);
    handles.push(handle);
    vi.spyOn(handle, 'read').mockRejectedValue(failure);
    return handle;
  });
  await expect(loadCorpus(directory)).rejects.toMatchObject({ cause: failure });
  expect(handles).toHaveLength(1);
});

it('refuses a symlink substituted immediately before open', async () => {
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === artifact) {
      await fs.rename(artifact, artifact + '.original');
      await fs.symlink(replacement, artifact);
    }
    const handle = await actual.open(...args);
    handles.push(handle);
    return handle;
  });
  await expect(loadCorpus(directory)).rejects.toThrow(/manifest.json.*regular file/);
});

it('enforces the corpus source budget on consumed bytes after the inventory size check', async () => {
  const shared = join(directory, 'shared.json');
  let inspections = 0;
  vi.mocked(fs.lstat).mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
    const metadata = await actual.lstat(...args);
    if (args[0] === shared && ++inspections === 2) await fs.appendFile(shared, ' '.repeat(2 * 1024 * 1024));
    return metadata;
  });
  await expect(loadCorpus(directory)).rejects.toThrow(/shared.json.*byte limit/);
  expect(inspections).toBe(2);
});
