import { describe, expect, it } from 'vitest';
import {
  deriveLifecyclePhase,
  evaluateLifecycleTransition,
  getDeterministicForwardTarget,
  isActiveTaskStatus,
} from '../../src/domain/lifecycle.js';
import { LIFECYCLE_PHASE, TASK_STATUS, TASK_STATUS_VALUES } from '../../src/domain/types.js';

describe('governed lifecycle', () => {
  it('publishes the complete ordered lifecycle state set', () => {
    expect(TASK_STATUS_VALUES).toEqual([
      'queued',
      'framed',
      'proof_ready',
      'implementing',
      'verifying',
      'pre_pr_reviewing',
      'reviewing',
      'repairing',
      'ready_for_human',
      'blocked',
      'completed',
    ]);
  });

  it('prevents callers from mutating the shared lifecycle state set', () => {
    expect(Object.isFrozen(TASK_STATUS)).toBe(true);
    expect(Object.isFrozen(TASK_STATUS_VALUES)).toBe(true);
  });

  it('allows every forward transition in the structural workflow', () => {
    const allowed = [
      ['queued', 'framed'],
      ['framed', 'proof_ready'],
      ['proof_ready', 'implementing'],
      ['implementing', 'verifying'],
      ['verifying', 'implementing'],
      ['verifying', 'pre_pr_reviewing'],
      ['verifying', 'reviewing'],
      ['verifying', 'repairing'],
      ['pre_pr_reviewing', 'implementing'],
      ['pre_pr_reviewing', 'reviewing'],
      ['reviewing', 'repairing'],
      ['reviewing', 'ready_for_human'],
      ['repairing', 'verifying'],
      ['ready_for_human', 'repairing'],
      ['ready_for_human', 'completed'],
    ] as const;

    for (const [sourceState, targetState] of allowed) {
      expect(evaluateLifecycleTransition(sourceState, targetState)).toMatchObject({
        allowed: true,
        code: 'TRANSITION_ALLOWED',
        recovery: null,
      });
    }
  });

  it('matches the complete unblocked transition matrix', () => {
    const allowedPairs = new Set([
      'queued:framed',
      'framed:proof_ready',
      'proof_ready:implementing',
      'implementing:verifying',
      'verifying:implementing',
      'verifying:pre_pr_reviewing',
      'verifying:reviewing',
      'verifying:repairing',
      'pre_pr_reviewing:implementing',
      'pre_pr_reviewing:reviewing',
      'reviewing:repairing',
      'reviewing:ready_for_human',
      'repairing:verifying',
      'ready_for_human:repairing',
      'ready_for_human:completed',
      ...TASK_STATUS_VALUES.filter((state) => !['blocked', 'completed'].includes(state)).map(
        (state) => `${state}:blocked`,
      ),
    ]);

    for (const sourceState of TASK_STATUS_VALUES) {
      for (const targetState of TASK_STATUS_VALUES) {
        expect(evaluateLifecycleTransition(sourceState, targetState).allowed, `${sourceState} -> ${targetState}`).toBe(
          allowedPairs.has(`${sourceState}:${targetState}`),
        );
      }
    }
  });

  it('allows every nonterminal workflow state to block', () => {
    for (const sourceState of TASK_STATUS_VALUES.filter((state) => !['blocked', 'completed'].includes(state))) {
      expect(evaluateLifecycleTransition(sourceState, 'blocked')).toMatchObject({
        allowed: true,
        code: 'TRANSITION_ALLOWED',
      });
    }
  });

  it('fails closed for invalid transitions with recovery guidance', () => {
    const decision = evaluateLifecycleTransition('queued', 'reviewing');
    expect(decision).toMatchObject({
      allowed: false,
      code: 'INVALID_TRANSITION',
    });
    expect(decision.message).toContain('queued');
    expect(decision.recovery).toContain('threadloop session next --json');
  });

  it('keeps completed terminal and resumes blocked only to its recorded prior state', () => {
    expect(evaluateLifecycleTransition('completed', 'blocked')).toMatchObject({
      allowed: false,
      code: 'COMPLETED_TERMINAL',
    });
    expect(evaluateLifecycleTransition('blocked', 'verifying')).toMatchObject({
      allowed: false,
      code: 'BLOCKED_RESUME_REQUIRED',
    });
    expect(evaluateLifecycleTransition('blocked', 'verifying', { blockedFromState: 'reviewing' })).toMatchObject({
      allowed: false,
      code: 'BLOCKED_RESUME_MISMATCH',
    });
    expect(evaluateLifecycleTransition('blocked', 'reviewing', { blockedFromState: 'reviewing' })).toMatchObject({
      allowed: true,
      code: 'TRANSITION_ALLOWED',
    });
  });

  it('treats every lifecycle state except completed as active-session compatible', () => {
    for (const status of TASK_STATUS_VALUES) {
      expect(isActiveTaskStatus(status), status).toBe(status !== 'completed');
    }
  });

  it('derives deterministic next states from the structural workflow', () => {
    expect(getDeterministicForwardTarget('queued')).toBe('framed');
    expect(getDeterministicForwardTarget('repairing')).toBe('verifying');
    expect(getDeterministicForwardTarget('verifying')).toBeNull();
    expect(getDeterministicForwardTarget('completed')).toBeNull();
  });

  it('derives a monotonic pre-PR or post-PR phase from transition history', () => {
    expect(deriveLifecyclePhase([])).toBe(LIFECYCLE_PHASE.PRE_PR);
    expect(deriveLifecyclePhase([{ to_state: TASK_STATUS.PRE_PR_REVIEWING }])).toBe(LIFECYCLE_PHASE.PRE_PR);
    expect(
      deriveLifecyclePhase([
        { to_state: TASK_STATUS.REVIEWING },
        { to_state: TASK_STATUS.REPAIRING },
        { to_state: TASK_STATUS.VERIFYING },
      ]),
    ).toBe(LIFECYCLE_PHASE.POST_PR);
    for (const migratedState of [
      TASK_STATUS.REVIEWING,
      TASK_STATUS.REPAIRING,
      TASK_STATUS.READY_FOR_HUMAN,
      TASK_STATUS.COMPLETED,
    ]) {
      expect(deriveLifecyclePhase([], migratedState), migratedState).toBe(LIFECYCLE_PHASE.POST_PR);
    }
    expect(deriveLifecyclePhase([], TASK_STATUS.VERIFYING)).toBe(LIFECYCLE_PHASE.PRE_PR);
  });

  it('separates pre-PR iteration from post-PR repair authority', () => {
    expect(evaluateLifecycleTransition('verifying', 'reviewing', { phase: LIFECYCLE_PHASE.PRE_PR })).toMatchObject({
      allowed: false,
      code: 'PRE_PR_REVIEW_BOUNDARY_REQUIRED',
    });
    expect(evaluateLifecycleTransition('verifying', 'implementing', { phase: LIFECYCLE_PHASE.POST_PR })).toMatchObject({
      allowed: false,
      code: 'POST_PR_IMPLEMENTATION_REENTRY_FORBIDDEN',
    });
    expect(evaluateLifecycleTransition('verifying', 'implementing', { phase: LIFECYCLE_PHASE.PRE_PR })).toMatchObject({
      allowed: true,
    });
    expect(
      evaluateLifecycleTransition('pre_pr_reviewing', 'repairing', { phase: LIFECYCLE_PHASE.PRE_PR }),
    ).toMatchObject({
      allowed: false,
      code: 'INVALID_TRANSITION',
    });
    expect(evaluateLifecycleTransition('reviewing', 'implementing', { phase: LIFECYCLE_PHASE.POST_PR })).toMatchObject({
      allowed: false,
      code: 'POST_PR_IMPLEMENTATION_REENTRY_FORBIDDEN',
    });
  });
});
