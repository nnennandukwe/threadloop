import { LIFECYCLE_PHASE, TASK_STATUS, type LifecyclePhase, type TaskStatus } from './types.js';

export const LIFECYCLE_DECISION_CODES = [
  'TRANSITION_ALLOWED',
  'INVALID_TRANSITION',
  'COMPLETED_TERMINAL',
  'BLOCKED_RESUME_REQUIRED',
  'BLOCKED_RESUME_MISMATCH',
  'PRE_PR_REVIEW_BOUNDARY_REQUIRED',
  'POST_PR_IMPLEMENTATION_REENTRY_FORBIDDEN',
] as const;

export type LifecycleDecisionCode = (typeof LIFECYCLE_DECISION_CODES)[number];

export interface LifecycleTransitionContext {
  blockedFromState?: TaskStatus | null;
  phase?: LifecyclePhase;
}

export interface LifecycleTransitionDecision {
  allowed: boolean;
  code: LifecycleDecisionCode;
  message: string;
  recovery: string | null;
}

export const REPAIR_ENTRY_STATES = [
  TASK_STATUS.VERIFYING,
  TASK_STATUS.REVIEWING,
  TASK_STATUS.READY_FOR_HUMAN,
] as const satisfies readonly TaskStatus[];

const FORWARD_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  [TASK_STATUS.QUEUED]: [TASK_STATUS.FRAMED],
  [TASK_STATUS.FRAMED]: [TASK_STATUS.PROOF_READY],
  [TASK_STATUS.PROOF_READY]: [TASK_STATUS.IMPLEMENTING],
  [TASK_STATUS.IMPLEMENTING]: [TASK_STATUS.VERIFYING],
  [TASK_STATUS.VERIFYING]: [
    TASK_STATUS.IMPLEMENTING,
    TASK_STATUS.PRE_PR_REVIEWING,
    TASK_STATUS.REVIEWING,
    TASK_STATUS.REPAIRING,
  ],
  [TASK_STATUS.PRE_PR_REVIEWING]: [TASK_STATUS.IMPLEMENTING, TASK_STATUS.REVIEWING],
  [TASK_STATUS.REVIEWING]: [TASK_STATUS.REPAIRING, TASK_STATUS.READY_FOR_HUMAN],
  [TASK_STATUS.REPAIRING]: [TASK_STATUS.VERIFYING],
  [TASK_STATUS.READY_FOR_HUMAN]: [TASK_STATUS.REPAIRING, TASK_STATUS.COMPLETED],
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

  if (
    context.phase === LIFECYCLE_PHASE.POST_PR &&
    targetState === TASK_STATUS.IMPLEMENTING &&
    sourceState !== TASK_STATUS.PROOF_READY
  ) {
    return denied(
      'POST_PR_IMPLEMENTATION_REENTRY_FORBIDDEN',
      `Lifecycle transition ${sourceState} -> implementing is forbidden after reviewing has been entered.`,
      'Use the signed-review-authorized repairing path while repair budget remains.',
    );
  }

  if (
    context.phase === LIFECYCLE_PHASE.PRE_PR &&
    sourceState === TASK_STATUS.VERIFYING &&
    targetState === TASK_STATUS.REVIEWING
  ) {
    return denied(
      'PRE_PR_REVIEW_BOUNDARY_REQUIRED',
      'A pre-PR session must pass through pre_pr_reviewing before reviewing.',
      'Transition to pre_pr_reviewing after current local and signed CI proof pass.',
    );
  }

  if (
    context.phase === LIFECYCLE_PHASE.POST_PR &&
    (sourceState === TASK_STATUS.PRE_PR_REVIEWING || targetState === TASK_STATUS.PRE_PR_REVIEWING)
  ) {
    return denied(
      'INVALID_TRANSITION',
      'The pre_pr_reviewing state is unavailable after reviewing has been entered.',
      'Use the post-PR reviewing and repairing lifecycle.',
    );
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

export function deriveLifecyclePhase(history: ReadonlyArray<{ to_state: TaskStatus }>): LifecyclePhase {
  return history.some((transition) => transition.to_state === TASK_STATUS.REVIEWING)
    ? LIFECYCLE_PHASE.POST_PR
    : LIFECYCLE_PHASE.PRE_PR;
}

export function isActiveTaskStatus(status: TaskStatus) {
  return status !== TASK_STATUS.COMPLETED;
}

export function isForwardLifecycleTransition(sourceState: TaskStatus, targetState: TaskStatus) {
  return FORWARD_TRANSITIONS[sourceState].includes(targetState);
}

export function isRepairEntryTransition(sourceState: TaskStatus, targetState: TaskStatus) {
  return (
    targetState === TASK_STATUS.REPAIRING &&
    REPAIR_ENTRY_STATES.some((repairEntryState) => repairEntryState === sourceState)
  );
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
