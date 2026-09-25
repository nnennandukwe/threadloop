import { getDeterministicForwardTarget, isForwardLifecycleTransition, REPAIR_BUDGET } from './lifecycle.js';
import { LIFECYCLE_PHASE, TASK_STATUS, type EntrySource, type LifecyclePhase, type TaskStatus } from './types.js';
import { canonicalizeJsonValue, isPlainObject } from './canonical-json.js';
import type { BoundProofPlan } from './proof.js';
import type { ProofEvidence, ProofEvidenceStatus } from './proof.js';
import type { CiProofEvidence } from './attestation.js';
import { hasBlockingReview, hasCurrentHumanApproval, type ReviewEvidence } from './review.js';

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
  owner_issue?: number;
}

export interface TransitionRequiredWork {
  code: string;
  description: string;
  owner_issue?: number;
}

export interface TransitionGuardDecision {
  allowed: boolean;
  guardFailures: TransitionGuardFailure[];
  requiredWork: TransitionRequiredWork[];
}

export type TransitionGuardRequirement = 'none' | 'proof_plan' | 'proof' | 'review';

export type PrePrReviewOutcome = 'changes_required' | 'clean';

export interface PrePrReviewFinding {
  id: string;
  summary: string;
  path: string;
}

export interface PrePrReviewEvidence {
  outcome: PrePrReviewOutcome;
  headSha: string;
  evidenceRef: string;
  evidenceSha256: string;
  findings: PrePrReviewFinding[];
}

export interface ImplementationBasis {
  headSha: string;
  source: 'proof_plan_baseline' | 'failed_local_proof' | 'pre_pr_review';
}

export interface ProofGuardContext {
  boundPlan?: BoundProofPlan;
  plan?: BoundProofPlan | null;
  evidence?: ProofEvidence;
  ciEvidence?: CiProofEvidence;
  reviewEvidence?: ReviewEvidence;
  phase?: LifecyclePhase;
  implementationBasis?: ImplementationBasis | null;
  repository?: {
    branch: string | null;
    headSha: string;
    clean: boolean;
    committedImplementationFromBasis?: boolean;
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
  sourceState: TaskStatus,
  targetState: TaskStatus,
  input: Record<string, unknown>,
  blockedFromState: TaskStatus | null,
  proof: ProofGuardContext = {},
): TransitionGuardDecision {
  if (sourceState === TASK_STATUS.BLOCKED && blockedFromState === null) {
    return deny(
      'BLOCKED_PRIOR_STATE_REQUIRED',
      'A blocked session requires its recorded prior lifecycle state.',
      'RESTORE_BLOCKED_PRIOR_STATE',
      'Restore the durable blocked prior state from verified persistence evidence.',
    );
  }

  const evidence = validateTransitionEvidence(sourceState, targetState, input, proof);
  if (!evidence.allowed) {
    return evidence;
  }

  const requirement = getTransitionGuardRequirement(sourceState, targetState);
  if (requirement === 'none') {
    return allowedGuards();
  }
  if (requirement === 'proof_plan') {
    return proof.boundPlan ? allowedGuards() : evaluateProofOwnedGuards(sourceState, targetState, input, proof);
  }
  if (requirement === 'proof') {
    return evaluateProofOwnedGuards(sourceState, targetState, input, proof);
  }
  return evaluateReviewOwnedGuards(sourceState, targetState, proof);
}

function evaluateReviewOwnedGuards(
  sourceState: TaskStatus,
  targetState: TaskStatus,
  proof: ProofGuardContext,
): TransitionGuardDecision {
  const review = proof.reviewEvidence;
  if (!review || review.status !== 'current' || !review.headSha || review.headSha !== proof.repository?.headSha) {
    const status = review?.status ?? 'missing';
    const details = {
      policy_missing: {
        code: 'REVIEW_PROOF_POLICY_REQUIRED',
        message: 'Review requires an immutable v3 signed-review trust policy.',
        work: 'START_SESSION_WITH_REVIEW_POLICY',
        description: 'Start a new session with a v3 proof plan that binds the review sensor.',
      },
      missing: {
        code: 'SIGNED_REVIEW_PROOF_REQUIRED',
        message: 'Review requires a verified signed review snapshot for the current pull request HEAD.',
        work: 'IMPORT_SIGNED_REVIEW_PROOF',
        description: 'Run the trusted review sensor and import its signed snapshot.',
      },
      stale: {
        code: 'CURRENT_REVIEW_PROOF_REQUIRED',
        message: 'The latest signed review snapshot belongs to another HEAD.',
        work: 'REFRESH_SIGNED_REVIEW_PROOF',
        description: 'Run the review sensor again for the current pull request HEAD.',
      },
      corrupt: {
        code: 'UNCORRUPTED_REVIEW_PROOF_REQUIRED',
        message: 'Stored signed review evidence failed its integrity checks.',
        work: 'RESTORE_SIGNED_REVIEW_PROOF',
        description: 'Restore the accepted package from trusted storage or rerun the review sensor.',
      },
      current: {
        code: 'CURRENT_REVIEW_PROOF_REQUIRED',
        message: 'Signed review evidence does not match the live repository HEAD.',
        work: 'REFRESH_SIGNED_REVIEW_PROOF',
        description: 'Run the review sensor again for the current repository HEAD.',
      },
    }[status];
    return deny(details.code, details.message, details.work, details.description, 42);
  }

  const blocking = hasBlockingReview(review);
  if (targetState === TASK_STATUS.REPAIRING) {
    if (blocking && (proof.attemptsUsed ?? REPAIR_BUDGET) < REPAIR_BUDGET) {
      return allowedGuards();
    }
    const exhausted = (proof.attemptsUsed ?? REPAIR_BUDGET) >= REPAIR_BUDGET;
    return deny(
      exhausted ? 'REPAIR_BUDGET_EXHAUSTED' : 'BLOCKING_REVIEW_FINDING_REQUIRED',
      exhausted ? 'No fourth repair cycle is permitted.' : 'Review repair requires a current blocking review finding.',
      exhausted ? 'TRANSITION_TO_BLOCKED' : 'REFRESH_SIGNED_REVIEW_PROOF',
      exhausted
        ? 'Provide complete block evidence and explicitly transition the session to blocked.'
        : 'Import the latest signed review snapshot before selecting repair.',
      42,
    );
  }

  if (blocking) {
    return deny(
      'BLOCKING_REVIEW_FINDINGS',
      'Current unresolved review findings require a bounded repair cycle.',
      'ENTER_REVIEW_REPAIR',
      'Transition to repairing while budget remains and address the current findings.',
      42,
    );
  }

  if (proof.evidence?.status !== 'passed' || proof.ciEvidence?.status !== 'passed') {
    return deny(
      'CURRENT_REVIEW_PROOF_SET_REQUIRED',
      'Review progression requires current local, signed CI, and signed review proof.',
      'REFRESH_REVIEW_PROOF_SET',
      'Refresh every stale or missing proof source for the current HEAD.',
      42,
    );
  }

  if (sourceState === TASK_STATUS.READY_FOR_HUMAN && targetState === TASK_STATUS.COMPLETED) {
    if (!hasCurrentHumanApproval(review)) {
      return deny(
        'CURRENT_HUMAN_APPROVAL_REQUIRED',
        'Completion requires a non-bot human approval bound to the pull request HEAD.',
        'OBTAIN_CURRENT_HUMAN_APPROVAL',
        'Obtain a human approval on the current pull request HEAD.',
        42,
      );
    }
    if (!review.merged) {
      return deny(
        'OBSERVED_MERGE_REQUIRED',
        'Completion requires the signed review sensor to observe the pull request as merged.',
        'MERGE_AND_REFRESH_REVIEW_PROOF',
        'Merge through human authority, then import a post-merge signed review snapshot.',
        42,
      );
    }
  }

  return allowedGuards();
}

export function getTransitionGuardRequirement(
  sourceState: TaskStatus,
  targetState: TaskStatus,
): TransitionGuardRequirement {
  if (
    targetState === TASK_STATUS.BLOCKED ||
    sourceState === TASK_STATUS.BLOCKED ||
    (sourceState === TASK_STATUS.QUEUED && targetState === TASK_STATUS.FRAMED)
  ) {
    return 'none';
  }
  if (sourceState === TASK_STATUS.FRAMED && targetState === TASK_STATUS.PROOF_READY) {
    return 'proof_plan';
  }
  if (
    sourceState === TASK_STATUS.REVIEWING ||
    sourceState === TASK_STATUS.READY_FOR_HUMAN ||
    targetState === TASK_STATUS.COMPLETED
  ) {
    return 'review';
  }
  return 'proof';
}

export function requiresProofGuardContext(sourceState: TaskStatus, targetState: TaskStatus) {
  return (
    isForwardLifecycleTransition(sourceState, targetState) &&
    getTransitionGuardRequirement(sourceState, targetState) === 'proof'
  );
}

function evaluateProofOwnedGuards(
  sourceState: TaskStatus,
  targetState: TaskStatus,
  input: Record<string, unknown>,
  proof: ProofGuardContext,
): TransitionGuardDecision {
  const plan = proof.plan;
  const repository = proof.repository;
  if (!plan || !repository) {
    return deny(
      'PROOF_PLAN_REQUIRED',
      'This transition requires an immutable proof plan and live repository authority.',
      'RESTORE_PROOF_AUTHORITY',
      'Record or restore the session proof plan, then retry from a clean named branch.',
      40,
    );
  }

  if (sourceState === TASK_STATUS.PROOF_READY && targetState === TASK_STATUS.IMPLEMENTING) {
    if (repository.clean && repository.branch === plan.baselineBranch && repository.headSha === plan.baselineHeadSha) {
      return allowedGuards();
    }
    return deny(
      'PROOF_BASELINE_MISMATCH',
      'The repository no longer matches the clean branch and HEAD bound to the proof plan.',
      'RESTORE_PROOF_BASELINE',
      'Restore the clean proof-plan branch and baseline HEAD before implementation begins.',
      40,
    );
  }

  if (sourceState === TASK_STATUS.IMPLEMENTING && targetState === TASK_STATUS.VERIFYING) {
    if (
      repository.clean &&
      repository.branch === plan.baselineBranch &&
      proof.implementationBasis &&
      repository.headSha !== proof.implementationBasis.headSha &&
      repository.committedImplementationFromBasis
    ) {
      return allowedGuards();
    }
    return deny(
      proof.implementationBasis ? 'IMPLEMENTATION_BASIS_NOT_ADVANCED' : 'COMMITTED_IMPLEMENTATION_REQUIRED',
      proof.implementationBasis
        ? `Live HEAD ${repository.headSha} must be a clean descendant commit after implementation basis ${proof.implementationBasis.headSha}.`
        : 'Verification requires a clean committed diff from an authoritative implementation basis.',
      'COMMIT_IMPLEMENTATION',
      'Agent repository-work authority must create one clean scoped commit after the reported implementation basis, then retry.',
      69,
    );
  }

  if (sourceState === TASK_STATUS.VERIFYING && targetState === TASK_STATUS.IMPLEMENTING) {
    if (proof.phase !== LIFECYCLE_PHASE.PRE_PR) {
      return deny(
        'POST_PR_IMPLEMENTATION_REENTRY_FORBIDDEN',
        'A post-PR session cannot re-enter implementing.',
        'ENTER_REVIEW_REPAIR',
        'The signed-review controller must use the repairing path while post-PR repair budget remains.',
        69,
      );
    }
    if (!repository.clean || repository.branch !== plan.baselineBranch) {
      return deny(
        'PROOF_CHECKOUT_MISMATCH',
        'Pre-PR implementation re-entry requires a clean checkout on the proof-plan branch.',
        'RESTORE_PROOF_CHECKOUT',
        'Restore the clean proof-plan branch at the reviewed or failed HEAD, then retry.',
        69,
      );
    }
    if (proof.evidence?.status === 'failed' || readPrePrReviewEvidence(input)?.outcome === 'changes_required') {
      return allowedGuards();
    }
    return deny(
      'PRE_PR_REVIEW_INPUT_REQUIRED',
      'Pre-PR implementation re-entry requires a current failed gate or current review findings.',
      'RECORD_PRE_PR_REVIEW_OUTCOME',
      'The operator/controller must retry with changes_required pre_pr_review evidence bound to the live HEAD.',
      69,
    );
  }

  if (
    sourceState === TASK_STATUS.VERIFYING &&
    (targetState === TASK_STATUS.PRE_PR_REVIEWING || targetState === TASK_STATUS.REVIEWING)
  ) {
    if (targetState === TASK_STATUS.PRE_PR_REVIEWING && proof.phase !== LIFECYCLE_PHASE.PRE_PR) {
      return deny(
        'POST_PR_IMPLEMENTATION_REENTRY_FORBIDDEN',
        'A post-PR session cannot enter the pre-PR review boundary.',
        'REFRESH_REVIEW_PROOF_SET',
        'Refresh post-PR proof and return to reviewing.',
        69,
      );
    }
    if (targetState === TASK_STATUS.REVIEWING && proof.phase !== LIFECYCLE_PHASE.POST_PR) {
      return deny(
        'PRE_PR_REVIEW_INPUT_REQUIRED',
        'A pre-PR session must enter pre_pr_reviewing before reviewing.',
        'RECORD_PRE_PR_REVIEW_OUTCOME',
        'Enter pre_pr_reviewing, then record a clean current-HEAD pre-PR review outcome.',
        69,
      );
    }
    if (proof.evidence?.status !== 'passed') {
      return deny(
        'CURRENT_PASSING_PROOF_REQUIRED',
        'Review requires every latest declared gate receipt to pass for the current HEAD.',
        'COMPLETE_CURRENT_PROOF',
        'Run or repair every declared gate until current-HEAD proof passes.',
        40,
      );
    }
    if (!repository.clean || repository.branch !== plan.baselineBranch) {
      return deny(
        'PROOF_CHECKOUT_MISMATCH',
        'Review requires current-HEAD passing proof from a clean checkout on the proof-plan branch.',
        'RESTORE_PROOF_CHECKOUT',
        'Restore the clean proof-plan branch while preserving the verified HEAD, then retry.',
        40,
      );
    }
    if (proof.ciEvidence?.status !== 'passed') {
      return signedCiProofGuard(proof.ciEvidence?.status ?? 'missing');
    }
    return allowedGuards();
  }

  if (sourceState === TASK_STATUS.PRE_PR_REVIEWING && targetState === TASK_STATUS.IMPLEMENTING) {
    if (
      proof.phase === LIFECYCLE_PHASE.PRE_PR &&
      repository.clean &&
      repository.branch === plan.baselineBranch &&
      readPrePrReviewEvidence(input)?.outcome === 'changes_required'
    ) {
      return allowedGuards();
    }
    return deny(
      'PRE_PR_REVIEW_INPUT_REQUIRED',
      'Pre-PR review remediation requires current changes_required evidence on a clean proof-plan branch.',
      'RECORD_PRE_PR_REVIEW_OUTCOME',
      'The operator/controller must record current-HEAD changes_required evidence, then retry the implementing transition.',
      69,
    );
  }

  if (sourceState === TASK_STATUS.PRE_PR_REVIEWING && targetState === TASK_STATUS.REVIEWING) {
    if (proof.phase !== LIFECYCLE_PHASE.PRE_PR || readPrePrReviewEvidence(input)?.outcome !== 'clean') {
      return deny(
        'PRE_PR_REVIEW_INPUT_REQUIRED',
        'Entering reviewing requires a clean current-HEAD pre-PR review outcome.',
        'RECORD_PRE_PR_REVIEW_OUTCOME',
        'The operator/controller must record a clean pre_pr_review outcome for the live HEAD.',
        69,
      );
    }
    if (
      proof.evidence?.status !== 'passed' ||
      proof.ciEvidence?.status !== 'passed' ||
      !repository.clean ||
      repository.branch !== plan.baselineBranch
    ) {
      return deny(
        'CURRENT_REVIEW_PROOF_SET_REQUIRED',
        'Pre-PR clearance requires current local and signed CI proof from the clean proof-plan branch.',
        'REFRESH_REVIEW_PROOF_SET',
        'Refresh local and signed CI proof for the live HEAD before entering reviewing.',
        69,
      );
    }
    return allowedGuards();
  }

  if (sourceState === TASK_STATUS.VERIFYING && targetState === TASK_STATUS.REPAIRING) {
    if (proof.phase !== LIFECYCLE_PHASE.POST_PR) {
      return deny(
        'CURRENT_FAILED_PROOF_REQUIRED',
        'Pre-PR gate failures return to implementing and do not enter repairing.',
        'COMMIT_IMPLEMENTATION',
        'Transition to implementing without consuming repair budget, then create one scoped commit.',
        69,
      );
    }
    if (proof.evidence?.status === 'failed' && (proof.attemptsUsed ?? REPAIR_BUDGET) < REPAIR_BUDGET) {
      return allowedGuards();
    }
    const exhausted = (proof.attemptsUsed ?? REPAIR_BUDGET) >= REPAIR_BUDGET;
    return deny(
      exhausted ? 'REPAIR_BUDGET_EXHAUSTED' : 'CURRENT_FAILED_PROOF_REQUIRED',
      exhausted ? 'No fourth repair cycle is permitted.' : 'Repairing requires a current-HEAD nonpassing gate receipt.',
      exhausted ? 'TRANSITION_TO_BLOCKED' : 'RUN_CURRENT_GATES',
      exhausted
        ? 'Provide complete block evidence and explicitly transition the session to blocked.'
        : 'Run the declared gates on the current clean HEAD and retain the failure receipt.',
      40,
    );
  }

  if (sourceState === TASK_STATUS.REPAIRING && targetState === TASK_STATUS.VERIFYING) {
    if (repository.clean && repository.branch === plan.baselineBranch && repository.committedRepairFromFailure) {
      return allowedGuards();
    }
    return deny(
      'COMMITTED_REPAIR_REQUIRED',
      'Verification re-entry requires a clean committed repair after the failure HEAD.',
      'COMMIT_REPAIR',
      'Commit a repair on the proof-plan branch and clean the worktree before retrying.',
      40,
    );
  }

  return deferredProofGuards();
}

function signedCiProofGuard(status: CiProofEvidence['status']): TransitionGuardDecision {
  const details = {
    policy_missing: {
      failure: 'CI_PROOF_POLICY_REQUIRED',
      message: 'Review requires an immutable v2 or v3 signed-CI trust policy.',
      work: 'START_SESSION_WITH_CI_POLICY',
      description: 'Start a new session with a v3 proof plan; immutable legacy plans cannot be rewritten.',
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
  return deny(details.failure, details.message, details.work, details.description, 41);
}

export function validateTransitionEvidence(
  sourceState: TaskStatus,
  targetState: TaskStatus,
  input: Record<string, unknown>,
  proof: ProofGuardContext = {},
): TransitionGuardDecision {
  if (
    targetState === TASK_STATUS.BLOCKED &&
    !hasRequiredTextFields(input.block, ['reason', 'evidence_ref', 'recovery', 'stop_code'])
  ) {
    return deny(
      'BLOCK_EVIDENCE_REQUIRED',
      'Entering blocked requires reason, evidence_ref, recovery, and stop_code.',
      'PROVIDE_BLOCK_EVIDENCE',
      'Provide complete block evidence without changing the prior lifecycle state.',
    );
  }
  if (
    sourceState === TASK_STATUS.BLOCKED &&
    !hasRequiredTextFields(input.recovery, ['approved_by', 'evidence_ref', 'reason'])
  ) {
    return deny(
      'RECOVERY_EVIDENCE_REQUIRED',
      'Recovering from blocked requires approved_by, evidence_ref, and reason.',
      'PROVIDE_RECOVERY_EVIDENCE',
      'Provide explicit human recovery approval and durable recovery evidence.',
    );
  }

  const prePrReview = readPrePrReviewEvidence(input);
  const suppliedPrePrReview = Object.hasOwn(input, 'pre_pr_review');
  const requiresPrePrReview =
    (sourceState === TASK_STATUS.PRE_PR_REVIEWING &&
      (targetState === TASK_STATUS.IMPLEMENTING || targetState === TASK_STATUS.REVIEWING)) ||
    (sourceState === TASK_STATUS.VERIFYING &&
      targetState === TASK_STATUS.IMPLEMENTING &&
      proof.evidence?.status !== 'failed');

  if (suppliedPrePrReview && !prePrReview) {
    return deny(
      'PRE_PR_REVIEW_FINDINGS_INVALID',
      'pre_pr_review must contain a valid outcome, live 40-character HEAD, evidence reference, SHA-256 digest, and unique normalized findings.',
      'RECORD_PRE_PR_REVIEW_OUTCOME',
      'The operator/controller must correct the pre_pr_review object and retry without changing lifecycle state.',
      69,
    );
  }

  if (requiresPrePrReview && !prePrReview) {
    return deny(
      'PRE_PR_REVIEW_INPUT_REQUIRED',
      `Lifecycle transition ${sourceState} -> ${targetState} requires pre_pr_review evidence.`,
      'RECORD_PRE_PR_REVIEW_OUTCOME',
      'The operator/controller must provide a canonical pre_pr_review object bound to the live repository HEAD.',
      69,
    );
  }

  if (prePrReview) {
    const isPrePrReviewTransition =
      (sourceState === TASK_STATUS.VERIFYING && targetState === TASK_STATUS.IMPLEMENTING) ||
      (sourceState === TASK_STATUS.PRE_PR_REVIEWING &&
        (targetState === TASK_STATUS.IMPLEMENTING || targetState === TASK_STATUS.REVIEWING));
    if (!isPrePrReviewTransition) {
      return deny(
        'PRE_PR_REVIEW_FINDINGS_INVALID',
        `pre_pr_review evidence is not accepted for ${sourceState} -> ${targetState}.`,
        'RECORD_PRE_PR_REVIEW_OUTCOME',
        'The operator/controller must remove pre_pr_review evidence or select the matching pre-PR transition.',
        69,
      );
    }

    if (prePrReview.headSha !== proof.repository?.headSha) {
      return deny(
        'PRE_PR_REVIEW_HEAD_MISMATCH',
        `Pre-PR review HEAD ${prePrReview.headSha} does not match live HEAD ${proof.repository?.headSha ?? '(unavailable)'}.`,
        'RECORD_PRE_PR_REVIEW_OUTCOME',
        'The operator/controller must review the live HEAD and retry with evidence bound to that exact commit.',
        69,
      );
    }

    const expectedOutcome =
      targetState === TASK_STATUS.IMPLEMENTING
        ? 'changes_required'
        : sourceState === TASK_STATUS.PRE_PR_REVIEWING && targetState === TASK_STATUS.REVIEWING
          ? 'clean'
          : null;
    if (expectedOutcome && prePrReview.outcome !== expectedOutcome) {
      return deny(
        'PRE_PR_REVIEW_FINDINGS_INVALID',
        `${sourceState} -> ${targetState} requires pre_pr_review outcome ${expectedOutcome}.`,
        'RECORD_PRE_PR_REVIEW_OUTCOME',
        `The operator/controller must retry with a ${expectedOutcome} outcome that matches the requested transition.`,
        69,
      );
    }
  }

  return allowedGuards();
}

export function readPrePrReviewEvidence(input: Record<string, unknown>): PrePrReviewEvidence | null {
  const value = input.pre_pr_review;
  if (!isPlainObject(value)) {
    return null;
  }
  if (value.outcome !== 'changes_required' && value.outcome !== 'clean') {
    return null;
  }
  if (
    !isNormalizedText(value.head_sha) ||
    !/^[0-9a-f]{40}$/.test(value.head_sha) ||
    !isNormalizedText(value.evidence_ref) ||
    !isNormalizedText(value.evidence_sha256) ||
    !/^[0-9a-f]{64}$/.test(value.evidence_sha256) ||
    !Array.isArray(value.findings)
  ) {
    return null;
  }

  const findings: PrePrReviewFinding[] = [];
  const findingIds = new Set<string>();
  for (const candidate of value.findings) {
    if (
      !isPlainObject(candidate) ||
      !isNormalizedText(candidate.id) ||
      !isNormalizedText(candidate.summary) ||
      !isNormalizedText(candidate.path) ||
      findingIds.has(candidate.id)
    ) {
      return null;
    }
    findingIds.add(candidate.id);
    findings.push({
      id: candidate.id,
      summary: candidate.summary,
      path: candidate.path,
    });
  }

  if (
    (value.outcome === 'changes_required' && findings.length === 0) ||
    (value.outcome === 'clean' && findings.length !== 0)
  ) {
    return null;
  }

  return {
    outcome: value.outcome,
    headSha: value.head_sha,
    evidenceRef: value.evidence_ref,
    evidenceSha256: value.evidence_sha256,
    findings,
  };
}

export function planNextTransition(input: {
  state: TaskStatus;
  stateVersion: number;
  blockedFromState: TaskStatus | null;
  phase?: LifecyclePhase;
  proof?: {
    status: ProofEvidenceStatus;
    attemptsUsed: number;
  };
  proofGuardContext?: ProofGuardContext;
}): PlannedTransition {
  if (input.state === TASK_STATUS.COMPLETED) {
    return {
      candidate: null,
      guardFailures: [],
      requiredWork: [],
      terminalReason: 'COMPLETED',
    };
  }

  if (input.state === TASK_STATUS.BLOCKED) {
    const target = input.blockedFromState;
    return {
      candidate: target
        ? {
            from_state: TASK_STATUS.BLOCKED,
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

  if (input.state === TASK_STATUS.VERIFYING && input.proof) {
    return planVerifyingTransition(
      input.stateVersion,
      input.phase ?? LIFECYCLE_PHASE.PRE_PR,
      input.proof,
      input.proofGuardContext,
    );
  }

  if (input.state === TASK_STATUS.PRE_PR_REVIEWING) {
    return {
      candidate: null,
      guardFailures: [
        {
          code: 'PRE_PR_REVIEW_OUTCOME_REQUIRED',
          message: 'A current-HEAD pre-PR review outcome is required before lifecycle progression.',
          owner_issue: 69,
        },
      ],
      requiredWork: [
        {
          code: 'RECORD_PRE_PR_REVIEW_OUTCOME',
          description:
            'The operator/controller must explicitly transition to implementing with changes_required evidence or reviewing with clean evidence.',
          owner_issue: 69,
        },
      ],
      terminalReason: null,
    };
  }

  if (input.state === TASK_STATUS.REVIEWING || input.state === TASK_STATUS.READY_FOR_HUMAN) {
    const review = input.proofGuardContext?.reviewEvidence;
    const target =
      review?.status === 'current' && hasBlockingReview(review)
        ? TASK_STATUS.REPAIRING
        : input.state === TASK_STATUS.REVIEWING
          ? TASK_STATUS.READY_FOR_HUMAN
          : TASK_STATUS.COMPLETED;
    return candidate(
      input.state,
      target,
      input.stateVersion,
      evaluateTransitionGuards(input.state, target, {}, input.blockedFromState, input.proofGuardContext),
    );
  }

  const target = getDeterministicForwardTarget(input.state);
  if (!target) {
    const guards = deferredProofGuards();
    return {
      candidate: null,
      guardFailures: guards.guardFailures,
      requiredWork: guards.requiredWork,
      terminalReason: null,
    };
  }

  return candidate(
    input.state,
    target,
    input.stateVersion,
    evaluateTransitionGuards(input.state, target, {}, input.blockedFromState, input.proofGuardContext),
  );
}

function planVerifyingTransition(
  stateVersion: number,
  phase: LifecyclePhase,
  proof: { status: ProofEvidenceStatus; attemptsUsed: number },
  proofGuardContext: ProofGuardContext | undefined,
): PlannedTransition {
  const phaseAwareGuardContext = { ...proofGuardContext, phase };
  const planFromVerifying = (target: TaskStatus) =>
    candidate(
      TASK_STATUS.VERIFYING,
      target,
      stateVersion,
      evaluateTransitionGuards(TASK_STATUS.VERIFYING, target, {}, null, phaseAwareGuardContext),
    );
  if (proof.status === 'passed') {
    return planFromVerifying(phase === LIFECYCLE_PHASE.PRE_PR ? TASK_STATUS.PRE_PR_REVIEWING : TASK_STATUS.REVIEWING);
  }
  if (proof.status === 'failed' && phase === LIFECYCLE_PHASE.PRE_PR) {
    return planFromVerifying(TASK_STATUS.IMPLEMENTING);
  }
  // Evaluated like every other candidate, so `session next` never offers a repair the apply step would refuse
  // for missing plan or repository authority.
  if (proof.status === 'failed' && proof.attemptsUsed < REPAIR_BUDGET) {
    return planFromVerifying(TASK_STATUS.REPAIRING);
  }
  if (proof.status === 'failed') {
    return {
      candidate: {
        from_state: TASK_STATUS.VERIFYING,
        target_state: TASK_STATUS.BLOCKED,
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
    // Deliberately not routed through the `failed` branch above: a toolchain that would not provision is a
    // configuration problem, so it produces an operator handoff and consumes no repair budget.
    setup_failed: {
      code: 'PROOF_GATE_SETUP_FAILED',
      message: 'One or more declared gates could not provision their toolchain, so the gate command never ran.',
      workCode: 'CORRECT_GATE_SETUP',
      description:
        'Correct the declared setup steps for every failing gate. A bound proof plan is immutable, so start a new session to adopt the corrected declaration.',
    },
  }[proof.status];
  return {
    candidate: null,
    guardFailures: [{ code: guidance.code, message: guidance.message, owner_issue: 40 }],
    requiredWork: [{ code: guidance.workCode, description: guidance.description, owner_issue: 40 }],
    terminalReason: null,
  };
}

/** The codes are part of the runner's closed code set, so they are kept even though the guard is generic. */
function deferredProofGuards(): TransitionGuardDecision {
  return deny(
    'PROOF_AUTHORITY_DEFERRED',
    'No proof-owned guard can authorize this transition from the available evidence.',
    'IMPLEMENT_ISSUE_40',
    'Provide authoritative proof-plan, gate, staleness, and repair-budget evidence.',
    40,
  );
}

function allowedGuards(): TransitionGuardDecision {
  return { allowed: true, guardFailures: [], requiredWork: [] };
}

/** One guard failure and the work that clears it, both attributed to the issue that owns the guard. */
function deny(
  code: string,
  message: string,
  work: string,
  description: string,
  ownerIssue?: number,
): TransitionGuardDecision {
  const owner = ownerIssue === undefined ? {} : { owner_issue: ownerIssue };
  return {
    allowed: false,
    guardFailures: [{ code, message, ...owner }],
    requiredWork: [{ code: work, description, ...owner }],
  };
}

function candidate(
  fromState: TaskStatus,
  targetState: TaskStatus,
  expectedStateVersion: number,
  guards: TransitionGuardDecision,
): PlannedTransition {
  return {
    candidate: {
      from_state: fromState,
      target_state: targetState,
      expected_state_version: expectedStateVersion,
      executable: guards.allowed,
    },
    guardFailures: guards.guardFailures,
    requiredWork: guards.requiredWork,
    terminalReason: null,
  };
}

function hasRequiredTextFields(value: unknown, fields: string[]) {
  if (!isPlainObject(value)) {
    return false;
  }

  return fields.every((field) => typeof value[field] === 'string' && value[field].trim().length > 0);
}

function isNormalizedText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    !Array.from(value).some(isDisallowedTextCharacter)
  );
}

function isDisallowedTextCharacter(character: string) {
  const codePoint = character.codePointAt(0);
  return (
    codePoint !== undefined &&
    (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || codePoint === 0x2028 || codePoint === 0x2029)
  );
}
