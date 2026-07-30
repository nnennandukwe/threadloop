---
name: threadloop-runner
description:
  Run one fail-closed ThreadLoop v4 action for an explicitly identified scheduled wake in a dedicated Git worktree. Use
  when a scheduler delivers an explicit repo_root, session_id, wake_id, and mode and exactly one serialized wake must
  run - to run a scheduler wake, advance or step a ThreadLoop session, apply one ThreadLoop lifecycle transition, run
  one ThreadLoop gate, or execute one queued ThreadLoop task in its own worktree.
---

# ThreadLoop Runner

Use this skill for one serialized scheduler wake. ThreadLoop owns lifecycle state, guards, proof, review evidence, and
the repair budget. The scheduler owns wake uniqueness, serialization, and assignment of one dedicated worktree.

A wake may do exactly one of these:

- apply one executable ThreadLoop transition;
- perform one bounded repository action named by `required_work`;
- run one local gate named by the validated projection; or
- stop without mutation and hand off.

After any transition, repository action, or gate action, stop. Do not select a second action from the result.

## Required inputs

Require exactly these four explicit inputs:

- `repo_root`: canonical absolute path of the dedicated Git worktree;
- `session_id`: exact non-empty ThreadLoop session id;
- `wake_id`: 1-64 characters matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`; and
- `mode`: exactly `normal` or `replay`.

Reject leading or trailing whitespace and NUL or newline characters. Do not infer an input from `PWD`, environment
variables, a prior wake, the current branch, or `threadloop session list`.

Both modes select at most one fresh action from a validated snapshot. `replay` records scheduler intent; it does not
select a fixture, package, sensor, or evidence source. Mode does not change lifecycle authority.

## Scheduler-retained wake record

Before an action starts, the scheduler must retain one record keyed by exact `(repo_root, session_id, wake_id)`. This
record is external to ThreadLoop and does not add a fifth runner input. Retain every field in
[references/wake-record.md](references/wake-record.md).

For a transition, retain the exact source, target, expected version, actor, input JSON bytes, and idempotency key. Write
the selected action and request before marking `action_started: true`. Scheduler serialization must prevent two
deliveries from both observing an absent record. If a duplicate delivery lacks a complete record, stop.

## Authority boundary

Never push, force-push, create a pull request, approve, merge, deploy, publish, rotate secrets, activate or replace
policy, or recover a blocked session. Never switch branches, rebase, reset, clean, stash, discard changes, or create or
delete a worktree.

One explicit ThreadLoop session must remain bound to one dedicated worktree. Only the scheduler can establish and
serialize that assignment.

## Wake procedure

### 1. Validate inputs

Validate all four inputs before any ThreadLoop command. Require `repo_root` to be an existing absolute directory whose
bytes equal its filesystem `realpath`. Reject `~`, relative paths, and symlink aliases. Pass each input as one exact
argument; do not construct an interpolated shell command.

### 2. Snapshot Git

Run only these read-only observations with the explicit root:

```text
git -C <repo_root> rev-parse --show-toplevel
git -C <repo_root> symbolic-ref --quiet --short HEAD
git -C <repo_root> rev-parse --verify --end-of-options HEAD^{commit}
git -C <repo_root> --no-optional-locks status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none
git -C <repo_root> worktree list --porcelain
```

Require an exact root and worktree entry, a named branch, a commit HEAD, and an empty status. Retain
`(repo_root, branch, head_sha, clean=true)`. Preserve and stop on any mismatch; do not repair the checkout.

### 3. Verify protocol v4

Run `threadloop protocol --json` from exactly `repo_root`. Require:

```text
ok = true
command = "protocol"
data.contractVersions.protocol = 4
data.contractVersions.proofPlan = 3
data.contractVersions.sessionNext = 4
data.contractVersions.handoff = 3
```

Unknown, missing, differently typed, or different versions fail closed.

### 4. Use the migration-safe read first

Run:

```text
threadloop session next --session <session_id> --json
```

Require `ok: true`, `command: "session next"`, `data.contract_version: 4`, and an exact session id. Before any normal
session read, require:

```text
data.lifecycle.storage_schema_version = 7
data.lifecycle.contract_status = "current"
```

Stop when the lifecycle contract or any proof, staleness, repair-budget, or audit status is `migration_required`.
`SESSION_SCHEMA_MIGRATION_REQUIRED -> MIGRATE_SESSION_SCHEMA` is a recognized external-operator handoff. The runner must
not invoke `threadloop init` or otherwise migrate the repository.

### 5. Validate session status

Run `threadloop session status --session <session_id> --json`. Require exact session id, a non-null task, matching task
id, non-empty title and goal, string-or-null issue reference, known task state, and non-negative safe state version.
These task fields define repository-work scope. Stored session Git fields are not live Git authority.

### 6. Validate a fresh session-next v4 projection

Run session next again and require it to match the retained session and Git snapshots. Validate:

- lifecycle state/version match session status;
- `lifecycle.phase` is `pre_pr` or `post_pr`;
- schema is `7` and contract status is `current`;
- candidate is null or has known source/target, matching source/version, and boolean `executable`;
- repository branch, HEAD, and clean status exactly match the Git snapshot;
- repair limit is `3` and status, counts, remaining count, and exhausted flag agree;
- `pre_pr_review.status`, implementation basis, proof, CI, signed review, staleness, and audit values are known;
- audit status is `valid`; and
- guard and work arrays are both empty or contain one known matching pair.

Lifecycle states:

```text
queued
framed
proof_ready
implementing
verifying
pre_pr_reviewing
reviewing
repairing
ready_for_human
blocked
completed
```

Status allowlists:

- `proof.status` and gate statuses: `missing`, `passed`, `failed`, `stale`, `corrupt`; top-level proof also permits
  `migration_required`;
- `ci_proof.status`: `policy_missing`, `missing`, `passed`, `stale`, `corrupt`;
- `review.status`: `policy_missing`, `missing`, `current`, `stale`, `corrupt`;
- `pre_pr_review.status`: `not_started`, `review_required`, `changes_required`, `cleared`, `stale`,
  `migration_required`;
- `staleness.status`: `current`, `missing`, `stale`, `corrupt`, `migration_required`;
- `repair_budget.status`: `available`, `exhausted`, `migration_required`;
- `audit.status`: `valid`, `corrupt`, `migration_required`.

Known guard/work pairs include:

```text
BLOCKED_PRIOR_STATE_REQUIRED -> RESTORE_BLOCKED_PRIOR_STATE
BLOCKING_REVIEW_FINDING_REQUIRED -> REFRESH_SIGNED_REVIEW_PROOF
BLOCKING_REVIEW_FINDINGS -> ENTER_REVIEW_REPAIR
BLOCK_EVIDENCE_REQUIRED -> PROVIDE_BLOCK_EVIDENCE
CI_PROOF_POLICY_REQUIRED -> START_SESSION_WITH_CI_POLICY
COMMITTED_IMPLEMENTATION_REQUIRED -> COMMIT_IMPLEMENTATION
IMPLEMENTATION_BASIS_NOT_ADVANCED -> COMMIT_IMPLEMENTATION
COMMITTED_REPAIR_REQUIRED -> COMMIT_REPAIR
CURRENT_FAILED_PROOF_REQUIRED -> RUN_CURRENT_GATES
CURRENT_FAILED_PROOF_REQUIRED -> COMMIT_IMPLEMENTATION
CURRENT_HUMAN_APPROVAL_REQUIRED -> OBTAIN_CURRENT_HUMAN_APPROVAL
CURRENT_PASSING_PROOF_REQUIRED -> COMPLETE_CURRENT_PROOF
CURRENT_REVIEW_PROOF_REQUIRED -> REFRESH_SIGNED_REVIEW_PROOF
CURRENT_REVIEW_PROOF_SET_REQUIRED -> REFRESH_REVIEW_PROOF_SET
CURRENT_SIGNED_CI_PROOF_REQUIRED -> RERUN_AND_IMPORT_CI_PROOF
OBSERVED_MERGE_REQUIRED -> MERGE_AND_REFRESH_REVIEW_PROOF
POST_PR_IMPLEMENTATION_REENTRY_FORBIDDEN -> ENTER_REVIEW_REPAIR
PRE_PR_REVIEW_FINDINGS_INVALID -> RECORD_PRE_PR_REVIEW_OUTCOME
PRE_PR_REVIEW_HEAD_MISMATCH -> RECORD_PRE_PR_REVIEW_OUTCOME
PRE_PR_REVIEW_INPUT_REQUIRED -> RECORD_PRE_PR_REVIEW_OUTCOME
PRE_PR_REVIEW_OUTCOME_REQUIRED -> RECORD_PRE_PR_REVIEW_OUTCOME
PROOF_AUTHORITY_DEFERRED -> IMPLEMENT_ISSUE_40
PROOF_BASELINE_BRANCH_REQUIRED -> PREPARE_CLEAN_PROOF_BASELINE
PROOF_BASELINE_DIRTY -> PREPARE_CLEAN_PROOF_BASELINE
PROOF_BASELINE_MISMATCH -> RESTORE_PROOF_BASELINE
PROOF_CHECKOUT_MISMATCH -> RESTORE_PROOF_CHECKOUT
PROOF_GATES_MISSING -> RUN_MISSING_GATES
PROOF_PLAN_REQUIRED -> RESTORE_PROOF_AUTHORITY
PROOF_RECEIPTS_CORRUPT -> RERUN_CORRUPT_GATES
PROOF_RECEIPTS_STALE -> RERUN_STALE_GATES
RECOVERY_EVIDENCE_REQUIRED -> PROVIDE_RECOVERY_EVIDENCE
REPAIR_BUDGET_EXHAUSTED -> TRANSITION_TO_BLOCKED
REVIEW_PROOF_POLICY_REQUIRED -> START_SESSION_WITH_REVIEW_POLICY
SESSION_SCHEMA_MIGRATION_REQUIRED -> MIGRATE_SESSION_SCHEMA
SIGNED_CI_PROOF_REQUIRED -> IMPORT_SIGNED_CI_PROOF
SIGNED_REVIEW_PROOF_REQUIRED -> IMPORT_SIGNED_REVIEW_PROOF
UNCORRUPTED_REVIEW_PROOF_REQUIRED -> RESTORE_SIGNED_REVIEW_PROOF
UNCORRUPTED_SIGNED_CI_PROOF_REQUIRED -> RESTORE_SIGNED_CI_PROOF
```

The only terminal reasons are null, `BLOCKED_REQUIRES_HUMAN_RECOVERY`, and `COMPLETED`. Validate `next_human_action` as
null, the sole required-work item, or `ADVANCE_TO_HUMAN_AUTHORITY` for executable `reviewing -> ready_for_human`. Any
unknown value or inconsistent projection fails closed.

### 7. Resolve duplicates before fresh stop policy

An existing wake never selects a fresh action.

- If no action started, report that and stop.
- A definitive success or failure is final.
- An ambiguous transition may retry only the exact retained request.
- Repository and gate actions are never replayed.

Before an ambiguous transition retry, require the same tuple, mode, canonical root, named branch, HEAD, clean status,
source, target, expected version, actor `agent`, input bytes `{}`, and key
`runner:v1:<wake_id>:<expected_state_version>`. Require the retained candidate to have been executable with empty
guard/work arrays. Any drift stops the retry. Idempotency does not authorize a retry across Git snapshot drift.

### 8. Apply stop policy

For a fresh wake, stop before candidate or required-work handling when:

1. lifecycle state is `ready_for_human`;
2. lifecycle state is `blocked`;
3. lifecycle state is `completed`; or
4. a candidate targets `blocked` or `completed`.

Repair-budget exhaustion alone is not a stop: a third authorized `repairing` wake must still be able to commit its
repair, return to `verifying`, refresh proof, and progress without entering a fourth repair. A projected
`REPAIR_BUDGET_EXHAUSTED -> TRANSITION_TO_BLOCKED` handoff stops an attempted fourth repair entry. An exhausted
historical repair budget does not stop pre-PR implementation work. Blocking, recovery, approval, merge, completion, and
budget override remain human/controller authority.

### 9. Select one action

Prefer one executable candidate over required work. It is valid only with empty guard/work arrays. Otherwise require
exactly one known required-work item. Zero or multiple items stop.

## Transition action

An autonomous transition is allowed only from a validated executable candidate that requires literal input bytes `{}`.
Review outcome transitions are never synthesized by this runner.

Use:

```text
threadloop session transition <target_state> \
  --session <session_id> \
  --expected-state-version <expected_state_version> \
  --idempotency-key runner:v1:<wake_id>:<expected_state_version> \
  --actor agent \
  --input '{}' \
  --json
```

Retain the exact request before invocation. Validate the success response against every request field and require the
state version to increase by one. Stop immediately.

Retry only an ambiguous transition or `STATE_BUSY`, with the byte-identical retained request. Stop on
`STATE_VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `TRANSITION_GUARD_FAILED`, `TRANSITION_NOT_ALLOWED`,
`STATE_CORRUPTED`, audit errors, or unknown errors. Never mint a different key or select new work in that wake.

## Repository work

Only these codes authorize repository work:

```text
COMMIT_IMPLEMENTATION
COMMIT_REPAIR
```

`COMMIT_IMPLEMENTATION` may recur across any number of serialized pre-PR `implementing` wakes. Each wake may edit
task-scoped files, run focused non-ThreadLoop checks, and create at most one clean scoped commit. It may not run a
ThreadLoop gate or transition in the same wake.

`COMMIT_REPAIR` is valid only in post-PR `repairing` with signed-review or failed-gate repair authority. Use the
complete current signed blocking-finding set when review owns the repair. Never treat pre-PR findings as signed-review
receipts or consume repair budget for pre-PR work.

If one coherent clean commit cannot finish the action, preserve the files and stop. Never discard partial work.

## Local gate work

The local gate codes are:

```text
COMPLETE_CURRENT_PROOF
RUN_CURRENT_GATES
RUN_MISSING_GATES
RERUN_STALE_GATES
RERUN_CORRUPT_GATES
```

Select the first matching unique projected gate and run only:

```text
threadloop session gate run <gate_id> --session <session_id> --json
```

Never override command, argv, working directory, timeout, or environment. A gate run is not idempotent. Stop after one
invocation, whether it passes or fails.

## Stop-only handoffs

Review input, signed evidence, migration, policy, blocking, recovery, approval, merge, and controller operations are
recognized but never autonomous:

```text
RECORD_PRE_PR_REVIEW_OUTCOME
MIGRATE_SESSION_SCHEMA
IMPORT_SIGNED_CI_PROOF
RERUN_AND_IMPORT_CI_PROOF
RESTORE_SIGNED_CI_PROOF
IMPORT_SIGNED_REVIEW_PROOF
REFRESH_SIGNED_REVIEW_PROOF
RESTORE_SIGNED_REVIEW_PROOF
REFRESH_REVIEW_PROOF_SET
RESTORE_BLOCKED_PRIOR_STATE
START_SESSION_WITH_REVIEW_POLICY
ENTER_REVIEW_REPAIR
TRANSITION_TO_BLOCKED
OBTAIN_CURRENT_HUMAN_APPROVAL
MERGE_AND_REFRESH_REVIEW_PROOF
RESTORE_PROOF_AUTHORITY
RESTORE_PROOF_BASELINE
RESTORE_PROOF_CHECKOUT
START_SESSION_WITH_CI_POLICY
PROVIDE_BLOCK_EVIDENCE
PROVIDE_RECOVERY_EVIDENCE
IMPLEMENT_ISSUE_40
PREPARE_CLEAN_PROOF_BASELINE
```

For `RECORD_PRE_PR_REVIEW_OUTCOME`, retain the phase, live HEAD, state/version, and exact required work, then hand off
to the operator/controller. Do not accept review evidence as a fifth wake input. A later wake re-reads persisted
evidence.

All unknown codes fail closed.

## Crash rules

- Before action start: report no action started; a new wake may use a fresh snapshot.
- Unknown transition result: retry only the exact retained request after snapshot equality.
- After transition commit: an exact retry returns the stored idempotent result.
- During repository work: preserve files; a dirty duplicate preflight stops and never repeats work.
- During or after a gate: never replay it.
- At review, signed-evidence, or migration handoff: start no action.
- After any success or failure: select no second action.

## Handoff

Return every field in [references/handoff.md](references/handoff.md).

Never report a draft, attempted action, local check, handoff, approval observation, or planned artifact as completed
proof, review, merge, deployment, or publication.
