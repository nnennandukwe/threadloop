import { describe, expect, it } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import {
  AttestationValidationError,
  buildInTotoReceiptStatement,
  canonicalizeSignedGateReceiptArtifact,
  evaluateCiProofEvidence,
  IN_TOTO_PAYLOAD_TYPE,
  parseSignedReceiptPackage,
  SIGNED_RECEIPT_MEDIA_TYPE,
  type SignedGateReceiptArtifact,
} from '../../src/domain/attestation.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';

const headSha = 'a'.repeat(40);
const planSha = 'b'.repeat(64);

function artifact(): SignedGateReceiptArtifact {
  return {
    schema_version: 1,
    receipt_id: 'receipt_123',
    session_id: 'session_123',
    plan_sha256: planSha,
    gate: {
      id: 'check',
      command: ['npm', 'run', 'check'],
      working_directory: '.',
      timeout_ms: 900_000,
    },
    result: 'passed',
    started_at: '2026-07-23T18:00:00.000Z',
    ended_at: '2026-07-23T18:00:10.000Z',
    duration_ms: 10_000,
    exit_status: 0,
    signal: null,
    head_before: headSha,
    head_after: headSha,
    clean_before: true,
    clean_after: true,
    output: {
      stdout_sha256: 'c'.repeat(64),
      stderr_sha256: 'd'.repeat(64),
    },
    source: {
      repository: 'https://github.com/example/project',
      ref: 'refs/heads/issue-41/signed-ci-receipts',
      head_sha: headSha,
      run_invocation_uri: 'https://github.com/example/project/actions/runs/123/attempts/1',
    },
    environment: {
      runner_environment: 'github-hosted',
      runner_os: 'Linux',
      runner_arch: 'X64',
      node_version: 'v22.13.0',
    },
    sensor: {
      name: 'threadloop-github-actions-gate',
      contract_version: 1,
    },
  };
}

function packageFor(receiptArtifact = artifact()) {
  const canonicalArtifact = canonicalizeSignedGateReceiptArtifact(receiptArtifact, sha256);
  const statement = buildInTotoReceiptStatement(canonicalArtifact.artifact, canonicalArtifact.sha256);
  const statementJson = canonicalJson(statement);
  return {
    media_type: SIGNED_RECEIPT_MEDIA_TYPE,
    artifact: receiptArtifact,
    bundle: {
      mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      dsseEnvelope: {
        payload: Buffer.from(statementJson).toString('base64'),
        payloadType: IN_TOTO_PAYLOAD_TYPE,
        signatures: [{ keyid: '', sig: 'c2lnbmF0dXJl' }],
      },
      verificationMaterial: {
        certificate: { rawBytes: 'Y2VydGlmaWNhdGU=' },
        tlogEntries: [{ inclusionProof: { checkpoint: { envelope: 'checkpoint' } } }],
      },
    },
  };
}

function captureAttestationError(action: () => unknown) {
  try {
    action();
    throw new Error('Expected attestation validation to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(AttestationValidationError);
    return error as AttestationValidationError;
  }
}

describe('signed receipt attestation domain', () => {
  it('keeps legacy proof plans readable but reports missing immutable CI policy', () => {
    const evidence = evaluateCiProofEvidence({
      sessionId: 'session_123',
      plan: {
        plan: {
          acceptance_criteria: ['All checks pass'],
          gates: [artifact().gate],
        },
        json: '{}',
        sha256: planSha,
        baselineBranch: 'main',
        baselineHeadSha: headSha,
        createdAt: '2026-07-23T18:00:00.000Z',
      },
      receipts: [],
      currentHead: headSha,
      packageContents: new Map(),
      digest: sha256,
    });

    expect(evidence).toEqual({
      status: 'policy_missing',
      policy: null,
      gates: [
        {
          gate_id: 'check',
          status: 'missing',
          receipt_id: null,
          sequence: null,
          subject_head_sha: null,
          package_sha256: null,
          verified_at: null,
        },
      ],
    });
  });

  it('binds the canonical execution artifact and source HEAD in an in-toto Statement', () => {
    const canonicalArtifact = canonicalizeSignedGateReceiptArtifact(artifact(), sha256);
    const statement = buildInTotoReceiptStatement(canonicalArtifact.artifact, canonicalArtifact.sha256);

    expect(canonicalArtifact.json).toBe(canonicalJson(artifact()));
    expect(statement).toEqual({
      _type: 'https://in-toto.io/Statement/v1',
      subject: [
        {
          name: 'https://github.com/example/project',
          digest: { gitCommit: headSha },
        },
        {
          name: 'threadloop-gate-receipt.json',
          digest: { sha256: canonicalArtifact.sha256 },
        },
      ],
      predicateType: 'https://threadloop.dev/attestations/receipt/v1',
      predicate: {
        schema_version: 1,
        receipt_type: 'gate',
        session_id: 'session_123',
        plan_sha256: planSha,
        gate_id: 'check',
        result: 'passed',
        subject_head_sha: headSha,
        artifact: {
          name: 'threadloop-gate-receipt.json',
          sha256: canonicalArtifact.sha256,
        },
        sensor: {
          name: 'threadloop-github-actions-gate',
          contract_version: 1,
        },
      },
    });
  });

  it('parses one self-contained package and verifies its canonical artifact digest', () => {
    const parsed = parseSignedReceiptPackage(packageFor(), sha256);

    expect(parsed.artifact.receipt_id).toBe('receipt_123');
    expect(parsed.artifactSha256).toBe(sha256(canonicalJson(artifact())));
    expect(parsed.statement.predicate.subject_head_sha).toBe(headSha);
    expect(parsed.packageJson).toBe(canonicalJson(packageFor()));
    expect(parsed.packageSha256).toBe(sha256(parsed.packageJson));
  });

  it('rejects an artifact whose bytes do not match the signed subject digest', () => {
    const receiptPackage = packageFor();
    receiptPackage.artifact.output.stdout_sha256 = 'e'.repeat(64);

    expect(captureAttestationError(() => parseSignedReceiptPackage(receiptPackage, sha256)).field).toBe(
      'statement.subject[1].digest.sha256',
    );
  });

  it.each([
    ['unknown artifact fields', { ...artifact(), unexpected: true }, 'package.artifact'],
    [
      'a non-GitHub-hosted runner',
      { ...artifact(), environment: { ...artifact().environment, runner_environment: 'self-hosted' } },
      'package.artifact.environment.runner_environment',
    ],
    [
      'a malformed run URI',
      { ...artifact(), source: { ...artifact().source, run_invocation_uri: 'https://example.com/run/1' } },
      'package.artifact.source.run_invocation_uri',
    ],
  ])('rejects %s', (_name, value, field) => {
    expect(captureAttestationError(() => canonicalizeSignedGateReceiptArtifact(value, sha256)).field).toBe(field);
  });
});
