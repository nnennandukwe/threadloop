import { describe, expect, it } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { canonicalizeProofPlan, ProofValidationError } from '../../src/domain/proof.js';

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
