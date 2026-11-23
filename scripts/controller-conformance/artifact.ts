import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const subjectPath = 'scripts/executor-contract/subject.mjs';
const schemaRoot = 'docs/contracts/executor-v0.1/upstream/gaap';
export const schemaPaths = [
  schemaRoot + '/agent-run-request.schema.json',
  schemaRoot + '/terminal-run-receipt.schema.json',
];

export function measureSubject(runtime: string, version: string, revision: string) {
  const manifest = [...schemaPaths, subjectPath].sort().map((path) => {
    const content = readFileSync(join(runtime, path));
    return { bytes: content.length, path, sha256: createHash('sha256').update(content).digest('hex') };
  });
  // The record keys above are in canonical UTF-16 order.
  const artifact_digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  return { manifest, identity: { name: 'threadloop-controller', version, revision, artifact_digest } };
}
