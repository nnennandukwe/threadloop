import { describe, expect, it } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import { canonicalizeProofPlan, evaluateProofEvidence, ProofValidationError } from '../../src/domain/proof.js';
import { canonicalJson } from '../../src/domain/canonical-json.js';

const workflowSha = 'a'.repeat(40);

function ciPolicy() {
  return {
    provider: 'github-actions',
    issuer: 'https://token.actions.githubusercontent.com',
    certificate_identity:
      'https://github.com/example/project/.github/workflows/threadloop.yml@refs/heads/issue-78/gate-setup-steps',
    source_repository: 'https://github.com/example/project',
    build_signer_uri: `https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-gate-sensor.yml@${workflowSha}`,
    build_signer_sha: workflowSha,
  };
}

function reviewPolicy() {
  return {
    provider: 'github-actions',
    issuer: 'https://token.actions.githubusercontent.com',
    certificate_identity:
      'https://github.com/example/project/.github/workflows/threadloop-review.yml@refs/heads/issue-78/gate-setup-steps',
    source_repository: 'https://github.com/example/project',
    build_signer_uri: `https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-review-sensor.yml@${workflowSha}`,
    build_signer_sha: workflowSha,
  };
}

const syncStep = {
  id: 'sync',
  command: ['uv', 'sync', '--all-groups', '--frozen'],
  working_directory: '.',
  timeout_ms: 600_000,
};

const verifyGate = {
  id: 'check',
  command: ['make', 'verify'],
  working_directory: '.',
  timeout_ms: 900_000,
};

function planV4(gates: unknown[]) {
  return {
    contract_version: 4,
    acceptance_criteria: ['A provisioned verify target passes'],
    ci: ciPolicy(),
    review: reviewPolicy(),
    gates,
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

describe('proof plan v4 declared setup steps', () => {
  it('accepts a newly recorded v4 plan whose gate declares ordered setup steps', () => {
    const result = canonicalizeProofPlan(planV4([{ ...verifyGate, setup: [syncStep] }]), sha256, {
      requireReviewPolicy: true,
    });

    expect(result.plan).toMatchObject({ contract_version: 4 });
    expect(result.plan.gates[0]?.setup).toEqual([syncStep]);
  });

  it('preserves declared setup order rather than sorting or deduplicating steps', () => {
    const toolchain = { ...syncStep, id: 'toolchain', command: ['asdf', 'install'] };
    const result = canonicalizeProofPlan(planV4([{ ...verifyGate, setup: [syncStep, toolchain] }]), sha256, {
      requireReviewPolicy: true,
    });

    expect(result.plan.gates[0]?.setup?.map((step) => step.id)).toEqual(['sync', 'toolchain']);
  });

  it('normalizes an empty setup array away so one canonical form means no provisioning', () => {
    const withEmpty = canonicalizeProofPlan(planV4([{ ...verifyGate, setup: [] }]), sha256, {
      requireReviewPolicy: true,
    });
    const withoutKey = canonicalizeProofPlan(planV4([verifyGate]), sha256, { requireReviewPolicy: true });

    expect(withEmpty.plan.gates[0]).not.toHaveProperty('setup');
    expect(withEmpty.json).toBe(withoutKey.json);
    expect(withEmpty.sha256).toBe(withoutKey.sha256);
  });

  it('canonicalizes a setup-free v4 gate identically to the same v3 gate', () => {
    const v4 = canonicalizeProofPlan(planV4([verifyGate]), sha256, { requireReviewPolicy: true });
    const v3 = canonicalizeProofPlan(
      {
        contract_version: 3,
        acceptance_criteria: ['A provisioned verify target passes'],
        ci: ciPolicy(),
        review: reviewPolicy(),
        gates: [verifyGate],
      },
      sha256,
    );

    const gatesOf = (json: string) => (JSON.parse(json) as { gates: unknown[] }).gates;
    expect(gatesOf(v4.json)).toEqual(gatesOf(v3.json));
  });

  it('rejects setup declared by a v3 plan, so the version gate actually gates', () => {
    expect(
      captureProofValidationError(() =>
        canonicalizeProofPlan(
          {
            contract_version: 3,
            acceptance_criteria: ['A provisioned verify target passes'],
            ci: ciPolicy(),
            review: reviewPolicy(),
            gates: [{ ...verifyGate, setup: [syncStep] }],
          },
          sha256,
        ),
      ).field,
    ).toBe('proof_plan.gates[0]');
  });

  it('requires contract_version 4 for newly recorded plans', () => {
    expect(
      captureProofValidationError(() =>
        canonicalizeProofPlan(
          {
            contract_version: 3,
            acceptance_criteria: ['All checks pass'],
            ci: ciPolicy(),
            review: reviewPolicy(),
            gates: [verifyGate],
          },
          sha256,
          { requireReviewPolicy: true },
        ),
      ).field,
    ).toBe('proof_plan.contract_version');
  });

  it('accepts v4 where only an immutable CI policy is required', () => {
    const result = canonicalizeProofPlan(planV4([{ ...verifyGate, setup: [syncStep] }]), sha256, {
      requireCiPolicy: true,
    });

    expect(result.plan).toMatchObject({ contract_version: 4 });
  });

  it.each([
    { name: 'legacy v1', plan: { acceptance_criteria: ['Pass'], gates: [verifyGate] } },
    {
      name: 'v2',
      plan: { contract_version: 2, acceptance_criteria: ['Pass'], ci: ciPolicy(), gates: [verifyGate] },
    },
    {
      name: 'v3',
      plan: {
        contract_version: 3,
        acceptance_criteria: ['Pass'],
        ci: ciPolicy(),
        review: reviewPolicy(),
        gates: [verifyGate],
      },
    },
  ])('keeps stored $name plans readable and runnable', ({ plan }) => {
    expect(canonicalizeProofPlan(plan, sha256).plan).toEqual(plan);
  });

  it.each([
    {
      name: 'an empty setup command',
      setup: [{ ...syncStep, command: [] }],
      field: 'proof_plan.gates[0].setup[0].command',
    },
    {
      name: 'a non-string setup argument',
      setup: [{ ...syncStep, command: ['uv', 7] }],
      field: 'proof_plan.gates[0].setup[0].command[1]',
    },
    {
      name: 'an absolute setup working directory',
      setup: [{ ...syncStep, working_directory: '/etc' }],
      field: 'proof_plan.gates[0].setup[0].working_directory',
    },
    {
      name: 'a setup working directory escaping the repository',
      setup: [{ ...syncStep, working_directory: '../elsewhere' }],
      field: 'proof_plan.gates[0].setup[0].working_directory',
    },
    {
      name: 'a missing setup timeout',
      setup: [{ id: 'sync', command: ['uv', 'sync'], working_directory: '.' }],
      field: 'proof_plan.gates[0].setup[0]',
    },
    {
      name: 'a setup timeout above the ceiling',
      setup: [{ ...syncStep, timeout_ms: 86_400_001 }],
      field: 'proof_plan.gates[0].setup[0].timeout_ms',
    },
    {
      name: 'a setup step id that is not an identifier',
      setup: [{ ...syncStep, id: '-sync' }],
      field: 'proof_plan.gates[0].setup[0].id',
    },
    {
      name: 'duplicate setup step ids within one gate',
      setup: [syncStep, { ...syncStep, command: ['uv', 'lock'] }],
      field: 'proof_plan.gates[0].setup[1].id',
    },
    {
      name: 'a setup step carrying an unknown field',
      setup: [{ ...syncStep, shell: true }],
      field: 'proof_plan.gates[0].setup[0]',
    },
    {
      name: 'nested setup inside a setup step',
      setup: [{ ...syncStep, setup: [] }],
      field: 'proof_plan.gates[0].setup[0]',
    },
  ])('rejects $name', ({ setup, field }) => {
    expect(
      captureProofValidationError(() =>
        canonicalizeProofPlan(planV4([{ ...verifyGate, setup }]), sha256, { requireReviewPolicy: true }),
      ).field,
    ).toBe(field);
  });

  it('rejects setup that is not an array', () => {
    expect(
      captureProofValidationError(() =>
        canonicalizeProofPlan(planV4([{ ...verifyGate, setup: {} }]), sha256, { requireReviewPolicy: true }),
      ).field,
    ).toBe('proof_plan.gates[0].setup');
  });

  it('rejects more setup steps than a gate may declare', () => {
    const setup = Array.from({ length: 33 }, (_unused, index) => ({ ...syncStep, id: `step-${index}` }));

    expect(
      captureProofValidationError(() =>
        canonicalizeProofPlan(planV4([{ ...verifyGate, setup }]), sha256, { requireReviewPolicy: true }),
      ).field,
    ).toBe('proof_plan.gates[0].setup');
  });
});

describe('local proof evidence for recorded setup', () => {
  const head = 'e'.repeat(40);
  const sessionId = 'session_setup_fixture';
  const artifactSha256 = 'f'.repeat(64);

  function boundPlan(setup: unknown[]) {
    const canonical = canonicalizeProofPlan(planV4([{ ...verifyGate, setup }]), sha256, {
      requireReviewPolicy: true,
    });
    return {
      ...canonical,
      baselineBranch: 'issue-78/setup',
      baselineHeadSha: head,
      createdAt: '2026-07-31T00:00:00.000Z',
    };
  }

  function recordedStep(overrides: Record<string, unknown> = {}) {
    return {
      id: 'sync',
      command: syncStep.command,
      working_directory: '.',
      timeout_ms: syncStep.timeout_ms,
      result: 'failed',
      started_at: '2026-07-31T00:00:00.000Z',
      ended_at: '2026-07-31T00:00:01.000Z',
      duration_ms: 1_000,
      exit_status: 1,
      signal: null,
      head_before: head,
      head_after: head,
      clean_before: true,
      clean_after: true,
      output: { stdout_sha256: 'a'.repeat(64), stderr_sha256: 'b'.repeat(64) },
      ...overrides,
    };
  }

  function evidenceFor(plan: ReturnType<typeof boundPlan>, payloadOverrides: Record<string, unknown>) {
    const payload = {
      id: 'receipt_setup_1',
      session_id: sessionId,
      gate_id: 'check',
      plan_sha256: plan.sha256,
      result: 'setup_failed',
      command: verifyGate.command,
      working_directory: '.',
      timeout_ms: verifyGate.timeout_ms,
      started_at: '2026-07-31T00:00:00.000Z',
      ended_at: '2026-07-31T00:00:01.000Z',
      duration_ms: 1_000,
      exit_status: null,
      signal: null,
      head_before: head,
      head_after: head,
      clean_before: true,
      clean_after: true,
      artifact: { path: '.threadloop/artifacts/execution.json', sha256: artifactSha256 },
      sensor: { name: 'threadloop-local-gate', contract_version: 2 },
      ...payloadOverrides,
    };
    const receiptJson = canonicalJson(payload);
    return evaluateProofEvidence({
      sessionId,
      plan,
      receipts: [
        {
          sequence: 1,
          id: 'receipt_setup_1',
          sessionId,
          gateId: 'check',
          planSha256: plan.sha256,
          headBefore: head,
          headAfter: head,
          result: payload.result as 'setup_failed',
          artifactPath: '.threadloop/artifacts/execution.json',
          artifactSha256,
          receiptJson,
          receiptSha256: sha256(receiptJson),
          stateVersion: 1,
          createdAt: '2026-07-31T00:00:01.000Z',
        },
      ],
      currentHead: head,
      artifactDigests: new Map([['receipt_setup_1', artifactSha256]]),
      digest: sha256,
    });
  }

  it('projects a recorded setup failure as setup_failed', () => {
    const evidence = evidenceFor(boundPlan([syncStep]), { setup: [recordedStep()] });

    expect(evidence.status).toBe('setup_failed');
    expect(evidence.gates[0]).toMatchObject({ status: 'setup_failed', result: 'setup_failed' });
    expect(evidence.setupFailedReceiptIds).toEqual(['receipt_setup_1']);
    expect(evidence.failedReceiptIds).toEqual([]);
  });

  it('treats a passed receipt that omits declared setup as corrupt', () => {
    const evidence = evidenceFor(boundPlan([syncStep]), {
      result: 'passed',
      setup: [],
      exit_status: 0,
    });

    expect(evidence.status).toBe('corrupt');
  });

  it('treats a recorded setup step the plan never declared as corrupt', () => {
    const evidence = evidenceFor(boundPlan([syncStep]), {
      setup: [recordedStep({ command: ['uv', 'sync', '--all-extras'] })],
    });

    expect(evidence.status).toBe('corrupt');
  });

  it('treats more recorded steps than declared as corrupt', () => {
    const evidence = evidenceFor(boundPlan([syncStep]), {
      setup: [recordedStep(), recordedStep({ id: 'extra' })],
    });

    expect(evidence.status).toBe('corrupt');
  });

  it('keeps a stored v1 receipt without setup valid against a gate that declares none', () => {
    const canonical = canonicalizeProofPlan(planV4([verifyGate]), sha256, { requireReviewPolicy: true });
    const plan = {
      ...canonical,
      baselineBranch: 'issue-78/setup',
      baselineHeadSha: head,
      createdAt: '2026-07-31T00:00:00.000Z',
    };
    const evidence = evidenceFor(plan, {
      result: 'passed',
      sensor: { name: 'threadloop-local-gate', contract_version: 1 },
    });

    expect(evidence.status).toBe('passed');
  });
});
