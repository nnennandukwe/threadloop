import { describe, expect, it } from 'vitest';
import { evaluateLifecycleTransition, isActiveTaskStatus } from '../../src/domain/lifecycle.js';
import { TASK_STATUS } from '../../src/domain/types.js';

describe('governed lifecycle', () => {
  it('publishes the complete ordered lifecycle state set', () => {
    expect(TASK_STATUS).toEqual([
      'queued',
      'framed',
      'proof_ready',
      'implementing',
      'verifying',
      'reviewing',
      'repairing',
      'ready_for_human',
      'blocked',
      'completed',
    ]);
  });

  it('allows every forward transition in the structural workflow', () => {
    const allowed = [
      ['queued', 'framed'],
      ['framed', 'proof_ready'],
      ['proof_ready', 'implementing'],
      ['implementing', 'verifying'],
      ['verifying', 'reviewing'],
      ['verifying', 'repairing'],
      ['reviewing', 'repairing'],
      ['reviewing', 'ready_for_human'],
      ['repairing', 'verifying'],
      ['ready_for_human', 'completed'],
    ] as const;

    for (const [from, to] of allowed) {
      expect(evaluateLifecycleTransition(from, to)).toMatchObject({
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
      'verifying:reviewing',
      'verifying:repairing',
      'reviewing:repairing',
      'reviewing:ready_for_human',
      'repairing:verifying',
      'ready_for_human:completed',
      ...TASK_STATUS.filter((state) => !['blocked', 'completed'].includes(state)).map((state) => `${state}:blocked`),
    ]);

    for (const from of TASK_STATUS) {
      for (const to of TASK_STATUS) {
        expect(evaluateLifecycleTransition(from, to).allowed, `${from} -> ${to}`).toBe(
          allowedPairs.has(`${from}:${to}`),
        );
      }
    }
  });

  it('allows every nonterminal workflow state to block', () => {
    for (const from of TASK_STATUS.filter((state) => !['blocked', 'completed'].includes(state))) {
      expect(evaluateLifecycleTransition(from, 'blocked')).toMatchObject({
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
    for (const status of TASK_STATUS) {
      expect(isActiveTaskStatus(status), status).toBe(status !== 'completed');
    }
  });
});
