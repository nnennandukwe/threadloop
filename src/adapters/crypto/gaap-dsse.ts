import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import { GaapEvidenceError, parseGaapJson } from '../../domain/gaap-json.js';

const PAYLOAD_TYPE = 'application/vnd.in-toto+json';
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 6 * 1024 * 1024;

export interface GaapTrustedKey {
  keyId: string;
  /** Raw 32-byte Ed25519 public key, supplied by independent host configuration. */
  publicKey: Uint8Array;
}

/** Authenticated raw bytes only; predicate validation and lifecycle admission remain separate. */
export class VerifiedGaapEnvelope {
  private constructor(
    private readonly payloadBytes: Buffer,
    readonly signerFingerprints: readonly string[],
  ) {}

  get payload(): Buffer {
    return Buffer.from(this.payloadBytes);
  }

  static verify(bytes: Uint8Array, trustedKeys: readonly GaapTrustedKey[]): VerifiedGaapEnvelope {
    const envelope = parseGaapJson(bytes, { maxBytes: MAX_ENVELOPE_BYTES });
    if (!object(envelope) || envelope.payloadType !== PAYLOAD_TYPE || typeof envelope.payload !== 'string')
      reject('dsse.envelope', 'Evidence requires the supported DSSE payload type and encoded payload.');
    const signatures = envelope.signatures;
    if (!Array.isArray(signatures) || signatures.length < 1 || signatures.length > 16)
      reject('dsse.signatures', 'Evidence requires between one and sixteen trusted signatures.');
    const payload = base64(envelope.payload, MAX_PAYLOAD_BYTES);
    if (trustedKeys.length < 1 || trustedKeys.length > 64)
      reject('dsse.trust', 'Configure a bounded explicit Ed25519 signer allowlist before verifying evidence.');
    const keys = new Map<string, Buffer>();
    for (const key of trustedKeys) {
      if (!key.keyId || key.keyId.length > 1024 || keys.has(key.keyId) || key.publicKey.byteLength !== 32)
        reject('dsse.trust', 'Trusted key identities must be unique and contain raw 32-byte Ed25519 public keys.');
      keys.set(key.keyId, Buffer.from(key.publicKey));
    }
    const framing = Buffer.from(`DSSEv1 ${Buffer.byteLength(PAYLOAD_TYPE)} ${PAYLOAD_TYPE} ${payload.length} `);
    const message = Buffer.concat([framing, payload]);
    const fingerprints = new Set<string>();
    for (const signature of signatures) {
      if (!object(signature) || typeof signature.keyid !== 'string' || typeof signature.sig !== 'string')
        reject('dsse.signature', 'Every DSSE signature requires a configured key identity and encoded signature.');
      const raw = keys.get(signature.keyid);
      if (!raw) reject('dsse.untrusted', 'The DSSE key identity has no independently configured trust.');
      const fingerprint = createHash('sha256').update(raw).digest('hex');
      if (fingerprints.has(fingerprint))
        reject('dsse.duplicate_key', 'Each signature must use a different trusted key.');
      const encoded = base64(signature.sig, 64);
      if (encoded.length !== 64) reject('dsse.signature', 'An Ed25519 signature must contain exactly 64 bytes.');
      let authenticated = false;
      try {
        authenticated = verifyStrict(encoded, message, raw);
      } catch {
        // Invalid curve encodings are authentication failures, never trusted payloads.
      }
      if (!authenticated) reject('dsse.signature', 'DSSE signature verification failed.');
      fingerprints.add(fingerprint);
    }
    return new VerifiedGaapEnvelope(payload, Object.freeze([...fingerprints]));
  }
}

/** Matches GAAP's ed25519-dalek verify_strict using Noble's point operations. */
function verifyStrict(signature: Buffer, message: Buffer, publicKey: Buffer): boolean {
  const { Point } = ed25519;
  const encodedR = signature.subarray(0, 32);
  const publicPoint = Point.fromBytes(publicKey, true);
  const signaturePoint = Point.fromBytes(encodedR, true);
  const scalar = bytesToNumberLE(signature.subarray(32));
  if (scalar >= Point.Fn.ORDER || publicPoint.isSmallOrder() || signaturePoint.isSmallOrder()) return false;
  const challenge = Point.Fn.create(
    bytesToNumberLE(createHash('sha512').update(encodedR).update(publicKey).update(message).digest()),
  );
  // Dalek checks the uncofactored equation and compares canonical R bytes. Noble's
  // verify() clears the cofactor even with zip215:false, accepting extra signatures.
  const expected = Point.BASE.multiplyUnsafe(scalar).subtract(publicPoint.multiplyUnsafe(challenge));
  return encodedR.equals(Buffer.from(expected.toBytes()));
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function reject(code: string, message: string): never {
  throw new GaapEvidenceError(code, message);
}
function base64(text: string, maximum: number): Buffer {
  if (text.length > 4 * Math.ceil(maximum / 3)) reject('dsse.limit', 'Encoded evidence exceeds its byte limit.');
  const decoded = Buffer.from(text, 'base64');
  if (decoded.length > maximum || decoded.toString('base64') !== text)
    reject('dsse.encoding', 'Evidence requires canonical padded base64.');
  return decoded;
}
