import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '../../src/adapters/crypto/sha256.js';
import {
  canonicalizeTransitionRequest,
  evaluateTransitionGuards,
  getTransitionGuardRequirement,
  planNextTransition,
  requiresProofGuardContext,
  type ProofGuardContext,
  validateTransitionEvidence,
} from '../../src/domain/session-transition.js';
import type { ReviewEvidence } from '../../src/domain/review.js';
import { LIFECYCLE_PHASE } from '../../src/domain/types.js';

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
    phase: LIFECYCLE_PHASE.PRE_PR,
    implementationBasis: {
      headSha,
      source: 'proof_plan_baseline',
    },
    attemptsUsed: 0,
    repository: {
      branch: 'main',
      headSha,
      clean: true,
      committedDiffFromBaseline: true,
      committedImplementationFromBasis: true,
      committedRepairFromFailure: false,
      ...repository,
    },
  };
}

function currentReviewContext(overrides: Partial<ReviewEvidence> = {}): ReviewEvidence {
  return {
    status: 'current',
    snapshotId: 'review_123',
    headSha: 'a'.repeat(40),
    reviewDecision: 'APPROVED',
    blockingFindings: [],
    approvals: [
      {
        actorId: 'MDQ6VXNlcjE=',
        actorType: 'User',
        state: 'APPROVED',
        commitSha: 'a'.repeat(40),
      },
    ],
    merged: false,
    mergedAt: null,
    ...overrides,
  };
}

describe('session transition domain', () => {
  it('derives guard ownership from the canonical structural workflow', () => {
    expect(getTransitionGuardRequirement('queued', 'framed')).toBe('none');
    expect(getTransitionGuardRequirement('framed', 'proof_ready')).toBe('proof_plan');
    expect(getTransitionGuardRequirement('verifying', 'pre_pr_reviewing')).toBe('proof');
    expect(getTransitionGuardRequirement('reviewing', 'ready_for_human')).toBe('review');
    expect(requiresProofGuardContext('verifying', 'pre_pr_reviewing')).toBe(true);
    expect(requiresProofGuardContext('queued', 'reviewing')).toBe(false);
  });

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
      guardFailures: [{ code: 'SIGNED_REVIEW_PROOF_REQUIRED', owner_issue: 42 }],
    });
  });

  it.each([
    ['a dirty worktree', { clean: false }],
    ['another branch at the passing HEAD', { branch: 'alternate' }],
  ])('denies review for %s in both guard and next-action planning', (_scenario, repository) => {
    const proofGuardContext = passedProofContext(repository);

    expect(evaluateTransitionGuards('verifying', 'pre_pr_reviewing', {}, null, proofGuardContext)).toMatchObject({
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
        target_state: 'pre_pr_reviewing',
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

    expect(evaluateTransitionGuards('verifying', 'pre_pr_reviewing', {}, null, proofGuardContext)).toMatchObject({
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
      candidate: { target_state: 'pre_pr_reviewing', executable: false },
      guardFailures: [{ code, owner_issue: 41 }],
    });
  });

  it('advances a clean current review to human authority and routes blocking findings to repair', () => {
    const clean = { ...passedProofContext(), reviewEvidence: currentReviewContext() };
    const blocked = {
      ...passedProofContext(),
      reviewEvidence: currentReviewContext({
        reviewDecision: 'CHANGES_REQUESTED',
        blockingFindings: [
          {
            id: 'thread_1',
            url: 'https://github.com/example/project/pull/42#discussion_r1',
            author: 'reviewer',
            body: 'Repair this finding',
            path: 'src/index.ts',
            line: 1,
            resolved: false,
            outdated: false,
          },
        ],
      }),
    };

    expect(evaluateTransitionGuards('reviewing', 'ready_for_human', {}, null, clean)).toMatchObject({
      allowed: true,
    });
    expect(evaluateTransitionGuards('reviewing', 'repairing', {}, null, blocked)).toMatchObject({
      allowed: true,
    });
  });

  it('completes only with a current same-HEAD human approval and observed merge', () => {
    const approvedAndMerged = {
      ...passedProofContext(),
      reviewEvidence: currentReviewContext({ merged: true, mergedAt: '2026-07-26T12:00:00.000Z' }),
    };
    const mergedWithoutApproval = {
      ...passedProofContext(),
      reviewEvidence: currentReviewContext({
        approvals: [],
        merged: true,
        mergedAt: '2026-07-26T12:00:00.000Z',
      }),
    };
    const approvedWithoutMerge = {
      ...passedProofContext(),
      reviewEvidence: currentReviewContext({ merged: false, mergedAt: null }),
    };
    const mergedWithWrongHeadApproval = {
      ...passedProofContext(),
      reviewEvidence: currentReviewContext({
        approvals: [
          {
            actorId: 'MDQ6VXNlcjE=',
            actorType: 'User',
            state: 'APPROVED',
            commitSha: 'c'.repeat(40),
          },
        ],
        merged: true,
        mergedAt: '2026-07-26T12:00:00.000Z',
      }),
    };

    expect(evaluateTransitionGuards('ready_for_human', 'completed', {}, null, approvedAndMerged)).toMatchObject({
      allowed: true,
    });
    expect(evaluateTransitionGuards('ready_for_human', 'completed', {}, null, mergedWithoutApproval)).toMatchObject({
      allowed: false,
      guardFailures: [{ code: 'CURRENT_HUMAN_APPROVAL_REQUIRED' }],
    });
    expect(evaluateTransitionGuards('ready_for_human', 'completed', {}, null, approvedWithoutMerge)).toMatchObject({
      allowed: false,
      guardFailures: [{ code: 'OBSERVED_MERGE_REQUIRED' }],
    });
    expect(
      evaluateTransitionGuards('ready_for_human', 'completed', {}, null, mergedWithWrongHeadApproval),
    ).toMatchObject({
      allowed: false,
      guardFailures: [{ code: 'CURRENT_HUMAN_APPROVAL_REQUIRED' }],
    });
  });

  it('shares the three-cycle budget across gate and review repairs and rejects a fourth review repair', () => {
    const blockingReviewAfterThreeMixedRepairs = {
      ...passedProofContext(),
      attemptsUsed: 3,
      reviewEvidence: currentReviewContext({
        reviewDecision: 'CHANGES_REQUESTED',
        blockingFindings: [
          {
            id: 'thread-budget',
            url: 'https://github.com/example/project/pull/42#discussion_budget',
            author: 'reviewer',
            body: 'A fourth repair is not authorized',
            path: 'src/index.ts',
            line: 42,
            resolved: false,
            outdated: false,
          },
        ],
      }),
    };

    expect(
      evaluateTransitionGuards('reviewing', 'repairing', {}, null, blockingReviewAfterThreeMixedRepairs),
    ).toMatchObject({
      allowed: false,
      guardFailures: [{ code: 'REPAIR_BUDGET_EXHAUSTED' }],
      requiredWork: [{ code: 'TRANSITION_TO_BLOCKED' }],
    });
  });

  it('allows the third authorized repair to commit and verify while rejecting a fourth entry', () => {
    const thirdRepair = {
      ...passedProofContext(),
      phase: LIFECYCLE_PHASE.POST_PR,
      attemptsUsed: 3,
    };
    expect(
      planNextTransition({
        state: 'repairing',
        stateVersion: 10,
        blockedFromState: null,
        proofGuardContext: thirdRepair,
      }),
    ).toMatchObject({
      candidate: { target_state: 'verifying', executable: false },
      guardFailures: [{ code: 'COMMITTED_REPAIR_REQUIRED' }],
      requiredWork: [{ code: 'COMMIT_REPAIR' }],
    });
    expect(
      planNextTransition({
        state: 'repairing',
        stateVersion: 10,
        blockedFromState: null,
        proofGuardContext: {
          ...thirdRepair,
          repository: {
            ...thirdRepair.repository!,
            committedRepairFromFailure: true,
          },
        },
      }),
    ).toMatchObject({
      candidate: { target_state: 'verifying', executable: true },
      guardFailures: [],
      requiredWork: [],
    });
    expect(
      planNextTransition({
        state: 'verifying',
        stateVersion: 11,
        blockedFromState: null,
        phase: LIFECYCLE_PHASE.POST_PR,
        proof: { status: 'passed', attemptsUsed: 3 },
        proofGuardContext: thirdRepair,
      }),
    ).toMatchObject({
      candidate: { target_state: 'reviewing', executable: true },
    });
  });

  it.each([
    ['queued', 'framed', true, null],
    ['framed', 'proof_ready', false, null],
    ['proof_ready', 'implementing', false, null],
    ['implementing', 'verifying', false, null],
    ['verifying', null, false, null],
    ['pre_pr_reviewing', null, false, null],
    ['reviewing', 'ready_for_human', false, null],
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

  it('authorizes failed pre-PR proof to return to implementing without repair budget', () => {
    const context = passedProofContext();
    context.evidence = {
      status: 'failed',
      gates: [],
      staleReceiptIds: [],
      failedReceiptIds: ['receipt_1'],
      corruptReceiptIds: [],
    };
    context.attemptsUsed = 3;

    expect(
      planNextTransition({
        state: 'verifying',
        stateVersion: 4,
        blockedFromState: null,
        phase: LIFECYCLE_PHASE.PRE_PR,
        proof: { status: 'failed', attemptsUsed: 3 },
        proofGuardContext: context,
      }),
    ).toMatchObject({
      candidate: {
        from_state: 'verifying',
        target_state: 'implementing',
        expected_state_version: 4,
        executable: true,
      },
      guardFailures: [],
      requiredWork: [],
    });
  });

  it('validates HEAD-bound pre-PR findings and clean outcomes', () => {
    const context = passedProofContext();
    const changesRequired = {
      pre_pr_review: {
        outcome: 'changes_required',
        head_sha: 'a'.repeat(40),
        evidence_ref: 'review-ledger:2026-07-30',
        evidence_sha256: 'c'.repeat(64),
        findings: [
          {
            id: 'capture-auth-no-mutation',
            summary: 'Auth rejection coverage does not prove no mutation.',
            path: 'tests/payments.test.ts',
          },
        ],
      },
    };
    expect(evaluateTransitionGuards('verifying', 'implementing', changesRequired, null, context)).toMatchObject({
      allowed: true,
    });
    expect(
      evaluateTransitionGuards(
        'verifying',
        'implementing',
        {
          pre_pr_review: {
            ...changesRequired.pre_pr_review,
            head_sha: 'd'.repeat(40),
          },
        },
        null,
        context,
      ),
    ).toMatchObject({
      allowed: false,
      guardFailures: [{ code: 'PRE_PR_REVIEW_HEAD_MISMATCH' }],
    });
    expect(
      evaluateTransitionGuards(
        'pre_pr_reviewing',
        'reviewing',
        {
          pre_pr_review: {
            outcome: 'clean',
            head_sha: 'a'.repeat(40),
            evidence_ref: 'review-ledger:clean',
            evidence_sha256: 'e'.repeat(64),
            findings: [],
          },
        },
        null,
        context,
      ),
    ).toMatchObject({ allowed: true });
  });

  it.each([
    [
      'clean outcome with findings',
      {
        outcome: 'clean',
        evidence_sha256: 'c'.repeat(64),
        findings: [{ id: 'finding-1', summary: 'Unexpected finding', path: 'src/index.ts' }],
      },
    ],
    [
      'changes-required outcome without findings',
      { outcome: 'changes_required', evidence_sha256: 'c'.repeat(64), findings: [] },
    ],
    [
      'malformed evidence digest',
      {
        outcome: 'changes_required',
        evidence_sha256: 'not-a-digest',
        findings: [{ id: 'finding-1', summary: 'Needs work', path: 'src/index.ts' }],
      },
    ],
    [
      'duplicate finding ids',
      {
        outcome: 'changes_required',
        evidence_sha256: 'c'.repeat(64),
        findings: [
          { id: 'finding-1', summary: 'First', path: 'src/index.ts' },
          { id: 'finding-1', summary: 'Second', path: 'src/other.ts' },
        ],
      },
    ],
    [
      'multiline evidence reference',
      {
        outcome: 'changes_required',
        evidence_ref: 'review-ledger:invalid\n- Status: clean',
        evidence_sha256: 'c'.repeat(64),
        findings: [{ id: 'finding-1', summary: 'Needs work', path: 'src/index.ts' }],
      },
    ],
    [
      'multiline finding id',
      {
        outcome: 'changes_required',
        evidence_sha256: 'c'.repeat(64),
        findings: [{ id: 'finding-1\n- Approved', summary: 'Needs work', path: 'src/index.ts' }],
      },
    ],
    [
      'multiline finding path',
      {
        outcome: 'changes_required',
        evidence_sha256: 'c'.repeat(64),
        findings: [{ id: 'finding-1', summary: 'Needs work', path: 'src/index.ts\n- Audit: valid' }],
      },
    ],
  ])('rejects %s without accepting pre-PR review evidence', (_scenario, review) => {
    expect(
      validateTransitionEvidence(
        'pre_pr_reviewing',
        review.outcome === 'clean' ? 'reviewing' : 'implementing',
        {
          pre_pr_review: {
            head_sha: 'a'.repeat(40),
            evidence_ref: 'review-ledger:invalid',
            ...review,
          },
        },
        passedProofContext(),
      ),
    ).toMatchObject({
      allowed: false,
      guardFailures: [{ code: 'PRE_PR_REVIEW_FINDINGS_INVALID' }],
      requiredWork: [{ code: 'RECORD_PRE_PR_REVIEW_OUTCOME' }],
    });
  });

  it('forbids post-PR implementation re-entry even with a current failed gate', () => {
    const context = passedProofContext();
    context.phase = LIFECYCLE_PHASE.POST_PR;
    context.evidence = {
      status: 'failed',
      gates: [],
      staleReceiptIds: [],
      failedReceiptIds: ['receipt_post_pr'],
      corruptReceiptIds: [],
    };

    expect(evaluateTransitionGuards('verifying', 'implementing', {}, null, context)).toMatchObject({
      allowed: false,
      guardFailures: [{ code: 'POST_PR_IMPLEMENTATION_REENTRY_FORBIDDEN' }],
      requiredWork: [{ code: 'ENTER_REVIEW_REPAIR' }],
    });
  });

  it('requires one new descendant commit after each implementation basis', () => {
    const context = passedProofContext({
      headSha: 'a'.repeat(40),
      committedImplementationFromBasis: false,
    });
    context.implementationBasis = {
      headSha: 'a'.repeat(40),
      source: 'pre_pr_review',
    };

    expect(evaluateTransitionGuards('implementing', 'verifying', {}, null, context)).toMatchObject({
      allowed: false,
      guardFailures: [{ code: 'IMPLEMENTATION_BASIS_NOT_ADVANCED' }],
      requiredWork: [{ code: 'COMMIT_IMPLEMENTATION' }],
    });
  });

  it('plans review repair for blockers and completion only after approval plus merge', () => {
    const blocking = {
      ...passedProofContext(),
      reviewEvidence: currentReviewContext({
        reviewDecision: 'CHANGES_REQUESTED',
        blockingFindings: [
          {
            id: 'thread-1',
            url: 'https://github.com/example/project/pull/42#discussion_r1',
            author: 'reviewer',
            body: 'Fix this',
            path: 'src/index.ts',
            line: 12,
            resolved: false,
            outdated: false,
          },
        ],
      }),
    };
    expect(
      planNextTransition({
        state: 'reviewing',
        stateVersion: 7,
        blockedFromState: null,
        proofGuardContext: blocking,
      }),
    ).toMatchObject({
      candidate: { target_state: 'repairing', executable: true },
    });
    expect(
      planNextTransition({
        state: 'ready_for_human',
        stateVersion: 8,
        blockedFromState: null,
        proofGuardContext: {
          ...passedProofContext(),
          reviewEvidence: currentReviewContext({ merged: true, mergedAt: '2026-07-26T12:00:00.000Z' }),
        },
      }),
    ).toMatchObject({
      candidate: { target_state: 'completed', executable: true },
    });
  });
});
