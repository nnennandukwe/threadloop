import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { compatibilitySchema, publishedConformanceSchemas } from './contracts.js';
import { conformanceDigest } from './codec.js';
import { materializeFixtureSources } from './sources.js';
import { sha256 } from '../../src/adapters/crypto/sha256.js';

export const corpusDirectory = fileURLToPath(
  new URL('../../docs/contracts/controller-conformance-v0.1/', import.meta.url),
);

async function readArtifact(path: string): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024)
    throw new Error(`${path}: expected a regular file no larger than 16 MiB.`);
  return readFile(path);
}

async function readJson(path: string): Promise<unknown> {
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(await readArtifact(path));
    const value: unknown = JSON.parse(source);
    const parsed = parseDocument(source, { uniqueKeys: true });
    if (parsed.errors.length) throw new Error('Duplicate or invalid JSON keys.');
    return value;
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** I/O belongs only to development tooling. No subject is loaded or executed. */
export async function loadCorpus(directory = corpusDirectory) {
  if (!(await lstat(directory)).isDirectory()) throw new Error('Corpus directory must be a real directory.');
  const fixtures: Record<string, unknown> = {};
  const fixtureDirectory = join(directory, 'fixtures');
  if (!(await lstat(fixtureDirectory)).isDirectory()) throw new Error('Fixture directory must be a real directory.');
  for (const name of (await readdir(fixtureDirectory)).sort()) {
    if (!/^case_[0-9]{3}\.json$/.test(name)) throw new Error(`Unlisted or invalid fixture filename: ${name}`);
    fixtures[`fixtures/${name}`] = await readJson(join(fixtureDirectory, name));
  }
  return {
    manifest: await readJson(join(directory, 'manifest.json')),
    compatibility: await readJson(join(directory, 'compatibility.json')),
    fixtures: materializeFixtureSources(fixtures, await readJson(join(directory, 'shared.json'))),
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
    const names = (await readdir(directory)).sort();
    if (JSON.stringify(names) !== JSON.stringify(contract.schemas.map((schema) => schema.path).sort()))
      throw new Error(`${contract.name}: schema inventory drift; review compatibility before updating the descriptor.`);
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
  if (JSON.stringify((await readdir(schemaDirectory)).sort()) !== JSON.stringify(expectedNames))
    throw new Error('Published conformance schema inventory differs from its definitions.');
  for (const [name, schema] of Object.entries(generated)) {
    if (conformanceDigest(await readJson(join(schemaDirectory, `${name}.schema.json`))) !== conformanceDigest(schema))
      throw new Error(
        `${name}: schema differs from its definition; run npm run spec:conformance:schemas and review the diff.`,
      );
  }
}
