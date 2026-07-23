import type { EntrySource, TaskStatus } from './types.js';
import { canonicalizeJsonValue, isPlainObject } from './canonical-json.js';
import type { BoundProofPlan } from './proof.js';
import type { ProofEvidence, ProofEvidenceStatus } from './proof.js';
import type { CiProofEvidence } from './attestation.js';

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
  owner_issue?: 40 | 41 | 42;
}

export interface TransitionRequiredWork {
  code: string;
  description: string;
  owner_issue?: 40 | 41 | 42;
}

export interface TransitionGuardDecision {
  allowed: boolean;
  guardFailures: TransitionGuardFailure[];
  requiredWork: TransitionRequiredWork[];
}

export interface ProofGuardContext {
  boundPlan?: BoundProofPlan;
  plan?: BoundProofPlan | null;
  evidence?: ProofEvidence;
  ciEvidence?: CiProofEvidence;
  repository?: {
    branch: string | null;
    headSha: string;
    clean: boolean;
    committedDiffFromBaseline: boolean;
    committedRepairFromFailure: boolean;
  };
  attemptsUsed?: number;
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
  proof: ProofGuardContext = {},
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
  if (from === 'framed' && to === 'proof_ready' && proof.boundPlan) {
    return allowedGuards();
  }
  if (owner === 40) {
    return evaluateProofOwnedGuards(from, to, proof);
  }
  return owner === 42 ? deferredReviewGuards(to) : deferredProofGuards();
}

function evaluateProofOwnedGuards(from: TaskStatus, to: TaskStatus, proof: ProofGuardContext): TransitionGuardDecision {
  const plan = proof.plan;
  const repository = proof.repository;
  if (!plan || !repository) {
    return deniedGuards(
      {
        code: 'PROOF_PLAN_REQUIRED',
        message: 'This transition requires an immutable proof plan and live repository authority.',
        owner_issue: 40,
      },
      {
        code: 'RESTORE_PROOF_AUTHORITY',
        description: 'Record or restore the session proof plan, then retry from a clean named branch.',
        owner_issue: 40,
      },
    );
  }

  if (from === 'proof_ready' && to === 'implementing') {
    if (repository.clean && repository.branch === plan.baselineBranch && repository.headSha === plan.baselineHeadSha) {
      return allowedGuards();
    }
    return deniedGuards(
      {
        code: 'PROOF_BASELINE_MISMATCH',
        message: 'The repository no longer matches the clean branch and HEAD bound to the proof plan.',
        owner_issue: 40,
      },
      {
        code: 'RESTORE_PROOF_BASELINE',
        description: 'Restore the clean proof-plan branch and baseline HEAD before implementation begins.',
        owner_issue: 40,
      },
    );
  }

  if (from === 'implementing' && to === 'verifying') {
    if (
      repository.clean &&
      repository.branch === plan.baselineBranch &&
      repository.headSha !== plan.baselineHeadSha &&
      repository.committedDiffFromBaseline
    ) {
      return allowedGuards();
    }
    return deniedGuards(
      {
        code: 'COMMITTED_IMPLEMENTATION_REQUIRED',
        message: 'Verification requires a clean committed diff from the proof-plan baseline.',
        owner_issue: 40,
      },
      {
        code: 'COMMIT_IMPLEMENTATION',
        description: 'Commit the implementation on the proof-plan branch and clean the worktree.',
        owner_issue: 40,
      },
    );
  }

  if (from === 'verifying' && to === 'reviewing') {
    if (proof.evidence?.status !== 'passed') {
      return deniedGuards(
        {
          code: 'CURRENT_PASSING_PROOF_REQUIRED',
          message: 'Review requires every latest declared gate receipt to pass for the current HEAD.',
          owner_issue: 40,
        },
        {
          code: 'COMPLETE_CURRENT_PROOF',
          description: 'Run or repair every declared gate until current-HEAD proof passes.',
          owner_issue: 40,
        },
      );
    }
    if (!repository.clean || repository.branch !== plan.baselineBranch) {
      return deniedGuards(
        {
          code: 'PROOF_CHECKOUT_MISMATCH',
          message: 'Review requires current-HEAD passing proof from a clean checkout on the proof-plan branch.',
          owner_issue: 40,
        },
        {
          code: 'RESTORE_PROOF_CHECKOUT',
          description: 'Restore the clean proof-plan branch while preserving the verified HEAD, then retry.',
          owner_issue: 40,
        },
      );
    }
    if (proof.ciEvidence?.status !== 'passed') {
      return signedCiProofGuard(proof.ciEvidence?.status ?? 'missing');
    }
    return allowedGuards();
  }

  if (from === 'verifying' && to === 'repairing') {
    if (proof.evidence?.status === 'failed' && (proof.attemptsUsed ?? 3) < 3) {
      return allowedGuards();
    }
    const exhausted = (proof.attemptsUsed ?? 3) >= 3;
    return deniedGuards(
      {
        code: exhausted ? 'REPAIR_BUDGET_EXHAUSTED' : 'CURRENT_FAILED_PROOF_REQUIRED',
        message: exhausted
          ? 'No fourth repair cycle is permitted.'
          : 'Repairing requires a current-HEAD nonpassing gate receipt.',
        owner_issue: 40,
      },
      {
        code: exhausted ? 'TRANSITION_TO_BLOCKED' : 'RUN_CURRENT_GATES',
        description: exhausted
          ? 'Provide complete block evidence and explicitly transition the session to blocked.'
          : 'Run the declared gates on the current clean HEAD and retain the failure receipt.',
        owner_issue: 40,
      },
    );
  }

  if (from === 'repairing' && to === 'verifying') {
    if (repository.clean && repository.branch === plan.baselineBranch && repository.committedRepairFromFailure) {
      return allowedGuards();
    }
    return deniedGuards(
      {
        code: 'COMMITTED_REPAIR_REQUIRED',
        message: 'Verification re-entry requires a clean committed repair after the failure HEAD.',
        owner_issue: 40,
      },
      {
        code: 'COMMIT_REPAIR',
        description: 'Commit a repair on the proof-plan branch and clean the worktree before retrying.',
        owner_issue: 40,
      },
    );
  }

  return deferredProofGuards();
}

function signedCiProofGuard(status: CiProofEvidence['status']): TransitionGuardDecision {
  const details = {
    policy_missing: {
      failure: 'CI_PROOF_POLICY_REQUIRED',
      message: 'Review requires an immutable v2 signed-CI trust policy.',
      work: 'START_SESSION_WITH_CI_POLICY',
      description: 'Start a new session with a v2 proof plan; immutable legacy plans cannot be rewritten.',
    },
    missing: {
      failure: 'SIGNED_CI_PROOF_REQUIRED',
      message: 'Review requires a verified signed CI receipt for every declared gate.',
      work: 'IMPORT_SIGNED_CI_PROOF',
      description: 'Run the trusted reusable workflow and import every current-HEAD passing receipt.',
    },
    stale: {
      failure: 'CURRENT_SIGNED_CI_PROOF_REQUIRED',
      message: 'Review requires signed CI proof for the current repository HEAD.',
      work: 'RERUN_AND_IMPORT_CI_PROOF',
      description: 'Rerun the trusted CI gates at the current HEAD and import their signed receipts.',
    },
    corrupt: {
      failure: 'UNCORRUPTED_SIGNED_CI_PROOF_REQUIRED',
      message: 'Stored signed CI proof failed its local integrity checks.',
      work: 'RESTORE_SIGNED_CI_PROOF',
      description: 'Restore the accepted receipt package from trusted storage or rerun and import the CI gate.',
    },
    passed: {
      failure: 'SIGNED_CI_PROOF_REQUIRED',
      message: 'Review requires verified signed CI proof.',
      work: 'IMPORT_SIGNED_CI_PROOF',
      description: 'Import verified signed CI proof.',
    },
  }[status];
  return deniedGuards(
    { code: details.failure, message: details.message, owner_issue: 41 },
    { code: details.work, description: details.description, owner_issue: 41 },
  );
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
  proof?: {
    status: ProofEvidenceStatus;
    attemptsUsed: number;
  };
  proofGuardContext?: ProofGuardContext;
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

  if (input.state === 'verifying' && input.proof) {
    return planVerifyingTransition(input.stateVersion, input.proof, input.proofGuardContext);
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

  const guards = evaluateTransitionGuards(input.state, target, {}, input.blockedFromState, input.proofGuardContext);
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

function planVerifyingTransition(
  stateVersion: number,
  proof: { status: ProofEvidenceStatus; attemptsUsed: number },
  proofGuardContext: ProofGuardContext | undefined,
): PlannedTransition {
  if (proof.status === 'passed') {
    const guards = evaluateTransitionGuards('verifying', 'reviewing', {}, null, proofGuardContext);
    return {
      candidate: {
        from_state: 'verifying',
        target_state: 'reviewing',
        expected_state_version: stateVersion,
        executable: guards.allowed,
      },
      guardFailures: guards.guardFailures,
      requiredWork: guards.requiredWork,
      terminalReason: null,
    };
  }
  if (proof.status === 'failed' && proof.attemptsUsed < 3) {
    return {
      candidate: {
        from_state: 'verifying',
        target_state: 'repairing',
        expected_state_version: stateVersion,
        executable: true,
      },
      guardFailures: [],
      requiredWork: [],
      terminalReason: null,
    };
  }
  if (proof.status === 'failed') {
    return {
      candidate: {
        from_state: 'verifying',
        target_state: 'blocked',
        expected_state_version: stateVersion,
        executable: false,
      },
      guardFailures: [
        {
          code: 'REPAIR_BUDGET_EXHAUSTED',
          message: 'Proof still fails after all three repair cycles.',
          owner_issue: 40,
        },
      ],
      requiredWork: [
        {
          code: 'TRANSITION_TO_BLOCKED',
          description: 'Provide complete block evidence and explicitly transition the session to blocked.',
          owner_issue: 40,
        },
      ],
      terminalReason: null,
    };
  }

  const guidance = {
    missing: {
      code: 'PROOF_GATES_MISSING',
      message: 'One or more declared gates do not have receipts for the current HEAD.',
      workCode: 'RUN_MISSING_GATES',
      description: 'Run every missing declared gate.',
    },
    stale: {
      code: 'PROOF_RECEIPTS_STALE',
      message: 'One or more latest gate receipts belong to another HEAD or proof plan.',
      workCode: 'RERUN_STALE_GATES',
      description: 'Rerun every stale declared gate on the current clean HEAD.',
    },
    corrupt: {
      code: 'PROOF_RECEIPTS_CORRUPT',
      message: 'One or more latest gate receipts or artifacts failed integrity validation.',
      workCode: 'RERUN_CORRUPT_GATES',
      description: 'Restore trusted receipt artifacts or rerun every corrupt declared gate.',
    },
  }[proof.status];
  return {
    candidate: null,
    guardFailures: [{ code: guidance.code, message: guidance.message, owner_issue: 40 }],
    requiredWork: [{ code: guidance.workCode, description: guidance.description, owner_issue: 40 }],
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
