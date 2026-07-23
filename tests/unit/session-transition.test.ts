import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import {
  canonicalizeTransitionRequest,
  evaluateTransitionGuards,
  planNextTransition,
  type ProofGuardContext,
  validateTransitionEvidence,
} from '../../src/domain/session-transition.js';

function passedProofContext(repository: Partial<NonNullable<ProofGuardContext['repository']>> = {}): ProofGuardContext {
  const headSha = 'a'.repeat(40);
  return {
    plan: {
      plan: {
        acceptance_criteria: ['All repository checks pass'],
        gates: [],
      },
      json: '{"acceptance_criteria":["All repository checks pass"],"gates":[]}',
      sha256: 'b'.repeat(64),
      baselineBranch: 'main',
      baselineHeadSha: headSha,
      createdAt: '2026-07-23T00:00:00.000Z',
    },
    evidence: {
      status: 'passed',
      gates: [],
      staleReceiptIds: [],
      failedReceiptIds: [],
      corruptReceiptIds: [],
    },
    ciEvidence: {
      status: 'passed',
      policy: null,
      gates: [],
    },
    attemptsUsed: 0,
    repository: {
      branch: 'main',
      headSha,
      clean: true,
      committedDiffFromBaseline: true,
      committedRepairFromFailure: false,
      ...repository,
    },
  };
}

describe('session transition domain', () => {
  it('uses the injected digest for the canonical request bytes', () => {
    const digest = vi.fn(() => 'injected-sha256');
    const result = canonicalizeTransitionRequest(
      {
        sessionId: 'session_123',
        targetState: 'framed',
        expectedStateVersion: 0,
        actor: 'agent',
        input: {},
      },
      digest,
    );

    expect(digest).toHaveBeenCalledWith(result.requestJson);
    expect(result.requestSha256).toBe('injected-sha256');
  });

  it('canonicalizes recursively equivalent requests to the same bytes and digest', () => {
    const first = canonicalizeTransitionRequest(
      {
        sessionId: 'session_123',
        targetState: 'framed',
        expectedStateVersion: 0,
        actor: 'agent',
        input: { z: [{ b: 2, a: 1 }], a: true },
      },
      sha256,
    );
    const second = canonicalizeTransitionRequest(
      {
        actor: 'agent',
        expectedStateVersion: 0,
        input: { a: true, z: [{ a: 1, b: 2 }] },
        sessionId: 'session_123',
        targetState: 'framed',
      },
      sha256,
    );

    expect(first).toEqual(second);
    expect(first.requestJson).toBe(
      '{"actor":"agent","expected_state_version":0,"input":{"a":true,"z":[{"a":1,"b":2}]},"session_id":"session_123","target_state":"framed"}',
    );
    expect(first.requestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('requires complete evidence before blocking or recovering', () => {
    expect(validateTransitionEvidence('queued', 'blocked', {})).toMatchObject({
      allowed: false,
      guardFailures: [{ code: 'BLOCK_EVIDENCE_REQUIRED' }],
    });
    expect(
      validateTransitionEvidence('queued', 'blocked', {
        block: {
          reason: 'Repository access is unavailable',
          evidence_ref: 'incident:123',
          recovery: 'Restore repository access',
          stop_code: 'REPO_UNAVAILABLE',
        },
      }),
    ).toMatchObject({ allowed: true });
    expect(validateTransitionEvidence('blocked', 'queued', { recovery: { approved_by: 'Nnenna' } })).toMatchObject({
      allowed: false,
      guardFailures: [{ code: 'RECOVERY_EVIDENCE_REQUIRED' }],
    });
  });

  it('fails proof and review transitions closed under their downstream owner', () => {
    expect(evaluateTransitionGuards('framed', 'proof_ready', {}, null)).toEqual({
      allowed: false,
      guardFailures: [
        {
          code: 'PROOF_PLAN_REQUIRED',
          message: 'This transition requires an immutable proof plan and live repository authority.',
          owner_issue: 40,
        },
      ],
      requiredWork: [
        {
          code: 'RESTORE_PROOF_AUTHORITY',
          description: 'Record or restore the session proof plan, then retry from a clean named branch.',
          owner_issue: 40,
        },
      ],
    });
    expect(evaluateTransitionGuards('ready_for_human', 'completed', {}, null)).toMatchObject({
      allowed: false,
      guardFailures: [{ code: 'APPROVAL_AND_MERGE_EVIDENCE_DEFERRED', owner_issue: 42 }],
    });
  });

  it.each([
    ['a dirty worktree', { clean: false }],
    ['another branch at the passing HEAD', { branch: 'alternate' }],
  ])('denies review for %s in both guard and next-action planning', (_scenario, repository) => {
    const proofGuardContext = passedProofContext(repository);

    expect(evaluateTransitionGuards('verifying', 'reviewing', {}, null, proofGuardContext)).toMatchObject({
      allowed: false,
      guardFailures: [
        {
          code: 'PROOF_CHECKOUT_MISMATCH',
          message: 'Review requires current-HEAD passing proof from a clean checkout on the proof-plan branch.',
        },
      ],
      requiredWork: [
        {
          code: 'RESTORE_PROOF_CHECKOUT',
          description: 'Restore the clean proof-plan branch while preserving the verified HEAD, then retry.',
        },
      ],
    });
    expect(
      planNextTransition({
        state: 'verifying',
        stateVersion: 4,
        blockedFromState: null,
        proof: { status: 'passed', attemptsUsed: 0 },
        proofGuardContext,
      }),
    ).toMatchObject({
      candidate: {
        from_state: 'verifying',
        target_state: 'reviewing',
        expected_state_version: 4,
        executable: false,
      },
      guardFailures: [
        {
          code: 'PROOF_CHECKOUT_MISMATCH',
          message: 'Review requires current-HEAD passing proof from a clean checkout on the proof-plan branch.',
        },
      ],
      requiredWork: [
        {
          code: 'RESTORE_PROOF_CHECKOUT',
          description: 'Restore the clean proof-plan branch while preserving the verified HEAD, then retry.',
        },
      ],
    });
  });

  it.each([
    ['policy_missing', 'CI_PROOF_POLICY_REQUIRED', 'START_SESSION_WITH_CI_POLICY'],
    ['missing', 'SIGNED_CI_PROOF_REQUIRED', 'IMPORT_SIGNED_CI_PROOF'],
    ['stale', 'CURRENT_SIGNED_CI_PROOF_REQUIRED', 'RERUN_AND_IMPORT_CI_PROOF'],
    ['corrupt', 'UNCORRUPTED_SIGNED_CI_PROOF_REQUIRED', 'RESTORE_SIGNED_CI_PROOF'],
  ] as const)('blocks review when signed CI proof is %s without selecting repair', (status, code, workCode) => {
    const proofGuardContext = passedProofContext();
    proofGuardContext.ciEvidence = { status, policy: null, gates: [] };

    expect(evaluateTransitionGuards('verifying', 'reviewing', {}, null, proofGuardContext)).toMatchObject({
      allowed: false,
      guardFailures: [{ code, owner_issue: 41 }],
      requiredWork: [{ code: workCode, owner_issue: 41 }],
    });
    expect(
      planNextTransition({
        state: 'verifying',
        stateVersion: 4,
        blockedFromState: null,
        proof: { status: 'passed', attemptsUsed: 0 },
        proofGuardContext,
      }),
    ).toMatchObject({
      candidate: { target_state: 'reviewing', executable: false },
      guardFailures: [{ code, owner_issue: 41 }],
    });
  });

  it.each([
    ['queued', 'framed', true, null],
    ['framed', 'proof_ready', false, null],
    ['proof_ready', 'implementing', false, null],
    ['implementing', 'verifying', false, null],
    ['verifying', null, false, null],
    ['reviewing', null, false, null],
    ['repairing', 'verifying', false, null],
    ['ready_for_human', 'completed', false, null],
    ['blocked', 'implementing', false, 'BLOCKED_REQUIRES_HUMAN_RECOVERY'],
    ['completed', null, false, 'COMPLETED'],
  ] as const)('plans one deterministic candidate for %s', (state, targetState, executable, terminalReason) => {
    expect(
      planNextTransition({
        state,
        stateVersion: 7,
        blockedFromState: state === 'blocked' ? 'implementing' : null,
      }),
    ).toMatchObject({
      candidate:
        targetState === null
          ? null
          : {
              from_state: state,
              target_state: targetState,
              expected_state_version: 7,
              executable,
            },
      terminalReason,
    });
  });
});
