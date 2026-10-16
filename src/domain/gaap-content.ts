import { createHash } from 'node:crypto';
import { canonicalGaapJson, GaapEvidenceError, parseGaapJson } from './gaap-json.js';
import type { GaapStatement, GaapEvidenceReference } from './gaap-types.js';

export interface GaapBlobReader {
  read(digest: string, maxBytes: number): Promise<Uint8Array>;
}
export function gaapContentDigest(bytes: Uint8Array | string): string {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}
export function gaapObjectDigest(value: unknown): string {
  return gaapContentDigest(canonicalGaapJson(value));
}
function reject(code: string, message: string): never {
  throw new GaapEvidenceError(code, message);
}

/** Retains checked bytes; no receipt locator is ever passed to the content reader. */
export async function verifyGaapContent(statement: GaapStatement, reader: GaapBlobReader) {
  const predicate = statement.predicate;
  const blobs = new Map<string, Buffer>();
  let total = 0;
  for (const digest of predicate.blob_digests) {
    if (blobs.has(digest)) reject('evidence.duplicate_blob', 'Content digests must be unique.');
    const bytes = Buffer.from(await reader.read(digest, 1024 * 1024));
    total += bytes.length;
    if (bytes.length > 1024 * 1024 || total > 16 * 1024 * 1024)
      reject('evidence.limit', 'Evidence exceeds its per-blob or aggregate byte limit.');
    if (gaapContentDigest(bytes) !== digest)
      reject('evidence.digest', 'Retained evidence bytes differ from their signed digest.');
    blobs.set(digest, bytes);
  }
  const snapshots = new Set(predicate.snapshot_digests);
  if (snapshots.size !== predicate.snapshot_digests.length)
    reject('evidence.duplicate_snapshot', 'Snapshot digests must be unique.');
  const required = new Set([
    predicate.request.subject.digest,
    predicate.observed_subject.digest,
    predicate.receipt.body.resulting_subject_digest,
  ]);
  for (const effect of predicate.effects) {
    for (const digest of [
      effect.request.input_digest,
      effect.request.tool_schema_digest,
      effect.result.body.observed_tool_schema_digest,
    ])
      if (digest !== null && !blobs.has(digest))
        reject('evidence.missing_input', 'Retain every signed effect input and requested/observed tool schema.');
    required.add(effect.request.subject.digest);
    required.add(effect.result.body.observed_pre_effect_subject.digest);
    if (effect.result.body.observed_post_effect_subject)
      required.add(effect.result.body.observed_post_effect_subject.digest);
  }
  for (const digest of required)
    if (!snapshots.has(digest))
      reject('evidence.missing_snapshot', 'Retain every initial, ledger and physically observed snapshot.');
  for (const digest of snapshots) {
    const bytes = blobs.get(digest);
    if (!bytes) reject('evidence.missing_snapshot', 'A signed snapshot has no retained manifest.');
    const manifest = parseGaapJson(bytes, { maxBytes: 1024 * 1024, integerLiterals: true });
    if (gaapObjectDigest(manifest) !== digest)
      reject('evidence.snapshot_digest', 'Snapshot identities require the canonical manifest bytes.');
    verifySnapshotManifest(manifest, blobs);
  }
  const unresolved = new Set<string>();
  const checkReferences = (references: readonly GaapEvidenceReference[], mandatory = false) => {
    for (const reference of references)
      if (!blobs.has(reference.digest)) {
        if (mandatory) reject('evidence.missing_verification', 'Retain every independent-verification evidence blob.');
        if (!predicate.effects.some((effect) => effect.result.result_digest === reference.digest))
          unresolved.add(reference.digest);
      }
  };
  checkReferences(
    predicate.request.approval_context.map((approval) => ({
      ...approval.evidence,
      locator: approval.evidence.locator ?? null,
    })),
  );
  for (const event of predicate.receipt.body.events) {
    if (event.event_type === 'verification')
      checkReferences(
        event.evidence.map((entry) => ({ ...entry, locator: entry.locator ?? null })),
        true,
      );
    else if (event.event_type === 'approval_recorded')
      checkReferences([{ ...event.approval.evidence, locator: event.approval.evidence.locator ?? null }]);
    else if (event.event_type === 'tool_execution' || event.event_type === 'mutation')
      checkReferences(event.evidence.map((entry) => ({ ...entry, locator: entry.locator ?? null })));
    else if (event.event_type === 'interruption')
      checkReferences([{ ...event.evidence, locator: event.evidence.locator ?? null }]);
  }
  for (const effect of predicate.effects) {
    checkReferences(
      effect.request.approval_context.map((approval) => ({
        ...approval.evidence,
        locator: approval.evidence.locator ?? null,
      })),
    );
    for (const reference of effect.result.body.evidence)
      if (!blobs.has(reference.digest)) unresolved.add(reference.digest);
  }
  return { blobs, unresolvedReferences: [...unresolved].sort() };
}

function verifySnapshotManifest(value: unknown, blobs: ReadonlyMap<string, Buffer>): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    reject('snapshot.invalid', 'A snapshot must contain a portable manifest.');
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 65)
    reject('snapshot.limit', 'A snapshot permits its root and at most 64 descendants.');
  const kinds = new Map<string, string>();
  for (const [name, entry] of entries) {
    if (
      name !== '.' &&
      (!name ||
        Buffer.byteLength(name) > 1024 ||
        name.startsWith('/') ||
        name === '.git' ||
        name.startsWith('.git/') ||
        name.includes('\\') ||
        name.includes('\0') ||
        name.split('/').length > 8 ||
        name.split('/').some((part) => !part || part === '.' || part === '..'))
    )
      reject('snapshot.path', 'Snapshot paths must stay inside the portable subject.');
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
      reject('snapshot.entry', 'Snapshot entries require exact file or directory metadata.');
    const fields = entry as Record<string, unknown>;
    const expected = fields.kind === 'directory' ? ['kind', 'mode'] : ['digest', 'kind', 'mode'];
    if (
      Object.keys(fields).sort().join(',') !== expected.sort().join(',') ||
      !['file', 'directory'].includes(String(fields.kind)) ||
      !Number.isSafeInteger(fields.mode) ||
      Number(fields.mode) < 0 ||
      Number(fields.mode) > 0o7777
    )
      reject('snapshot.entry', 'Snapshot entries require supported kinds and permission bits.');
    kinds.set(name, String(fields.kind));
    if (fields.kind === 'file') {
      if (typeof fields.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(fields.digest))
        reject('snapshot.digest', 'Snapshot files require a SHA-256 content identity.');
      const bytes = blobs.get(fields.digest);
      if (!bytes || bytes.length > 8192)
        reject('snapshot.file', 'Retain every snapshot file within the 8192-byte profile limit.');
    }
  }
  if (kinds.get('.') !== 'directory') reject('snapshot.root', 'A portable snapshot requires its directory root.');
  for (const name of kinds.keys())
    if (name !== '.') {
      const parent = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '.';
      if (kinds.get(parent) !== 'directory')
        reject('snapshot.parent', 'Every snapshot entry requires a retained directory parent.');
    }
}
