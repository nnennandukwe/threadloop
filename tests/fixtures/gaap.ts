import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { GaapStatement } from '../../src/domain/gaap-types.js';
import { canonicalGaapJson, parseGaapJson } from '../../src/domain/gaap-json.js';
import { VerifiedGaapEnvelope } from '../../src/adapters/crypto/gaap-dsse.js';

/** Explicit public fixture trust; never a runtime default or a newly claimed native execution. */
export async function gaapFixture(name = 'allow') {
  const root = new URL(`./gaap/goose-${name}/`, import.meta.url);
  const bytes = await readFile(new URL('envelope.json', root));
  const trust = JSON.parse(await readFile(new URL('fixture-trust.json', root), 'utf8')) as Array<{
    key_id: string;
    public_key_base64: string;
  }>;
  const keys = trust.map((key) => ({ keyId: key.key_id, publicKey: Buffer.from(key.public_key_base64, 'base64') }));
  const authenticated = VerifiedGaapEnvelope.verify(bytes, keys);
  const statement = parseGaapJson(authenticated.payload) as GaapStatement;
  const blobs = new Map<string, Buffer>();
  for (const digest of statement.predicate.blob_digests)
    blobs.set(digest, await readFile(new URL('blobs/' + digest.slice(7), root)));
  return {
    bytes,
    keys,
    authenticated,
    statement,
    expected: structuredClone(statement.predicate.request),
    implementation: structuredClone(statement.predicate.implementation),
    blobs,
  };
}

/** Synthetic re-signing for rejection tests with the deliberately public seed from GAAP #15. */
export function signGaapTestStatement(statement: GaapStatement): Buffer {
  return signGaapTestPayload(Buffer.from(canonicalGaapJson(statement)));
}

export function signGaapTestPayload(payload: Buffer): Buffer {
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]),
    format: 'der',
    type: 'pkcs8',
  });
  const type = 'application/vnd.in-toto+json';
  const message = Buffer.concat([Buffer.from(`DSSEv1 28 ${type} ${payload.length} `), payload]);
  return Buffer.from(
    JSON.stringify({
      payloadType: type,
      payload: payload.toString('base64'),
      signatures: [{ keyid: 'gaap-goose-public-fixture-only', sig: sign(null, message, key).toString('base64') }],
    }),
  );
}
