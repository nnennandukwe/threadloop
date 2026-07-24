import { describe, expect, it } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { canonicalizeProofPlan, ProofValidationError } from '../../src/domain/proof.js';

const workflowSha = 'a'.repeat(40);

function ciPolicy() {
  return {
    provider: 'github-actions',
    issuer: 'https://token.actions.githubusercontent.com',
    certificate_identity:
      'https://github.com/example/project/.github/workflows/threadloop.yml@refs/heads/issue-41/signed-ci-receipts',
    source_repository: 'https://github.com/example/project',
    build_signer_uri: `https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-gate-sensor.yml@${workflowSha}`,
    build_signer_sha: workflowSha,
  };
}

function captureProofValidationError(action: () => unknown) {
  try {
    action();
    throw new Error('Expected proof validation to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(ProofValidationError);
    return error as ProofValidationError;
  }
}

describe('proof plan domain', () => {
  it('canonicalizes equivalent exact plans to the same bytes and digest', () => {
    const first = canonicalizeProofPlan(
      {
        gates: [
          {
            timeout_ms: 5_000,
            working_directory: '.',
            command: ['npm', 'run', 'check'],
            id: 'repository-check',
          },
        ],
        acceptance_criteria: ['All checks pass'],
      },
      sha256,
    );
    const second = canonicalizeProofPlan(
      {
        acceptance_criteria: ['All checks pass'],
        gates: [
          {
            id: 'repository-check',
            command: ['npm', 'run', 'check'],
            working_directory: '.',
            timeout_ms: 5_000,
          },
        ],
      },
      sha256,
    );

    expect(first).toEqual(second);
    expect(first.json).toBe(
      '{"acceptance_criteria":["All checks pass"],"gates":[{"command":["npm","run","check"],"id":"repository-check","timeout_ms":5000,"working_directory":"."}]}',
    );
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('canonicalizes an exact v2 plan with immutable GitHub Actions trust policy', () => {
    const result = canonicalizeProofPlan(
      {
        gates: [
          {
            timeout_ms: 5_000,
            working_directory: '.',
            command: ['npm', 'run', 'check'],
            id: 'repository-check',
          },
        ],
        ci: ciPolicy(),
        acceptance_criteria: ['All checks pass'],
        contract_version: 2,
      },
      sha256,
      { requireCiPolicy: true },
    );

    expect(result.plan).toMatchObject({
      contract_version: 2,
      ci: {
        provider: 'github-actions',
        build_signer_sha: workflowSha,
      },
    });
    expect(result.json).toBe(
      `{"acceptance_criteria":["All checks pass"],"ci":{"build_signer_sha":"${workflowSha}","build_signer_uri":"https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-gate-sensor.yml@${workflowSha}","certificate_identity":"https://github.com/example/project/.github/workflows/threadloop.yml@refs/heads/issue-41/signed-ci-receipts","issuer":"https://token.actions.githubusercontent.com","provider":"github-actions","source_repository":"https://github.com/example/project"},"contract_version":2,"gates":[{"command":["npm","run","check"],"id":"repository-check","timeout_ms":5000,"working_directory":"."}]}`,
    );
  });

  it('rejects a newly recorded legacy plan while preserving legacy read compatibility', () => {
    const legacy = {
      acceptance_criteria: ['All checks pass'],
      gates: [{ id: 'check', command: ['npm', 'test'], working_directory: '.', timeout_ms: 5_000 }],
    };

    expect(canonicalizeProofPlan(legacy, sha256).plan).toEqual(legacy);
    expect(
      captureProofValidationError(() => canonicalizeProofPlan(legacy, sha256, { requireCiPolicy: true })).field,
    ).toBe('proof_plan.contract_version');
  });

  it.each([
    {
      name: 'non-GitHub issuer',
      ci: { ...ciPolicy(), issuer: 'https://issuer.example.com' },
      field: 'proof_plan.ci.issuer',
    },
    {
      name: 'certificate identity outside the source repository',
      ci: {
        ...ciPolicy(),
        certificate_identity: 'https://github.com/another/project/.github/workflows/threadloop.yml@refs/heads/issue-41',
      },
      field: 'proof_plan.ci.certificate_identity',
    },
    {
      name: 'build signer URI and digest disagreement',
      ci: { ...ciPolicy(), build_signer_sha: 'b'.repeat(40) },
      field: 'proof_plan.ci.build_signer_uri',
    },
  ])('rejects $name', ({ ci, field }) => {
    expect(
      captureProofValidationError(() =>
        canonicalizeProofPlan(
          {
            contract_version: 2,
            acceptance_criteria: ['Pass'],
            ci,
            gates: [{ id: 'check', command: ['node'], working_directory: '.', timeout_ms: 1 }],
          },
          sha256,
          { requireCiPolicy: true },
        ),
      ).field,
    ).toBe(field);
  });

  it.each([
    {
      name: 'empty acceptance criteria',
      plan: { acceptance_criteria: [], gates: [] },
      field: 'proof_plan.acceptance_criteria',
    },
    {
      name: 'duplicate gate ids',
      plan: {
        acceptance_criteria: ['Pass'],
        gates: [
          { id: 'check', command: ['node'], working_directory: '.', timeout_ms: 1 },
          { id: 'check', command: ['node'], working_directory: '.', timeout_ms: 1 },
        ],
      },
      field: 'proof_plan.gates[1].id',
    },
    {
      name: 'empty argv',
      plan: {
        acceptance_criteria: ['Pass'],
        gates: [{ id: 'check', command: [], working_directory: '.', timeout_ms: 1 }],
      },
      field: 'proof_plan.gates[0].command',
    },
    {
      name: 'path traversal',
      plan: {
        acceptance_criteria: ['Pass'],
        gates: [{ id: 'check', command: ['node'], working_directory: '../outside', timeout_ms: 1 }],
      },
      field: 'proof_plan.gates[0].working_directory',
    },
    {
      name: 'invalid timeout',
      plan: {
        acceptance_criteria: ['Pass'],
        gates: [{ id: 'check', command: ['node'], working_directory: '.', timeout_ms: 0 }],
      },
      field: 'proof_plan.gates[0].timeout_ms',
    },
    {
      name: 'unknown fields',
      plan: {
        acceptance_criteria: ['Pass'],
        gates: [{ id: 'check', command: ['node'], working_directory: '.', timeout_ms: 1 }],
        command_override: ['false'],
      },
      field: 'proof_plan',
    },
  ])('rejects $name', ({ plan, field }) => {
    try {
      canonicalizeProofPlan(plan, sha256);
      throw new Error('Expected proof plan validation to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(ProofValidationError);
      expect((error as ProofValidationError).field).toBe(field);
    }
  });
});
