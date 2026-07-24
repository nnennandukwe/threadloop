import { TASK_STATUS, type TaskStatus } from './types.js';

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

const FORWARD_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  [TASK_STATUS.QUEUED]: [TASK_STATUS.FRAMED],
  [TASK_STATUS.FRAMED]: [TASK_STATUS.PROOF_READY],
  [TASK_STATUS.PROOF_READY]: [TASK_STATUS.IMPLEMENTING],
  [TASK_STATUS.IMPLEMENTING]: [TASK_STATUS.VERIFYING],
  [TASK_STATUS.VERIFYING]: [TASK_STATUS.REVIEWING, TASK_STATUS.REPAIRING],
  [TASK_STATUS.REVIEWING]: [TASK_STATUS.REPAIRING, TASK_STATUS.READY_FOR_HUMAN],
  [TASK_STATUS.REPAIRING]: [TASK_STATUS.VERIFYING],
  [TASK_STATUS.READY_FOR_HUMAN]: [TASK_STATUS.COMPLETED],
  [TASK_STATUS.BLOCKED]: [],
  [TASK_STATUS.COMPLETED]: [],
};

export function evaluateLifecycleTransition(
  sourceState: TaskStatus,
  targetState: TaskStatus,
  context: LifecycleTransitionContext = {},
): LifecycleTransitionDecision {
  if (sourceState === TASK_STATUS.COMPLETED) {
    return denied(
      'COMPLETED_TERMINAL',
      'The completed lifecycle state is terminal.',
      'Start a new ThreadLoop session for additional work.',
    );
  }

  if (sourceState === TASK_STATUS.BLOCKED) {
    if (
      !context.blockedFromState ||
      context.blockedFromState === TASK_STATUS.BLOCKED ||
      context.blockedFromState === TASK_STATUS.COMPLETED
    ) {
      return denied(
        'BLOCKED_RESUME_REQUIRED',
        'A blocked session can resume only to its recorded prior state.',
        'Record explicit human recovery approval and retry the stored prior state.',
      );
    }

    if (targetState !== context.blockedFromState) {
      return denied(
        'BLOCKED_RESUME_MISMATCH',
        `Blocked session recovery must return to ${context.blockedFromState}, not ${targetState}.`,
        `Retry the transition to ${context.blockedFromState} with explicit human approval.`,
      );
    }

    return allowed(sourceState, targetState);
  }

  if (targetState === TASK_STATUS.BLOCKED) {
    return allowed(sourceState, targetState);
  }

  if (isForwardLifecycleTransition(sourceState, targetState)) {
    return allowed(sourceState, targetState);
  }

  return denied(
    'INVALID_TRANSITION',
    `Lifecycle transition ${sourceState} -> ${targetState} is not structurally allowed.`,
    'Run `threadloop session next --json` and satisfy the reported guard before retrying.',
  );
}

export function isActiveTaskStatus(status: TaskStatus) {
  return status !== TASK_STATUS.COMPLETED;
}

export function isForwardLifecycleTransition(sourceState: TaskStatus, targetState: TaskStatus) {
  return FORWARD_TRANSITIONS[sourceState].includes(targetState);
}

export function getDeterministicForwardTarget(status: TaskStatus): TaskStatus | null {
  const targets = FORWARD_TRANSITIONS[status];
  return targets.length === 1 ? (targets[0] ?? null) : null;
}

function allowed(sourceState: TaskStatus, targetState: TaskStatus): LifecycleTransitionDecision {
  return {
    allowed: true,
    code: 'TRANSITION_ALLOWED',
    message: `Lifecycle transition ${sourceState} -> ${targetState} is structurally allowed.`,
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
