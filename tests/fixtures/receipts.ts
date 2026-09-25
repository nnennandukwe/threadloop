import { expect } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import {
  buildInTotoReceiptStatement,
  canonicalizeSignedGateReceiptArtifact,
  IN_TOTO_PAYLOAD_TYPE,
  signedReceiptMediaType,
  type SignedGateReceiptArtifact,
} from '../../src/domain/attestation.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';
import { ProofValidationError } from '../../src/domain/proof.js';

export const headSha = 'a'.repeat(40);
export const planSha = 'b'.repeat(64);
export const workflowSha = 'a'.repeat(40);
/** The repository and branch every signed-receipt fixture, and every fixture Git repository, claims to come from. */
export const fixtureRepository = 'https://github.com/example/project';
export const fixtureBranch = 'issue-41/signed-ci-receipts';

/** A trust policy for one ThreadLoop sensor workflow, bound to a caller workflow on `branch`. */
export function trustPolicy(sensor: 'gate' | 'review', callerWorkflow = 'threadloop.yml', branch = fixtureBranch) {
  return {
    provider: 'github-actions',
    issuer: 'https://token.actions.githubusercontent.com',
    certificate_identity: `${fixtureRepository}/.github/workflows/${callerWorkflow}@refs/heads/${branch}`,
    source_repository: fixtureRepository,
    build_signer_uri: `https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-${sensor}-sensor.yml@${workflowSha}`,
    build_signer_sha: workflowSha,
  };
}

export const ciPolicy = () => trustPolicy('gate');
export const reviewPolicy = () => trustPolicy('review');

/** Runs `action`, requires it to throw an `errorClass`, and returns the error for field assertions. */
export function captureError<E extends Error>(errorClass: new (...args: never[]) => E, action: () => unknown): E {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(errorClass);
    return error as E;
  }
  throw new Error(`Expected ${errorClass.name}.`);
}

export const captureProofValidationError = (action: () => unknown) => captureError(ProofValidationError, action);

export function gateArtifact(): SignedGateReceiptArtifact {
  return {
    schema_version: 2,
    receipt_id: 'receipt_123',
    session_id: 'session_123',
    plan_sha256: planSha,
    gate: { id: 'check', command: ['npm', 'run', 'check'], working_directory: '.', timeout_ms: 900_000 },
    result: 'passed',
    setup: [],
    started_at: '2026-07-23T18:00:00.000Z',
    ended_at: '2026-07-23T18:00:10.000Z',
    duration_ms: 10_000,
    exit_status: 0,
    signal: null,
    head_before: headSha,
    head_after: headSha,
    clean_before: true,
    clean_after: true,
    output: { stdout_sha256: 'c'.repeat(64), stderr_sha256: 'd'.repeat(64) },
    source: {
      repository: fixtureRepository,
      ref: `refs/heads/${fixtureBranch}`,
      head_sha: headSha,
      run_invocation_uri: `${fixtureRepository}/actions/runs/123/attempts/1`,
    },
    environment: {
      runner_environment: 'github-hosted',
      runner_os: 'Linux',
      runner_arch: 'X64',
      node_version: 'v22.13.0',
    },
    sensor: { name: 'threadloop-github-actions-gate', contract_version: 2 },
  };
}

function sigstoreBundle(statement: Buffer, transparency: boolean) {
  return {
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    dsseEnvelope: {
      payload: statement.toString('base64'),
      payloadType: IN_TOTO_PAYLOAD_TYPE,
      signatures: [{ keyid: '', sig: 'c2lnbmF0dXJl' }],
    },
    verificationMaterial: {
      certificate: { rawBytes: 'Y2VydGlmaWNhdGU=' },
      tlogEntries: transparency
        ? [
            {
              inclusionProof: {
                checkpoint: { envelope: 'checkpoint' },
                logIndex: '1',
                rootHash: 'cm9vdA==',
                treeSize: '2',
                hashes: [],
              },
            },
          ]
        : [],
    },
  };
}

/**
 * A self-contained signed gate package whose statement binds `artifact`. `statement` replaces the signed payload
 * bytes, for tests of what the envelope accepts.
 */
export function signedGatePackage(
  artifact: SignedGateReceiptArtifact = gateArtifact(),
  options: { mediaType?: string; statement?: Buffer; transparency?: boolean } = {},
) {
  const canonical = canonicalizeSignedGateReceiptArtifact(artifact, sha256);
  const statement =
    options.statement ?? Buffer.from(canonicalJson(buildInTotoReceiptStatement(canonical.artifact, canonical.sha256)));
  return {
    media_type: options.mediaType ?? signedReceiptMediaType(canonical.artifact.schema_version),
    artifact,
    bundle: sigstoreBundle(statement, options.transparency !== false),
  };
}
