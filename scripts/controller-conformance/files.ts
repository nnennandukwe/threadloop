import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { compatibilitySchema, manifestSchema, publishedConformanceSchemas } from './contracts.js';
import { conformanceDigest } from './codec.js';
import { materializeFixtureSources } from './sources.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';

export const corpusDirectory = fileURLToPath(
  new URL('../../docs/contracts/controller-conformance-v0.1/', import.meta.url),
);

async function readArtifact(path: string, maxBytes = 16 * 1024 * 1024): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch(
    (error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ELOOP')
        throw new Error(`${path}: expected a regular file, not a symlink.`, { cause: error });
      throw error;
    },
  );
  let content: Buffer;
  try {
    const opened = await handle.stat();
    const named = await lstat(path);
    if (!opened.isFile() || !named.isFile() || opened.dev !== named.dev || opened.ino !== named.ino)
      throw new Error(`${path}: expected the same regular file that was opened.`);
    if (opened.size > maxBytes) throw new Error(`${path}: byte limit exceeded (${maxBytes} bytes).`);
    const chunks: Buffer[] = [];
    let size = 0;
    // Read at most the budget plus one byte, even if the file grows after stat.
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) {
        content = Buffer.concat(chunks, size);
        break;
      }
      size += bytesRead;
      if (size > maxBytes) throw new Error(`${path}: byte limit exceeded (${maxBytes} bytes).`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } catch (error) {
    const closeFailure = await handle.close().then(
      () => undefined,
      (closeError: unknown) => ({ error: closeError }),
    );
    if (closeFailure)
      throw new AggregateError(
        [error, closeFailure.error],
        `${path}: ${error instanceof Error ? error.message : String(error)}; descriptor close also failed.`,
        { cause: error },
      );
    throw error;
  }
  await handle.close();
  return content;
}

async function readJson(path: string, sourceBudget?: { remaining: number }): Promise<unknown> {
  try {
    const bytes = await readArtifact(path, sourceBudget?.remaining);
    if (sourceBudget) sourceBudget.remaining -= bytes.length;
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const value: unknown = JSON.parse(source);
    const parsed = parseDocument(source, { uniqueKeys: true });
    if (parsed.errors.length) throw new Error('Duplicate or invalid JSON keys.');
    return value;
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Enumerate only up to the expected inventory, rejecting extras without reading their contents. */
async function verifyInventory(directory: string, expected: string[]): Promise<void> {
  const remaining = new Set(expected);
  if (remaining.size !== expected.length) throw new Error(`${directory}: duplicate inventory entries.`);
  for await (const entry of await opendir(directory)) {
    if (!remaining.delete(entry.name)) throw new Error(`${directory}: Unlisted artifact: ${entry.name}`);
  }
  if (remaining.size) throw new Error(`${directory}: missing artifacts: ${[...remaining].join(', ')}`);
}

/** I/O belongs only to development tooling. No subject is loaded or executed. */
export async function loadCorpus(directory = corpusDirectory) {
  if (!(await lstat(directory)).isDirectory()) throw new Error('Corpus directory must be a real directory.');
  const manifest = manifestSchema.parse(await readJson(join(directory, 'manifest.json')));
  if (manifest.corpus_digest !== conformanceDigest(manifest.manifest)) throw new Error('Manifest digest mismatch.');
  const fixtureDirectory = join(directory, 'fixtures');
  if (!(await lstat(fixtureDirectory)).isDirectory()) throw new Error('Fixture directory must be a real directory.');
  const entries = manifest.manifest.entries;
  if (entries.some((entry) => entry.path !== `fixtures/${entry.id}.json`))
    throw new Error('Manifest path/id mismatch.');
  await verifyInventory(
    fixtureDirectory,
    entries.map((entry) => `${entry.id}.json`),
  );
  // Check the aggregate stored source size before parsing or retaining any fixture data.
  const paths = ['shared.json', ...entries.map((entry) => entry.path)];
  let sourceBytes = 0;
  for (const path of paths) {
    const metadata = await lstat(join(directory, path));
    if (!metadata.isFile()) throw new Error(`${path}: expected a regular file.`);
    sourceBytes += metadata.size;
    if (sourceBytes > 2 * 1024 * 1024) throw new Error('Corpus source-byte limit exceeded (2 MiB).');
  }
  const sourceBudget = { remaining: 2 * 1024 * 1024 };
  const shared = await readJson(join(directory, 'shared.json'), sourceBudget);
  const sources: Record<string, unknown> = {};
  for (const entry of entries) sources[entry.path] = await readJson(join(directory, entry.path), sourceBudget);
  return {
    manifest,
    compatibility: await readJson(join(directory, 'compatibility.json')),
    fixtures: materializeFixtureSources(sources, shared),
  };
}

export async function verifyCompatibility(
  value: unknown,
  contractsDirectory = fileURLToPath(new URL('../../docs/contracts/', import.meta.url)),
): Promise<void> {
  const compatibility = compatibilitySchema.parse(value);
  for (const contract of compatibility.contracts) {
    const directory = join(contractsDirectory, `${contract.name}-v0.1`, 'schemas');
    if (
      !(await lstat(join(contractsDirectory, `${contract.name}-v0.1`))).isDirectory() ||
      !(await lstat(directory)).isDirectory()
    )
      throw new Error(`${contract.name}: expected real contract and schema directories.`);
    await verifyInventory(
      directory,
      contract.schemas.map((schema) => schema.path),
    );
    for (const schema of contract.schemas) {
      if (sha256(await readArtifact(join(directory, schema.path))) !== schema.sha256)
        throw new Error(`${contract.name}/${schema.path}: pinned schema bytes changed.`);
    }
  }
}

/** Generated files are part of the checked contract, not incidental build output. */
export async function verifyPublishedSchemas(directory = corpusDirectory): Promise<void> {
  const generated = publishedConformanceSchemas();
  const schemaDirectory = join(directory, 'schemas');
  if (!(await lstat(directory)).isDirectory() || !(await lstat(schemaDirectory)).isDirectory())
    throw new Error('Expected real corpus and schema directories.');
  const expectedNames = Object.keys(generated)
    .map((name) => `${name}.schema.json`)
    .sort();
  await verifyInventory(schemaDirectory, expectedNames);
  for (const [name, schema] of Object.entries(generated)) {
    if (conformanceDigest(await readJson(join(schemaDirectory, `${name}.schema.json`))) !== conformanceDigest(schema))
      throw new Error(
        `${name}: schema differs from its definition; run npm run spec:conformance:schemas and review the diff.`,
      );
  }
}
