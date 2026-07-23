import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import {
  SigstoreReceiptVerificationError,
  verifySigstoreReceipt,
  type SigstoreVerifyFunction,
} from '../../src/adapters/crypto/sigstore.js';
import {
  buildInTotoReceiptStatement,
  canonicalizeSignedGateReceiptArtifact,
  IN_TOTO_PAYLOAD_TYPE,
  parseSignedReceiptPackage,
  SIGNED_RECEIPT_MEDIA_TYPE,
  type SignedGateReceiptArtifact,
} from '../../src/domain/attestation.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import type { CiTrustPolicy } from '../../src/domain/proof.js';

const sourceHead = 'a'.repeat(40);
const buildSignerSha = 'b'.repeat(40);
const sourceRepository = 'https://github.com/example/project';
const sourceRef = 'refs/heads/issue-41/signed-ci-receipts';
const certificateIdentity = `${sourceRepository}/.github/workflows/threadloop.yml@${sourceRef}`;
const buildSignerUri = `https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-gate-sensor.yml@${buildSignerSha}`;
const runInvocationUri = `${sourceRepository}/actions/runs/123/attempts/1`;

const policy: CiTrustPolicy = {
  provider: 'github-actions',
  issuer: 'https://token.actions.githubusercontent.com',
  certificate_identity: certificateIdentity,
  source_repository: sourceRepository,
  build_signer_uri: buildSignerUri,
  build_signer_sha: buildSignerSha,
};

function artifact(): SignedGateReceiptArtifact {
  return {
    schema_version: 1,
    receipt_id: 'receipt_123',
    session_id: 'session_123',
    plan_sha256: 'c'.repeat(64),
    gate: { id: 'check', command: ['npm', 'test'], working_directory: '.', timeout_ms: 5_000 },
    result: 'passed',
    started_at: '2026-07-23T18:00:00.000Z',
    ended_at: '2026-07-23T18:00:01.000Z',
    duration_ms: 1_000,
    exit_status: 0,
    signal: null,
    head_before: sourceHead,
    head_after: sourceHead,
    clean_before: true,
    clean_after: true,
    output: { stdout_sha256: 'd'.repeat(64), stderr_sha256: 'e'.repeat(64) },
    source: {
      repository: sourceRepository,
      ref: sourceRef,
      head_sha: sourceHead,
      run_invocation_uri: runInvocationUri,
    },
    environment: {
      runner_environment: 'github-hosted',
      runner_os: 'Linux',
      runner_arch: 'X64',
      node_version: 'v22.13.0',
    },
    sensor: { name: 'threadloop-github-actions-gate', contract_version: 1 },
  };
}

function parsedReceipt(options: { transparency?: boolean } = {}) {
  const canonicalArtifact = canonicalizeSignedGateReceiptArtifact(artifact(), sha256);
  const statement = buildInTotoReceiptStatement(canonicalArtifact.artifact, canonicalArtifact.sha256);
  return parseSignedReceiptPackage(
    {
      media_type: SIGNED_RECEIPT_MEDIA_TYPE,
      artifact: artifact(),
      bundle: {
        mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
        dsseEnvelope: {
          payload: Buffer.from(canonicalJson(statement)).toString('base64'),
          payloadType: IN_TOTO_PAYLOAD_TYPE,
          signatures: [{ keyid: '', sig: 'c2lnbmF0dXJl' }],
        },
        verificationMaterial: {
          certificate: { rawBytes: 'Y2VydGlmaWNhdGU=' },
          tlogEntries:
            options.transparency === false
              ? []
              : [
                  {
                    inclusionProof: {
                      checkpoint: { envelope: 'checkpoint' },
                      logIndex: '1',
                      rootHash: 'cm9vdA==',
                      treeSize: '2',
                      hashes: [],
                    },
                  },
                ],
        },
      },
    },
    sha256,
  );
}

function oid(oidValue: string, value: string) {
  return { oid: { id: oidValue.split('.').map(Number) }, value: Buffer.from(value) };
}

function trustedSigner() {
  return {
    identity: {
      subjectAlternativeName: certificateIdentity,
      extensions: { issuer: policy.issuer },
      oids: [
        oid('1.3.6.1.4.1.57264.1.9', buildSignerUri),
        oid('1.3.6.1.4.1.57264.1.10', buildSignerSha),
        oid('1.3.6.1.4.1.57264.1.11', 'github-hosted'),
        oid('1.3.6.1.4.1.57264.1.12', sourceRepository),
        oid('1.3.6.1.4.1.57264.1.13', sourceHead),
        oid('1.3.6.1.4.1.57264.1.14', sourceRef),
        oid('1.3.6.1.4.1.57264.1.21', runInvocationUri),
      ],
    },
  };
}

describe('Sigstore receipt verifier', () => {
  it('pins CT, Rekor, caller, called workflow, source, ref, HEAD, and runner identity', async () => {
    const verify = vi.fn<SigstoreVerifyFunction>(() => Promise.resolve(trustedSigner()));

    const signer = await verifySigstoreReceipt(parsedReceipt(), policy, verify);

    expect(verify).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        ctLogThreshold: 1,
        tlogThreshold: 1,
        certificateIssuer: policy.issuer,
        certificateIdentityURI:
          '^https://github\\.com/example/project/\\.github/workflows/threadloop\\.yml@refs/heads/issue-41/signed-ci-receipts$',
        certificateOIDs: {
          '1.3.6.1.4.1.57264.1.9': buildSignerUri,
          '1.3.6.1.4.1.57264.1.10': buildSignerSha,
          '1.3.6.1.4.1.57264.1.11': 'github-hosted',
          '1.3.6.1.4.1.57264.1.12': sourceRepository,
          '1.3.6.1.4.1.57264.1.13': sourceHead,
          '1.3.6.1.4.1.57264.1.14': sourceRef,
          '1.3.6.1.4.1.57264.1.21': runInvocationUri,
        },
      }),
    );
    expect(signer).toEqual({
      issuer: policy.issuer,
      certificateIdentity,
      buildSignerUri,
      buildSignerSha,
      sourceRepository,
      sourceHeadSha: sourceHead,
      sourceRef,
      runnerEnvironment: 'github-hosted',
      runInvocationUri,
    });
  });

  it('rejects missing Rekor inclusion proof before calling Sigstore', async () => {
    const verify = vi.fn<SigstoreVerifyFunction>(() => Promise.resolve(trustedSigner()));

    await expect(verifySigstoreReceipt(parsedReceipt({ transparency: false }), policy, verify)).rejects.toEqual(
      expect.objectContaining<Partial<SigstoreReceiptVerificationError>>({ reason: 'transparency_missing' }),
    );
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects a signer projection that does not exactly match the immutable policy', async () => {
    const verify = vi.fn<SigstoreVerifyFunction>(() =>
      Promise.resolve({
        ...trustedSigner(),
        identity: {
          ...trustedSigner().identity,
          subjectAlternativeName: 'https://github.com/example/project/.github/workflows/other.yml@refs/heads/main',
        },
      }),
    );

    await expect(verifySigstoreReceipt(parsedReceipt(), policy, verify)).rejects.toEqual(
      expect.objectContaining<Partial<SigstoreReceiptVerificationError>>({ reason: 'identity_mismatch' }),
    );
  });

  it.each([
    ['VerificationError', 'signature_invalid'],
    ['PolicyError', 'identity_mismatch'],
    ['TUFError', 'verification_unavailable'],
  ] as const)('maps %s without exposing a permissive fallback', async (name, reason) => {
    const error = new Error(`${name} fixture`);
    error.name = name;
    const verify = vi.fn<SigstoreVerifyFunction>(() => Promise.reject(error));

    await expect(verifySigstoreReceipt(parsedReceipt(), policy, verify)).rejects.toEqual(
      expect.objectContaining<Partial<SigstoreReceiptVerificationError>>({ reason }),
    );
  });
});
