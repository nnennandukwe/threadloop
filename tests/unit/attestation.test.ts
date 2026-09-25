import { describe, expect, it } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import {
  AttestationValidationError,
  authorizeGateReportForSigning,
  buildInTotoReceiptStatement,
  canonicalizeSignedGateReceiptArtifact,
  evaluateCiProofEvidence,
  parseSignedReceiptEnvelope,
  parseSignedReceiptPackage,
  SIGNED_RECEIPT_MEDIA_TYPE_V1,
  SIGNED_RECEIPT_MEDIA_TYPE_V2,
  type GitHubGateJobResult,
  type SignedGateReceiptArtifact,
} from '../../src/domain/attestation.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import {
  captureError,
  gateArtifact as artifact,
  headSha,
  planSha,
  signedGatePackage as packageFor,
} from '../fixtures/receipts.js';

const captureAttestationError = (action: () => unknown) => captureError(AttestationValidationError, action);

function signingContext(jobResult: GitHubGateJobResult, overrides: { sessionId?: string } = {}) {
  const report = artifact();
  return {
    receiptId: 'receipt_signer_generated',
    sessionId: overrides.sessionId ?? 'session_123',
    planSha256: planSha,
    gate: report.gate,
    sourceRepository: report.source.repository,
    sourceRef: report.source.ref,
    sourceHeadSha: headSha,
    runInvocationUri: report.source.run_invocation_uri,
    runnerOs: 'Linux',
    runnerArch: 'X64',
    nodeVersion: 'v22.13.0',
    jobResult,
  };
}

const syncStep = {
  id: 'sync',
  command: ['uv', 'sync', '--all-groups', '--frozen'],
  working_directory: '.',
  timeout_ms: 600_000,
};

function recordedStep(overrides: Record<string, unknown> = {}) {
  return {
    ...syncStep,
    result: 'passed' as const,
    started_at: '2026-07-23T18:00:00.000Z',
    ended_at: '2026-07-23T18:00:05.000Z',
    duration_ms: 5_000,
    exit_status: 0,
    signal: null,
    head_before: headSha,
    head_after: headSha,
    clean_before: true,
    clean_after: true,
    output: { stdout_sha256: 'e'.repeat(64), stderr_sha256: 'f'.repeat(64) },
    ...overrides,
  };
}

/** A v1 artifact predates declared setup: no `setup` key, sensor contract_version 1. */
function v1Artifact(): SignedGateReceiptArtifact {
  const rest = { ...artifact() };
  delete rest.setup;
  return { ...rest, schema_version: 1, sensor: { name: 'threadloop-github-actions-gate', contract_version: 1 } };
}

function v2WithSetup(): SignedGateReceiptArtifact {
  const base = artifact();
  return { ...base, gate: { ...base.gate, setup: [syncStep] }, setup: [recordedStep()] };
}

describe('signed receipt attestation domain', () => {
  it('authorizes a clean gate report only when the GitHub execution job succeeded', () => {
    expect(authorizeGateReportForSigning(artifact(), signingContext('success'))).toMatchObject({
      receipt_id: 'receipt_signer_generated',
      result: 'passed',
      exit_status: 0,
      signal: null,
    });
  });

  it('cannot sign an attacker-supplied pass when GitHub observed the execution job fail', () => {
    expect(authorizeGateReportForSigning(artifact(), signingContext('failure'))).toMatchObject({
      receipt_id: 'receipt_signer_generated',
      result: 'failed',
      exit_status: 1,
    });
  });

  it('rejects a non-passing report when GitHub observed the execution job succeed', () => {
    expect(
      captureAttestationError(() =>
        authorizeGateReportForSigning({ ...artifact(), result: 'failed', exit_status: 1 }, signingContext('success')),
      ).field,
    ).toBe('package.artifact.result');
  });

  it('rejects gate reports that do not match the trusted signing context', () => {
    expect(
      captureAttestationError(() =>
        authorizeGateReportForSigning(artifact(), signingContext('success', { sessionId: 'session_other' })),
      ).field,
    ).toBe('package.artifact.session_id');
  });

  it('signs a job cancelled after setup failed as aborted, keeping the partial setup it recorded', () => {
    const base = artifact();
    const gate = { ...base.gate, setup: [syncStep, { ...syncStep, id: 'second' }] };
    const report = {
      ...base,
      gate,
      result: 'setup_failed' as const,
      exit_status: null,
      setup: [recordedStep({ result: 'failed', exit_status: 1 })],
    };

    const authorized = authorizeGateReportForSigning(report, { ...signingContext('cancelled'), gate });

    expect(authorized).toMatchObject({ result: 'aborted', exit_status: 1, setup: report.setup });
    // The signer re-canonicalizes what it authorized, so the aborted artifact must stay valid.
    expect(canonicalizeSignedGateReceiptArtifact(authorized, sha256).artifact.result).toBe('aborted');
  });

  it('keeps legacy proof plans readable but reports missing immutable CI policy', () => {
    const evidence = evaluateCiProofEvidence({
      sessionId: 'session_123',
      plan: {
        plan: { acceptance_criteria: ['All checks pass'], gates: [artifact().gate] },
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
        { name: 'https://github.com/example/project', digest: { gitCommit: headSha } },
        { name: 'threadloop-gate-receipt.json', digest: { sha256: canonicalArtifact.sha256 } },
      ],
      predicateType: 'https://threadloop.dev/attestations/receipt/v2',
      predicate: {
        schema_version: 2,
        receipt_type: 'gate',
        session_id: 'session_123',
        plan_sha256: planSha,
        gate_id: 'check',
        result: 'passed',
        subject_head_sha: headSha,
        artifact: { name: 'threadloop-gate-receipt.json', sha256: canonicalArtifact.sha256 },
        sensor: { name: 'threadloop-github-actions-gate', contract_version: 2 },
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

  it('rejects a signed payload that is not UTF-8, so the stored statement is always the signed bytes', () => {
    const statement = parseSignedReceiptPackage(packageFor(), sha256).statementJson;
    // A lone 0xff decodes to U+FFFD, so the decoded text would no longer be the bytes that were signed.
    const tampered = Buffer.concat([
      Buffer.from(statement.slice(0, 10)),
      Buffer.from([0xff]),
      Buffer.from(statement.slice(10)),
    ]);

    const error = captureAttestationError(() =>
      parseSignedReceiptEnvelope(packageFor(artifact(), { statement: tampered }), sha256),
    );
    expect(error.field).toBe('package.bundle.dsseEnvelope.payload');
    expect(error.message).toBe('package.bundle.dsseEnvelope.payload must encode UTF-8 text.');
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
    [
      'an empty declared setup',
      { ...artifact(), gate: { ...artifact().gate, setup: [] } },
      'package.artifact.gate.setup',
    ],
  ])('rejects %s', (_name, value, field) => {
    expect(captureAttestationError(() => canonicalizeSignedGateReceiptArtifact(value, sha256)).field).toBe(field);
  });
});

describe('signed gate receipt versioning', () => {
  it('keeps a stored v1 package readable, so existing sessions do not become corrupt', () => {
    const parsed = parseSignedReceiptPackage(packageFor(v1Artifact()), sha256);

    expect(parsed.artifact.schema_version).toBe(1);
    expect(parsed.artifact).not.toHaveProperty('setup');
    expect(parsed.statement.predicateType).toBe('https://threadloop.dev/attestations/receipt/v1');
    expect(parsed.statement.predicate.schema_version).toBe(1);
  });

  it('round-trips a v2 package carrying recorded setup', () => {
    const parsed = parseSignedReceiptPackage(packageFor(v2WithSetup()), sha256);

    expect(parsed.artifact.schema_version).toBe(2);
    expect(parsed.artifact.setup).toEqual([recordedStep()]);
    expect(parsed.statement.predicateType).toBe('https://threadloop.dev/attestations/receipt/v2');
    expect(parsed.statement.predicate.schema_version).toBe(2);
  });

  it.each([
    ['a v2 artifact under the v1 media type', v2WithSetup(), SIGNED_RECEIPT_MEDIA_TYPE_V1],
    ['a v1 artifact under the v2 media type', v1Artifact(), SIGNED_RECEIPT_MEDIA_TYPE_V2],
  ])('rejects %s', (_name, value, mediaType) => {
    expect(
      captureAttestationError(() => parseSignedReceiptPackage(packageFor(value, { mediaType }), sha256)).field,
    ).toBe('package.media_type');
  });

  it.each([
    ['a v1 artifact that smuggles in a setup key', { ...v1Artifact(), setup: [recordedStep()] }, 'package.artifact'],
    [
      'a v2 artifact whose sensor still claims contract_version 1',
      { ...v2WithSetup(), sensor: { name: 'threadloop-github-actions-gate', contract_version: 1 } },
      'package.artifact.sensor.contract_version',
    ],
    // The recorded-setup rule itself is covered in setup-steps.test.ts; this proves signed artifacts apply it.
    ['recorded setup the gate never declared', { ...artifact(), setup: [recordedStep()] }, 'package.artifact.setup'],
    ['a passed artifact that omits declared setup', { ...v2WithSetup(), setup: [] }, 'package.artifact.setup'],
    [
      'recorded setup whose argv differs from the declaration',
      { ...v2WithSetup(), setup: [recordedStep({ command: ['uv', 'sync', '--all-extras'] })] },
      'package.artifact.setup[0]',
    ],
  ])('rejects %s', (_name, value, field) => {
    expect(captureAttestationError(() => canonicalizeSignedGateReceiptArtifact(value, sha256)).field).toBe(field);
  });

  it('accepts a short recorded sequence, because a failing step stops the run', () => {
    const base = artifact();
    const parsed = canonicalizeSignedGateReceiptArtifact(
      {
        ...base,
        gate: { ...base.gate, setup: [syncStep, { ...syncStep, id: 'second' }] },
        result: 'setup_failed',
        setup: [recordedStep({ result: 'failed', exit_status: 1 })],
      },
      sha256,
    );

    expect(parsed.artifact.setup).toHaveLength(1);
    expect(parsed.artifact.result).toBe('setup_failed');
  });
});
