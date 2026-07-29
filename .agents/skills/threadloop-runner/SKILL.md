---
name: threadloop-runner
description:
  Run one fail-closed ThreadLoop v3 action for an explicitly identified scheduled wake in a dedicated Git worktree.
---

# ThreadLoop Runner

Use this skill as the external procedure for one scheduled Codex wake. ThreadLoop remains the authority for lifecycle
state, guards, proof, review evidence, and repair budget. The scheduler remains the authority for wake uniqueness,
serialization, and assignment of one dedicated worktree.

A wake may do exactly one of these:

- apply one executable ThreadLoop transition;
- perform one bounded repository action named by `required_work`;
- run one local gate whose id is present in the validated projection; or
- stop without mutation and hand off.

After any transition or required-work action, stop. Do not use its result to select another action in the same wake.

## Required inputs

Require all four inputs explicitly:

- `repo_root`: the canonical absolute path of the dedicated Git worktree;
- `session_id`: the exact non-empty ThreadLoop session id;
- `wake_id`: 1-64 characters matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`; and
- `mode`: exactly `normal` or `replay`.

Reject leading or trailing whitespace and NUL or newline characters in any input. Do not read `PWD`, environment
variables, a prior shell directory, a recent session, the current branch, or conversation guesswork to fill a missing
input. Do not auto-select a session with `threadloop session list`.

Both modes select at most one fresh action from a validated snapshot. `replay` records scheduler intent but does not
locate or select a fixture, package, sensor invocation, or evidence source. An external controller prepares any replay
scenario and signed evidence outside the wake. Mode changes neither lifecycle authority nor action selection.

An ambiguous transition retry retains the same `wake_id`, the same `mode`, and the exact request. Do not turn a
duplicate delivery into a new wake or switch its mode. Once any non-transition action has started for a wake, a
duplicate delivery reports or inspects that outcome but never repeats the action.

### Scheduler-retained wake record

The four wake values remain the complete runner input. Separately, before starting an action, the scheduler must retain
one record keyed by the exact `(repo_root, session_id, wake_id)` tuple. ThreadLoop does not store this record, and this
contract does not prescribe a scheduler database, lease, or claim mechanism.

The minimum retained record is:

```text
record_version: 1
repo_root:
session_id:
wake_id:
mode:
preflight_validated: true | false
snapshot_branch:
snapshot_head_sha:
snapshot_worktree_clean: true
snapshot_lifecycle_state:
snapshot_lifecycle_state_version:
action_kind: transition | repository_work | local_gate | stop
action_code_or_target:
action_started: true | false
action_outcome: not_started | unknown | succeeded | failed
action_result:
candidate_executable:
candidate_guard_failure_count:
candidate_required_work_count:
transition_request:
```

For a transition, `transition_request` must retain the exact source state, target state, expected state version,
idempotency key, actor, and input JSON bytes. It must also record that the selected candidate was executable with empty
`guard_failures` and `required_work` by setting the three candidate fields to `true`, `0`, and `0`. For any other
action, `transition_request` is `null`, and the candidate fields retain their observed values.

Write the selected action and exact transition request before marking `action_started: true`; update the outcome after
the invocation returns. Retain the exact successful transition response or exact structured failure in `action_result`;
use `null` while the result is unknown. Scheduler serialization is what prevents two deliveries from both observing an
absent record. If the scheduler cannot retrieve a complete record for a delivery it identifies as a duplicate, stop. Do
not reconstruct one from current state or conversation history.

## Non-negotiable authority boundary

Never merge, deploy, publish, rotate secrets, approve, activate or replace policy, recover a blocked session, or decide
that a repair budget may be exceeded. Never push, force-push, rebase, switch branches, create or delete a worktree,
stash, reset, clean, discard, or overwrite existing work as part of this procedure.

Human approval and merge observations are evidence, not permission for the runner to exercise that authority. `normal`
and `replay` have the same boundary.

The scheduler must assign one dedicated worktree to the session and serialize execution so that only one wake mutates it
at a time. Git can confirm that a path is a worktree, but it cannot provide scheduler serialization.

## Wake procedure

### 1. Validate inputs before ThreadLoop

Perform input validation before any `threadloop` command.

For `repo_root`, require an existing directory, an absolute path, and byte equality with its filesystem-canonical
`realpath`. Reject `~`, relative paths, symlink aliases, and a path whose canonical form differs. Pass every input as
one exact argument; do not construct a shell command by interpolating unquoted input.

If any input is invalid or missing, perform no ThreadLoop command and stop with a preflight handoff.

### 2. Take the Git preflight snapshot

Run these read-only Git commands with the explicit `repo_root`:

```text
git -C <repo_root> rev-parse --show-toplevel
git -C <repo_root> symbolic-ref --quiet --short HEAD
git -C <repo_root> rev-parse --verify --end-of-options HEAD^{commit}
git -C <repo_root> --no-optional-locks status --porcelain=v1 -z --untracked-files=all --ignore-submodules=none
git -C <repo_root> worktree list --porcelain
```

Require all of the following:

- `rev-parse --show-toplevel` is byte-equal to `repo_root`;
- the path is an exact `worktree` entry in `git worktree list --porcelain`;
- `symbolic-ref` returns a non-empty named branch;
- `rev-parse --verify --end-of-options HEAD^{commit}` returns a non-empty commit id; and
- the porcelain status is empty, including untracked files.

Retain the exact tuple `(repo_root, branch, head_sha, clean=true)` as the wake snapshot. If Git observation fails, the
branch is detached, or the worktree is dirty, preserve it exactly and stop. Do not repair the checkout.

### 3. Verify the live protocol

Run from a process whose working directory is exactly `repo_root`:

```text
threadloop protocol --json
```

Require a successful JSON envelope with `ok: true`, `command: "protocol"`, and:

```text
data.contractVersions.protocol = 3
data.contractVersions.proofPlan = 3
data.contractVersions.sessionNext = 3
```

Missing, differently typed, or different values are a contract mismatch. Stop without mutation. Do not use an older or
unknown contract in either mode.

### 4. Prove the session is readable without migration

Run the read-only projection before any other session read:

```text
threadloop session next --session <session_id> --json
```

Require a successful envelope with `ok: true`, `command: "session next"`, `data.contract_version: 3`, and
`data.session_id` byte-equal to the input `session_id`. Stop before `session status` if any proof, staleness, repair
budget, or audit status is `migration_required`, or if the audit status is not `valid`. `session next` is the
migration-safe read path; do not let a normal state read migrate an older repository during runner preflight.

### 5. Read and validate session status

Run:

```text
threadloop session status --session <session_id> --json
```

Require a successful envelope with `ok: true`, `command: "session status"`, `data.session_id` byte-equal to the input
`session_id`, a non-null `data.task`, and:

- `data.task.id` equal to `data.task_id`;
- non-empty `data.task.title` and `data.task.goal`;
- `data.task.issue_ref` as a string or `null`;
- `data.task.status` in the lifecycle-state allowlist below; and
- `data.task.state_version` as a non-negative safe integer.

Retain `data.task_id`, title, goal, issue reference, status, and state version. These task fields are the implementation
scope; do not treat `data.session.branch`, `data.session.head_sha`, or a stored repository snapshot as current Git
authority.

### 6. Read and validate the fresh session-next snapshot

Run:

```text
threadloop session next --session <session_id> --json
```

Require a successful envelope with `ok: true`, `command: "session next"`, `data.contract_version: 3`, and
`data.session_id` byte-equal to the input `session_id`.

Validate these structural invariants before making a decision:

- `data.lifecycle.state` is a known lifecycle state and `data.lifecycle.state_version` is a non-negative safe integer;
- `data.task_id`, `data.lifecycle.state`, and `data.lifecycle.state_version` equal the retained session-status task id,
  status, and state version;
- `data.candidate` is `null` or has `from_state`, `target_state`, `expected_state_version`, and boolean `executable`;
- a candidate's `from_state` equals `data.lifecycle.state`;
- a candidate's `from_state` and `target_state` are both in the lifecycle-state allowlist;
- a candidate's `expected_state_version` equals `data.lifecycle.state_version`;
- `data.repository.branch`, `data.repository.head_sha`, and `data.repository.worktree.clean` exactly equal the retained
  Git snapshot;
- `data.repair_budget.limit` is `3`, and its status, counts, and `exhausted` flag agree;
- every status and code is in the v3 allowlists below; and
- `data.audit.status` is `valid`.

The lifecycle-state allowlist is:

```text
queued
framed
proof_ready
implementing
verifying
reviewing
repairing
ready_for_human
blocked
completed
```

The status allowlists are:

- `proof.status` and each `proof.gates[].status`: `missing`, `passed`, `failed`, `stale`, `corrupt`; the top-level proof
  status may additionally be `migration_required`;
- `ci_proof.status`: `policy_missing`, `missing`, `passed`, `stale`, `corrupt`;
- each `ci_proof.gates[].status`: `missing`, `passed`, `stale`, `corrupt`;
- `review.status`: `policy_missing`, `missing`, `current`, `stale`, `corrupt`;
- `staleness.status`: `current`, `missing`, `stale`, `corrupt`, `migration_required`;
- `repair_budget.status`: `available`, `exhausted`, `migration_required`; and
- `audit.status`: `valid`, `corrupt`, `migration_required`.

The only terminal reasons are `null`, `BLOCKED_REQUIRES_HUMAN_RECOVERY`, and `COMPLETED`.

Require `guard_failures` and `required_work` to be both empty or to contain one matching known pair. The v3 pair
allowlist is:

```text
BLOCKED_PRIOR_STATE_REQUIRED -> RESTORE_BLOCKED_PRIOR_STATE
BLOCKING_REVIEW_FINDING_REQUIRED -> REFRESH_SIGNED_REVIEW_PROOF
BLOCKING_REVIEW_FINDINGS -> ENTER_REVIEW_REPAIR
BLOCK_EVIDENCE_REQUIRED -> PROVIDE_BLOCK_EVIDENCE
CI_PROOF_POLICY_REQUIRED -> START_SESSION_WITH_CI_POLICY
COMMITTED_IMPLEMENTATION_REQUIRED -> COMMIT_IMPLEMENTATION
COMMITTED_REPAIR_REQUIRED -> COMMIT_REPAIR
CURRENT_FAILED_PROOF_REQUIRED -> RUN_CURRENT_GATES
CURRENT_HUMAN_APPROVAL_REQUIRED -> OBTAIN_CURRENT_HUMAN_APPROVAL
CURRENT_PASSING_PROOF_REQUIRED -> COMPLETE_CURRENT_PROOF
CURRENT_REVIEW_PROOF_REQUIRED -> REFRESH_SIGNED_REVIEW_PROOF
CURRENT_REVIEW_PROOF_SET_REQUIRED -> REFRESH_REVIEW_PROOF_SET
CURRENT_SIGNED_CI_PROOF_REQUIRED -> RERUN_AND_IMPORT_CI_PROOF
OBSERVED_MERGE_REQUIRED -> MERGE_AND_REFRESH_REVIEW_PROOF
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
SIGNED_CI_PROOF_REQUIRED -> IMPORT_SIGNED_CI_PROOF
SIGNED_REVIEW_PROOF_REQUIRED -> IMPORT_SIGNED_REVIEW_PROOF
UNCORRUPTED_REVIEW_PROOF_REQUIRED -> RESTORE_SIGNED_REVIEW_PROOF
UNCORRUPTED_SIGNED_CI_PROOF_REQUIRED -> RESTORE_SIGNED_CI_PROOF
```

Validate `next_human_action` as `null`, the same code and description as the sole `required_work` item, or
`ADVANCE_TO_HUMAN_AUTHORITY` when the executable candidate is exactly `reviewing -> ready_for_human`. Any other
guard/work combination fails closed.

Treat any `migration_required` status, non-valid audit, unknown status, unknown lifecycle state, unknown pair, malformed
candidate, session-status mismatch, repository mismatch, or inconsistent budget as a fail-closed stop. Do not invoke a
mutating command to migrate or repair state.

### 7. Resolve an existing wake before stop policy

If this `wake_id` already has a retained action, do not select a fresh action in either mode.

- A retained action with `action_started: false` is reported as not started; stop. A later delivery with a new `wake_id`
  may select from a fresh snapshot.
- A retained successful transition is final; report it and stop.
- A retained definitive transition failure is final; report the exact error and stop.
- An ambiguous transition may be retried only with its byte-equivalent retained request.
- A retained repository or local-gate action is not replayed. Inspect only read-only evidence, report the uncertainty,
  and stop. Sensors and imports are external-controller actions and never appear as runner actions.

Before retrying, require a complete version-1 retained record whose tuple and mode equal the current inputs and whose
`preflight_validated` value and `snapshot_worktree_clean` value are both `true`. Require the fresh canonical Git root,
named branch, HEAD commit, and clean status to equal the retained `repo_root`, `snapshot_branch`, `snapshot_head_sha`,
and `snapshot_worktree_clean` values exactly. A branch change, HEAD change, or newly dirty worktree invalidates the
original wake authorization even when ThreadLoop's lifecycle state version did not change. Stop without invoking the
transition; do not use idempotency as authority across Git snapshot drift.

Require the recorded transition source and target to be known lifecycle states, the source to equal
`snapshot_lifecycle_state`, the expected version to equal `snapshot_lifecycle_state_version`, the source not to be
`ready_for_human`, `blocked`, or `completed`, and the target not to be `blocked` or `completed`. Require the actor to be
`agent`, the exact input bytes to be `{}`, and the key to equal `runner:v1:<wake_id>:<expected_state_version>`. Also
require the record to say that the original candidate had the same source, target, and expected version and was
executable with empty guard/work arrays. Any mismatch is a fail-closed handoff, not a retry.

An exact validated transition retry is allowed before current lifecycle stop policy, including when the first invocation
advanced the session into `ready_for_human`. It only retrieves ThreadLoop's idempotent result; it does not start a new
lifecycle action. After the result, stop. A transition that originally targeted `blocked` or `completed` was never
runner-authorized and must not be retried by this skill.

### 8. Apply stop policy before considering the candidate

Evaluate these stops in order, before candidate execution or required work:

1. `data.lifecycle.state` is `ready_for_human`;
2. `data.lifecycle.state` is `blocked`;
3. `data.repair_budget.exhausted` is `true` or its status is `exhausted`; or
4. `data.lifecycle.state` is `completed`.

Also stop if a candidate targets `blocked` or `completed`. Blocking, recovery, approval, merge, completion, and budget
authority belong to a human or external controller.

### 9. Select no more than one action

For a new wake in either mode, prefer an executable candidate over required work. Require an executable candidate to
have empty `guard_failures` and `required_work`. If those fields disagree, stop as a contract inconsistency.

If there is no executable candidate, require exactly one `required_work` item before considering a required-work action.
Zero items means there is no authorized action. More than one is ambiguous. Stop in both cases.

Apply the same selection rules in `normal` and `replay`. The runner does not read a fixture or scenario descriptor;
externally prepared replay state never weakens validation, guards, budgets, stop states, action limits, or
forbidden-authority rules.

## Transition action

An autonomous transition is allowed only when all snapshot checks pass, the candidate is executable, neither its source
nor target crosses a hard stop, and it needs the literal input JSON bytes `{}`. A future candidate that needs other
input is not authorized by this contract.

Use exactly:

- target: `data.candidate.target_state`;
- expected version: `data.candidate.expected_state_version`;
- actor: `agent`;
- input bytes: `{}`; and
- idempotency key: `runner:v1:<wake_id>:<expected_state_version>`.

Before invocation, retain those exact values and the exact input bytes in the wake handoff record. Then run:

```text
threadloop session transition <target_state> \
  --session <session_id> \
  --expected-state-version <expected_state_version> \
  --idempotency-key <idempotency_key> \
  --actor agent \
  --input '{}' \
  --json
```

Require a successful envelope with `command: "session transition"` and response fields that match the request:
`data.contract_version: 1`, `data.session_id`, `data.idempotency_key`, `data.transition.from_state`,
`data.transition.to_state`, `data.transition.from_state_version`, `data.transition.actor`, `data.transition.input`, and
`data.lifecycle.state`. The resulting state version must be the requested version plus one.

An original success and an exact stored transition retry return the same successful result. ThreadLoop exposes no
separate `replayed` response field. Either result is the wake's final action. Stop immediately after validating it.

### Transition retry and conflict rules

Retry only after `STATE_BUSY` or an ambiguous process/transport failure, and only with the byte-equivalent retained
request: same wake id, mode, session, target, expected version, key, actor, option values, and input JSON bytes. A
duplicate wake still performs the required read-only snapshots, but never uses a fresh `session next` candidate to
recompute the target, change JSON formatting, or mint another key.

On `STATE_VERSION_CONFLICT`, stop. Do not refresh and transition again in the same wake.

On `IDEMPOTENCY_CONFLICT`, stop and escalate the retained request and error. Never change the request or key to bypass
the conflict. Retain both `error.details.request_sha256` and `error.details.existing_request_sha256`; if either digest
is missing or malformed, report that contract failure as well.

On `TRANSITION_GUARD_FAILED`, `TRANSITION_NOT_ALLOWED`, `STATE_CORRUPTED`, `AUDIT_UNAVAILABLE`,
`AUDIT_VERIFICATION_FAILED`, or any unknown error, stop. A rejected transition is not permission to perform its reported
required work in the same wake.

## Required-work actions

Only codes in the bounded repository and local proof allowlists below may authorize autonomous work. The code must
appear as the one exact `data.required_work[0].code`. The validated session-status `data.task.title`, `data.task.goal`,
`data.task.issue_ref`, and the complete current finding set in `session next` at `data.review.blocking_findings` are the
only implementation and repair scope authority. Do not infer generic work from a code or description.

### Bounded repository work

The bounded repository-work codes are:

```text
COMMIT_IMPLEMENTATION
COMMIT_REPAIR
```

For `COMMIT_IMPLEMENTATION`, require one unambiguous change bounded by the retained task title, goal, and issue
reference. For `COMMIT_REPAIR`, require one bounded repair within that task scope. When review evidence owns the repair,
use the complete current finding set; one repair action may address multiple findings only when their combined target,
acceptance conditions, and file scope form one coherent commit. If any finding is omitted or the combined action is
ambiguous, stop.

One bounded repository action may edit the necessary files, run focused non-ThreadLoop checks, and create at most one
scoped commit. It must not run a ThreadLoop gate, import evidence, push, or transition in the same wake. If the action
cannot end in one clean commit, preserve the worktree and stop with a handoff; never discard or conceal partial work.

Only an executable `reviewing -> repairing` candidate with empty guard/work arrays authorizes entry into a review repair
cycle. `BLOCKING_REVIEW_FINDINGS -> ENTER_REVIEW_REPAIR` is recognized for protocol compatibility but stops for
controller inspection; it never authorizes repository work or a synthesized transition.

### Local proof work

The local-proof codes are:

```text
COMPLETE_CURRENT_PROOF
RUN_CURRENT_GATES
RUN_MISSING_GATES
RERUN_STALE_GATES
RERUN_CORRUPT_GATES
```

Map `RUN_MISSING_GATES` to `missing`, `RERUN_STALE_GATES` to `stale`, and `RERUN_CORRUPT_GATES` to `corrupt`. For
`COMPLETE_CURRENT_PROOF` or `RUN_CURRENT_GATES`, match gates whose status is not `passed`. Require every projected
`gate_id` to be non-empty and unique, then select the first matching gate in the existing `data.proof.gates` order. If
no gate matches, stop as unavailable. A later wake rereads the projection and may select the next remaining gate. Run
only:

```text
threadloop session gate run <gate_id> --session <session_id> --json
```

The gate id must come from the validated v3 projection. Never supply or override an executable, argv, shell, directory,
timeout, or environment. ThreadLoop runs the command, working directory, and timeout stored in the immutable proof plan.

A local gate run appends a receipt but does not change lifecycle state. It is not idempotent. After one gate invocation,
successful or failed, stop. Never run a second gate in the same wake.

### Signed evidence handoff

The signed-evidence codes are:

```text
IMPORT_SIGNED_CI_PROOF
RERUN_AND_IMPORT_CI_PROOF
RESTORE_SIGNED_CI_PROOF
IMPORT_SIGNED_REVIEW_PROOF
REFRESH_SIGNED_REVIEW_PROOF
RESTORE_SIGNED_REVIEW_PROOF
REFRESH_REVIEW_PROOF_SET
```

These codes are recognized but never autonomous under this four-input contract. `session next` supplies the code and
description, but it does not supply the canonical package path or exact commit-pinned sensor invocation needed to act.
On any signed-evidence code:

- set `decision: stop`;
- retain the exact code with `action_started: false`;
- set `next_authority: external_controller`; and
- preserve the validated snapshot for handoff.

Do not search for a likely package, invent a sensor command, derive a path convention, or accept an extra per-action
value hidden in the retained record. The external controller may run the commit-pinned sensor or import an exact package
using authority it owns, outside the runner wake. A later wake must reread and revalidate the resulting public
projection. Never describe the handoff as evidence completion, and never activate or replace proof or trust policy.

## Recognized stop-only work

The following actual v3 work codes are recognized but never autonomous:

```text
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

`ADVANCE_TO_HUMAN_AUTHORITY` is the only additional recognized `next_human_action.code`. It does not authorize a second
action: an executable transition to `ready_for_human` is final, and the next wake stops on that lifecycle state.

All other `required_work`, `guard_failures`, and `next_human_action` codes are unknown and fail closed.

## Mode and duplicate behavior

`normal` and `replay` both follow the complete wake procedure and may select one fresh action for a new `wake_id`.
Replay mode does not locate a fixture or evidence source. The external controller owns replay setup; the runner sees
only the same four inputs and public ThreadLoop projections. Mode does not change the session contract, candidate rules,
authority boundary, stop policy, budget, or action limit.

For a duplicate or ambiguous wake, the retained record must identify whether an action started. A retained transition
request must satisfy the scheduler-record contract above. If the record is absent, incomplete, inconsistent, or does not
prove that the original transition was runner-authorized, stop without selecting fresh work.

If a retained transition outcome is unknown, retry that exact request only after the read-only snapshots prove the
canonical Git root, branch, HEAD, and clean status still equal the original retained wake snapshot, even when the
current lifecycle has advanced into a stop state. If a non-transition action started, never repeat it under the
duplicate wake. Preserve and report its known or uncertain outcome.

ThreadLoop's duplicate guarantee covers an exact transition request only. It does not provide exactly-once command
execution, exactly-once repository edits, exactly-once commits, or exactly-once gate runs. Sensors and signed imports
are external-controller actions, not runner actions. The scheduler must serialize wakes for the dedicated worktree and
preserve the retained request and outcome.

## Crash rules

- Before an action starts: report that no action started. A new serialized wake may read a fresh snapshot.
- While a transition result is unknown: retry only the retained byte-equivalent request with the same wake id and mode.
- After a successful transition but before handoff: the duplicate may return the same stored result with the same
  request.
- During edits or commit: preserve all files. A later dirty or mismatched preflight stops; never reset, clean, stash, or
  repeat the work blindly.
- During or after a local gate run: do not replay it. A later serialized wake may inspect fresh `session next` evidence,
  but the duplicate wake stops.
- At a signed-evidence boundary: start no action and hand off the required-work code to the external controller.
- After any one action succeeds or fails: do not select a second action in that wake.

## Stop checklist and handoff

Before returning, confirm:

- all four inputs were explicit and valid;
- the scheduler assigned the session one dedicated worktree and serialized execution;
- Git root, branch, HEAD, and cleanliness matched the v3 session projection;
- protocol, session, status, code, audit, and budget validation passed;
- stop policy ran before fresh candidate handling, with only the retained-transition retry exception;
- mode rules were honored;
- zero or one action started;
- no forbidden authority was exercised; and
- the worktree was preserved on every stop or failure.

Return a concise handoff containing:

```text
repo_root:
session_id:
wake_id:
mode:
preflight: passed | stopped
snapshot_branch:
snapshot_head_sha:
snapshot_worktree_clean:
lifecycle_state:
lifecycle_state_version:
repair_budget:
decision: transition | repository_work | local_gate | stop
action_code_or_target:
action_started: true | false
action_result:
idempotency_key:
retained_transition_request:
retained_record_version:
stop_reason:
next_authority: scheduler | agent | human | external_controller
```

For a transition, retain the exact target, session, expected version, idempotency key, actor, and input JSON bytes. For
any ambiguous or failed action, include the exact ThreadLoop error code and preserve enough command detail for diagnosis
without exposing secrets. Never describe a draft, attempted command, local check, or handoff as proof that a transition,
gate, review, approval, merge, deployment, or publication completed.
