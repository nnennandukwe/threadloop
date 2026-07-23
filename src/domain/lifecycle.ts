import type { TaskStatus } from './types.js';

export const LIFECYCLE_DECISION_CODES = [
  'TRANSITION_ALLOWED',
  'INVALID_TRANSITION',
  'COMPLETED_TERMINAL',
  'BLOCKED_RESUME_REQUIRED',
  'BLOCKED_RESUME_MISMATCH',
] as const;

export type LifecycleDecisionCode = (typeof LIFECYCLE_DECISION_CODES)[number];

export interface LifecycleTransitionContext {
  blockedFromState?: TaskStatus | null;
}

export interface LifecycleTransitionDecision {
  allowed: boolean;
  code: LifecycleDecisionCode;
  message: string;
  recovery: string | null;
}

const FORWARD_TRANSITIONS = {
  queued: ['framed'],
  framed: ['proof_ready'],
  proof_ready: ['implementing'],
  implementing: ['verifying'],
  verifying: ['reviewing', 'repairing'],
  reviewing: ['repairing', 'ready_for_human'],
  repairing: ['verifying'],
  ready_for_human: ['completed'],
  blocked: [],
  completed: [],
} as const satisfies Record<TaskStatus, readonly TaskStatus[]>;

export function evaluateLifecycleTransition(
  from: TaskStatus,
  to: TaskStatus,
  context: LifecycleTransitionContext = {},
): LifecycleTransitionDecision {
  if (from === 'completed') {
    return denied(
      'COMPLETED_TERMINAL',
      'The completed lifecycle state is terminal.',
      'Start a new ThreadLoop session for additional work.',
    );
  }

  if (from === 'blocked') {
    if (!context.blockedFromState || ['blocked', 'completed'].includes(context.blockedFromState)) {
      return denied(
        'BLOCKED_RESUME_REQUIRED',
        'A blocked session can resume only to its recorded prior state.',
        'Record explicit human recovery approval and retry the stored prior state.',
      );
    }

    if (to !== context.blockedFromState) {
      return denied(
        'BLOCKED_RESUME_MISMATCH',
        `Blocked session recovery must return to ${context.blockedFromState}, not ${to}.`,
        `Retry the transition to ${context.blockedFromState} with explicit human approval.`,
      );
    }

    return allowed(from, to);
  }

  if (to === 'blocked') {
    return allowed(from, to);
  }

  if ((FORWARD_TRANSITIONS[from] as readonly TaskStatus[]).includes(to)) {
    return allowed(from, to);
  }

  return denied(
    'INVALID_TRANSITION',
    `Lifecycle transition ${from} -> ${to} is not structurally allowed.`,
    'Run `threadloop session next --json` and satisfy the reported guard before retrying.',
  );
}

export function isActiveTaskStatus(status: TaskStatus) {
  return status !== 'completed';
}

function allowed(from: TaskStatus, to: TaskStatus): LifecycleTransitionDecision {
  return {
    allowed: true,
    code: 'TRANSITION_ALLOWED',
    message: `Lifecycle transition ${from} -> ${to} is structurally allowed.`,
    recovery: null,
  };
}

function denied(
  code: Exclude<LifecycleDecisionCode, 'TRANSITION_ALLOWED'>,
  message: string,
  recovery: string,
): LifecycleTransitionDecision {
  return {
    allowed: false,
    code,
    message,
    recovery,
  };
}
