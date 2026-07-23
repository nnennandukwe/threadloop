import type { EntrySource, TaskStatus } from './types.js';

export interface TransitionRequest {
  sessionId: string;
  targetState: TaskStatus;
  expectedStateVersion: number;
  actor: EntrySource;
  input: Record<string, unknown>;
}

export interface CanonicalTransitionRequest {
  canonicalInput: Record<string, unknown>;
  requestJson: string;
  requestSha256: string;
}

export type RequestDigest = (value: string) => string;

export interface TransitionGuardFailure {
  code: string;
  message: string;
  owner_issue?: 40 | 42;
}

export interface TransitionRequiredWork {
  code: string;
  description: string;
  owner_issue?: 40 | 42;
}

export interface TransitionGuardDecision {
  allowed: boolean;
  guardFailures: TransitionGuardFailure[];
  requiredWork: TransitionRequiredWork[];
}

export interface PlannedTransition {
  candidate: {
    from_state: TaskStatus;
    target_state: TaskStatus;
    expected_state_version: number;
    executable: boolean;
  } | null;
  guardFailures: TransitionGuardFailure[];
  requiredWork: TransitionRequiredWork[];
  terminalReason: 'BLOCKED_REQUIRES_HUMAN_RECOVERY' | 'COMPLETED' | null;
}

export function canonicalizeTransitionRequest(
  request: TransitionRequest,
  digest: RequestDigest,
): CanonicalTransitionRequest {
  const canonicalInput = canonicalizeJsonValue(request.input) as Record<string, unknown>;
  const canonical = {
    actor: request.actor,
    expected_state_version: request.expectedStateVersion,
    input: canonicalInput,
    session_id: request.sessionId,
    target_state: request.targetState,
  };
  const requestJson = JSON.stringify(canonical);

  return {
    canonicalInput,
    requestJson,
    requestSha256: digest(requestJson),
  };
}

export function evaluateTransitionGuards(
  from: TaskStatus,
  to: TaskStatus,
  input: Record<string, unknown>,
  blockedFromState: TaskStatus | null,
): TransitionGuardDecision {
  if (from === 'blocked' && blockedFromState === null) {
    return deniedGuards(
      {
        code: 'BLOCKED_PRIOR_STATE_REQUIRED',
        message: 'A blocked session requires its recorded prior lifecycle state.',
      },
      {
        code: 'RESTORE_BLOCKED_PRIOR_STATE',
        description: 'Restore the durable blocked prior state from verified persistence evidence.',
      },
    );
  }

  const evidence = validateTransitionEvidence(from, to, input);
  if (!evidence.allowed) {
    return evidence;
  }

  if (to === 'blocked' || from === 'blocked' || (from === 'queued' && to === 'framed')) {
    return allowedGuards();
  }

  const owner = guardOwner(from, to);
  return owner === 42 ? deferredReviewGuards(to) : deferredProofGuards();
}

export function validateTransitionEvidence(
  from: TaskStatus,
  to: TaskStatus,
  input: Record<string, unknown>,
): TransitionGuardDecision {
  if (to === 'blocked' && !hasRequiredTextFields(input.block, ['reason', 'evidence_ref', 'recovery', 'stop_code'])) {
    return deniedGuards(
      {
        code: 'BLOCK_EVIDENCE_REQUIRED',
        message: 'Entering blocked requires reason, evidence_ref, recovery, and stop_code.',
      },
      {
        code: 'PROVIDE_BLOCK_EVIDENCE',
        description: 'Provide complete block evidence without changing the prior lifecycle state.',
      },
    );
  }

  if (from === 'blocked' && !hasRequiredTextFields(input.recovery, ['approved_by', 'evidence_ref', 'reason'])) {
    return deniedGuards(
      {
        code: 'RECOVERY_EVIDENCE_REQUIRED',
        message: 'Recovering from blocked requires approved_by, evidence_ref, and reason.',
      },
      {
        code: 'PROVIDE_RECOVERY_EVIDENCE',
        description: 'Provide explicit human recovery approval and durable recovery evidence.',
      },
    );
  }

  return allowedGuards();
}

export function planNextTransition(input: {
  state: TaskStatus;
  stateVersion: number;
  blockedFromState: TaskStatus | null;
}): PlannedTransition {
  if (input.state === 'completed') {
    return {
      candidate: null,
      guardFailures: [],
      requiredWork: [],
      terminalReason: 'COMPLETED',
    };
  }

  if (input.state === 'blocked') {
    const target = input.blockedFromState;
    return {
      candidate: target
        ? {
            from_state: 'blocked',
            target_state: target,
            expected_state_version: input.stateVersion,
            executable: false,
          }
        : null,
      guardFailures: [
        {
          code: 'RECOVERY_EVIDENCE_REQUIRED',
          message: 'A blocked session requires explicit human recovery evidence.',
        },
      ],
      requiredWork: [
        {
          code: 'PROVIDE_RECOVERY_EVIDENCE',
          description: 'Provide approved_by, evidence_ref, and reason to resume the recorded prior state.',
        },
      ],
      terminalReason: 'BLOCKED_REQUIRES_HUMAN_RECOVERY',
    };
  }

  const target = deterministicTarget(input.state);
  if (!target) {
    const owner = input.state === 'reviewing' ? 42 : 40;
    const guards = owner === 42 ? deferredReviewGuards(null) : deferredProofGuards();
    return {
      candidate: null,
      guardFailures: guards.guardFailures,
      requiredWork: guards.requiredWork,
      terminalReason: null,
    };
  }

  const guards = evaluateTransitionGuards(input.state, target, {}, input.blockedFromState);
  return {
    candidate: {
      from_state: input.state,
      target_state: target,
      expected_state_version: input.stateVersion,
      executable: guards.allowed,
    },
    guardFailures: guards.guardFailures,
    requiredWork: guards.requiredWork,
    terminalReason: null,
  };
}

function deterministicTarget(state: TaskStatus): TaskStatus | null {
  switch (state) {
    case 'queued':
      return 'framed';
    case 'framed':
      return 'proof_ready';
    case 'proof_ready':
      return 'implementing';
    case 'implementing':
      return 'verifying';
    case 'repairing':
      return 'verifying';
    case 'ready_for_human':
      return 'completed';
    case 'verifying':
    case 'reviewing':
    case 'blocked':
    case 'completed':
      return null;
  }
}

function guardOwner(from: TaskStatus, to: TaskStatus): 40 | 42 {
  if (from === 'reviewing' || from === 'ready_for_human' || to === 'completed') {
    return 42;
  }
  return 40;
}

function deferredProofGuards(): TransitionGuardDecision {
  return deniedGuards(
    {
      code: 'PROOF_AUTHORITY_DEFERRED',
      message: 'Proof-plan and current-HEAD authority is not available in M002-2.',
      owner_issue: 40,
    },
    {
      code: 'IMPLEMENT_ISSUE_40',
      description: 'Provide authoritative proof-plan, gate, staleness, and repair-budget evidence.',
      owner_issue: 40,
    },
  );
}

function deferredReviewGuards(target: TaskStatus | null): TransitionGuardDecision {
  const completing = target === 'completed';
  return deniedGuards(
    {
      code: completing ? 'APPROVAL_AND_MERGE_EVIDENCE_DEFERRED' : 'REVIEW_EVIDENCE_DEFERRED',
      message: completing
        ? 'Human approval and merge evidence is not available in M002-2.'
        : 'Authoritative review evidence is not available in M002-2.',
      owner_issue: 42,
    },
    {
      code: 'IMPLEMENT_ISSUE_42',
      description: 'Provide review sensing, human approval, merge evidence, and governed audit history.',
      owner_issue: 42,
    },
  );
}

function allowedGuards(): TransitionGuardDecision {
  return { allowed: true, guardFailures: [], requiredWork: [] };
}

function deniedGuards(
  guardFailure: TransitionGuardFailure,
  requiredWork: TransitionRequiredWork,
): TransitionGuardDecision {
  return { allowed: false, guardFailures: [guardFailure], requiredWork: [requiredWork] };
}

function hasRequiredTextFields(value: unknown, fields: string[]) {
  if (!isPlainObject(value)) {
    return false;
  }

  return fields.every((field) => typeof value[field] === 'string' && value[field].trim().length > 0);
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeJsonValue(value[key])]),
    );
  }

  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
