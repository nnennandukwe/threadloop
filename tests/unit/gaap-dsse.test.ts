import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { VerifiedGaapEnvelope, type GaapTrustedKey } from '../../src/adapters/crypto/gaap-dsse.js';

const type = 'application/vnd.in-toto+json';
function signed(payload = '{}', payloadType = type) {
  const keys = generateKeyPairSync('ed25519');
  const bytes = Buffer.from(payload);
  const framing = Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${bytes.length} `);
  const envelope = {
    payloadType,
    payload: bytes.toString('base64'),
    signatures: [
      { keyid: 'host', sig: sign(null, Buffer.concat([framing, bytes]), keys.privateKey).toString('base64') },
    ],
  };
  const trust: GaapTrustedKey = {
    keyId: 'host',
    publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
  };
  return { envelope, trust, keys, bytes };
}
function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value));
}

describe('independent GAAP DSSE authentication', () => {
  it('matches GAAP Rust strict verification for fixed scalar, encoding and torsion vectors', async () => {
    // Expected outcomes were checked through GAAP's public Ed25519Verifier, including
    // accepted mixed-order points. The raw message is DSSE PAE for the payload {}.
    const vectors = JSON.parse(
      await readFile(new URL('../fixtures/gaap/ed25519-strict-vectors.json', import.meta.url), 'utf8'),
    ) as Array<{
      name: string;
      public_key_hex: string;
      message_hex: string;
      signature_hex: string;
      expected: boolean;
    }>;
    for (const vector of vectors) {
      expect(Buffer.from(vector.message_hex, 'hex').toString(), vector.name).toBe(
        'DSSEv1 28 application/vnd.in-toto+json 2 {}',
      );
      const envelope = encode({
        payloadType: type,
        payload: Buffer.from('{}').toString('base64'),
        signatures: [{ keyid: 'host', sig: Buffer.from(vector.signature_hex, 'hex').toString('base64') }],
      });
      const trust = [{ keyId: 'host', publicKey: Buffer.from(vector.public_key_hex, 'hex') }];
      if (vector.expected) {
        expect(VerifiedGaapEnvelope.verify(envelope, trust).payload.toString(), vector.name).toBe('{}');
      } else {
        expect(() => VerifiedGaapEnvelope.verify(envelope, trust), vector.name).toThrow('verification failed');
      }
    }
  });

  it('authenticates the published Rust/Goose bytes with an explicitly selected fixture key', async () => {
    const root = new URL('../fixtures/gaap/goose-allow/', import.meta.url);
    const bytes = await readFile(new URL('envelope.json', root));
    const trust = JSON.parse(await readFile(new URL('fixture-trust.json', root), 'utf8')) as Array<{
      key_id: string;
      public_key_base64: string;
    }>;
    const verified = VerifiedGaapEnvelope.verify(
      bytes,
      trust.map((key) => ({ keyId: key.key_id, publicKey: Buffer.from(key.public_key_base64, 'base64') })),
    );
    expect(JSON.parse(verified.payload.toString())).toMatchObject({
      _type: 'https://in-toto.io/Statement/v1',
      predicate: { receipt: { body: { terminal_status: 'completed' } } },
    });
    expect(verified.signerFingerprints).toHaveLength(1);
    const copy = verified.payload;
    copy.fill(0);
    expect(verified.payload[0]).toBe('{'.charCodeAt(0));
  });

  it('uses the published PAE framing and raw payload bytes', () => {
    const value = signed();
    value.envelope.signatures[0]!.sig = sign(
      null,
      Buffer.from('DSSEv1 28 application/vnd.in-toto+json 2 {}'),
      value.keys.privateKey,
    ).toString('base64');
    expect(VerifiedGaapEnvelope.verify(encode(value.envelope), [value.trust]).payload.toString()).toBe('{}');
    value.envelope.payload = Buffer.from('{ }').toString('base64');
    expect(() => VerifiedGaapEnvelope.verify(encode(value.envelope), [value.trust])).toThrow('verification failed');
  });

  it.each([
    'unsigned',
    'untrusted',
    'wrong_type',
    'tampered',
    'duplicate',
    'alias',
    'bad_base64',
    'wrong_size',
  ] as const)('rejects %s evidence', (kind) => {
    const value = signed();
    const trust = [value.trust];
    if (kind === 'unsigned') value.envelope.signatures = [];
    if (kind === 'untrusted') value.envelope.signatures[0]!.keyid = 'other';
    if (kind === 'wrong_type') value.envelope.payloadType = 'unknown';
    if (kind === 'tampered') value.envelope.payload = Buffer.from('[]').toString('base64');
    if (kind === 'duplicate') value.envelope.signatures.push({ ...value.envelope.signatures[0]! });
    if (kind === 'alias') {
      trust.push({ ...value.trust, keyId: 'alias' });
      value.envelope.signatures.push({ ...value.envelope.signatures[0]!, keyid: 'alias' });
    }
    if (kind === 'bad_base64') value.envelope.payload = 'e30';
    if (kind === 'wrong_size') value.envelope.signatures[0]!.sig = Buffer.alloc(63).toString('base64');
    expect(() => VerifiedGaapEnvelope.verify(encode(value.envelope), trust)).toThrow();
  });

  it('requires every presented signature to verify against explicit host trust', () => {
    const first = signed(),
      second = signed();
    second.trust.keyId = 'second';
    second.envelope.signatures[0]!.keyid = 'second';
    first.envelope.signatures.push(second.envelope.signatures[0]!);
    expect(
      VerifiedGaapEnvelope.verify(encode(first.envelope), [first.trust, second.trust]).signerFingerprints,
    ).toHaveLength(2);
    first.envelope.signatures[1]!.sig = Buffer.alloc(64).toString('base64');
    expect(() => VerifiedGaapEnvelope.verify(encode(first.envelope), [first.trust, second.trust])).toThrow(
      'verification failed',
    );
  });

  it('rejects repeated encoded field names before interpreting authentication fields', () => {
    const value = signed();
    const encoded = JSON.stringify(value.envelope).replace('"payloadType":', '"payloadType":"ignored","payloadType":');
    expect(() => VerifiedGaapEnvelope.verify(Buffer.from(encoded), [value.trust])).toThrow('unique object keys');
    const nested = JSON.stringify(value.envelope).replace('"keyid":"host"', '"keyid":"host","keyid":"host"');
    expect(() => VerifiedGaapEnvelope.verify(Buffer.from(nested), [value.trust])).toThrow('unique object keys');
  });

  it.each([0, 1])('rejects a forged identity signature with weak public key %s', (first) => {
    const value = signed();
    const raw = Buffer.alloc(32);
    raw[0] = first;
    const signature = Buffer.alloc(64);
    signature[0] = 1;
    value.envelope.signatures[0]!.sig = signature.toString('base64');
    expect(() => VerifiedGaapEnvelope.verify(encode(value.envelope), [{ keyId: 'host', publicKey: raw }])).toThrow(
      'verification failed',
    );
  });
});
