import { verify as sigstoreVerify, type Bundle, type VerifyOptions } from 'sigstore';
import type { CiTrustPolicy } from '../../domain/proof.js';
import type { SignedReceiptEnvelope } from '../../domain/attestation.js';

export interface VerifiedSigstoreSigner {
  issuer: string;
  certificateIdentity: string;
  buildSignerUri: string;
  buildSignerSha: string;
  sourceRepository: string;
  sourceHeadSha: string;
  sourceRef: string;
  runnerEnvironment: 'github-hosted';
  runInvocationUri: string;
}

export type SigstoreVerifyFunction = (
  bundle: Bundle,
  options: VerifyOptions,
) => Promise<{
  identity?:
    | {
        subjectAlternativeName?: string | undefined;
        extensions?: { issuer?: string | undefined } | undefined;
        oids?:
          | Array<{
              oid?: { id?: number[] | undefined } | undefined;
              value?: Uint8Array | undefined;
            }>
          | undefined;
      }
    | undefined;
}>;

export class SigstoreReceiptVerificationError extends Error {
  readonly reason: 'transparency_missing' | 'identity_mismatch' | 'signature_invalid' | 'verification_unavailable';

  constructor(reason: SigstoreReceiptVerificationError['reason'], message: string, options?: { cause?: unknown }) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'SigstoreReceiptVerificationError';
    this.reason = reason;
  }
}

export async function verifySigstoreReceipt(
  receipt: SignedReceiptEnvelope,
  policy: CiTrustPolicy,
  verify: SigstoreVerifyFunction = sigstoreVerify,
): Promise<VerifiedSigstoreSigner> {
  if (!hasTransparencyInclusionProof(receipt.bundle)) {
    throw new SigstoreReceiptVerificationError(
      'transparency_missing',
      'The Sigstore bundle does not contain a Rekor inclusion proof.',
    );
  }

  const expectedOids = {
    '1.3.6.1.4.1.57264.1.9': policy.build_signer_uri,
    '1.3.6.1.4.1.57264.1.10': policy.build_signer_sha,
    '1.3.6.1.4.1.57264.1.11': 'github-hosted',
    '1.3.6.1.4.1.57264.1.12': policy.source_repository,
    '1.3.6.1.4.1.57264.1.13': receipt.artifact.source.head_sha,
    '1.3.6.1.4.1.57264.1.14': receipt.artifact.source.ref,
    '1.3.6.1.4.1.57264.1.21': receipt.artifact.source.run_invocation_uri,
  };
  let signer: Awaited<ReturnType<SigstoreVerifyFunction>>;
  try {
    signer = await verify(receipt.bundle as Bundle, {
      ctLogThreshold: 1,
      tlogThreshold: 1,
      certificateIssuer: policy.issuer,
      certificateIdentityURI: `^${escapeRegExp(policy.certificate_identity)}$`,
      certificateOIDs: expectedOids,
    });
  } catch (error) {
    throw classifySigstoreError(error);
  }

  const identity = signer.identity;
  const actualOids = new Map(
    (identity?.oids ?? []).flatMap((entry) => {
      const id = entry.oid?.id;
      const value = entry.value;
      return id && value ? [[id.join('.'), Buffer.from(value).toString('utf8')] as const] : [];
    }),
  );
  const identityMatches =
    identity?.subjectAlternativeName === policy.certificate_identity &&
    identity.extensions?.issuer === policy.issuer &&
    Object.entries(expectedOids).every(([oid, value]) => actualOids.get(oid) === value);
  if (!identityMatches) {
    throw new SigstoreReceiptVerificationError(
      'identity_mismatch',
      'The verified signing certificate does not match the immutable CI trust policy.',
    );
  }

  return {
    issuer: policy.issuer,
    certificateIdentity: policy.certificate_identity,
    buildSignerUri: policy.build_signer_uri,
    buildSignerSha: policy.build_signer_sha,
    sourceRepository: policy.source_repository,
    sourceHeadSha: receipt.artifact.source.head_sha,
    sourceRef: receipt.artifact.source.ref,
    runnerEnvironment: 'github-hosted',
    runInvocationUri: receipt.artifact.source.run_invocation_uri,
  };
}

function hasTransparencyInclusionProof(bundle: Record<string, unknown>) {
  const verificationMaterial = toObject(bundle.verificationMaterial);
  const entries = verificationMaterial?.tlogEntries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return false;
  }
  return entries.some((entry) => {
    const inclusionProof = toObject(toObject(entry)?.inclusionProof);
    const checkpoint = toObject(inclusionProof?.checkpoint);
    return (
      typeof inclusionProof?.logIndex === 'string' &&
      typeof inclusionProof.rootHash === 'string' &&
      typeof inclusionProof.treeSize === 'string' &&
      Array.isArray(inclusionProof.hashes) &&
      typeof checkpoint?.envelope === 'string' &&
      checkpoint.envelope.length > 0
    );
  });
}

function classifySigstoreError(error: unknown) {
  const name = error instanceof Error ? error.name : '';
  if (name === 'PolicyError') {
    return new SigstoreReceiptVerificationError(
      'identity_mismatch',
      'The Sigstore certificate identity does not match the immutable CI trust policy.',
      { cause: error },
    );
  }
  if (['TUFError', 'FetchError', 'RequestError', 'AbortError', 'InternalError'].includes(name)) {
    return new SigstoreReceiptVerificationError(
      'verification_unavailable',
      'Sigstore trust material could not be loaded. Retry when trusted verification is available.',
      { cause: error },
    );
  }
  return new SigstoreReceiptVerificationError(
    'signature_invalid',
    'The Sigstore signature or verification material is invalid.',
    { cause: error },
  );
}

function toObject(value: unknown) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
