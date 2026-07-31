# Governed lifecycle

ThreadLoop stores lifecycle state on the task. A session remains the execution record attached to that task.

The ordered states are:

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

The structural forward transitions are:

```text
queued -> framed
framed -> proof_ready
proof_ready -> implementing
implementing -> verifying
pre-PR verifying -> implementing | pre_pr_reviewing
pre_pr_reviewing -> implementing | reviewing
post-PR verifying -> reviewing | repairing
reviewing -> repairing | ready_for_human
repairing -> verifying
ready_for_human -> completed
```

Every state except `blocked` and `completed` may transition to `blocked`. Recovery from `blocked` may return only to the
recorded prior state, and `completed` is terminal.

Structural permission is not evidence that a transition should occur. Proof plans, gate receipts, review state, attempt
budgets, approval, and merge observations are separate guards layered onto this graph.

Lifecycle phase is derived from append-only transition history plus the immutable audit-genesis state that bounds
migrated history. A session is `pre_pr` until its first applied transition into `reviewing`; a migrated session whose
audit coverage begins in `reviewing`, `ready_for_human`, or `completed` is already `post_pr`. A legacy `repairing` state
or repair transition without evidence of entry into `reviewing` remains `pre_pr`, because older lifecycles allowed
pre-PR repair. The phase is permanently `post_pr` afterward. SQLite schema version 7 retains all prior lifecycle, proof,
signed receipt, audit, and repair records and adds this semantic interpretation without a second mutable phase flag.
Persistent triggers reject update, delete, and replacement. Repair usage remains derived from applied transitions into
`repairing`; historical entries remain counted, while new entries are allowed only for post-PR gate and signed-review
repairs.

`threadloop session next --session <id> --json` is read-only and returns one deterministic candidate or `null`. It
reports live Git facts without refreshing persisted snapshots. It rehashes the latest receipt manifest and output
artifacts, classifies local proof as missing/current/stale/failed/corrupt, and reports independent CI proof as
policy-missing/missing/passed/stale/corrupt. It also reports the three-cycle repair budget. Reading schema v2 or v3
reports proof migration without writing newer objects. Contract v4 also reports lifecycle phase and schema status,
pre-PR review evidence, the exact implementation basis, lifecycle history, current signed-review findings and
approval/merge state, audit validity/root/coverage, and one next human action. Reading schema v6 returns
`migration_required` without mutation; run `threadloop init` outside the runner to perform the transactional v7
migration.

`threadloop session transition` requires the caller's expected state version and an idempotency key. State mutation,
transition history, idempotency outcome, audit guard decision, active projection, and session completion are one
transaction. Accepted transitions append `transition_applied` in that same transaction. Exact replays add no duplicate
events, while rejected guards retain the unchanged lifecycle and one idempotent `guard_decision`.

| Transition                             | Required authority                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `framed -> proof_ready`                | Valid immutable plan plus clean named branch and baseline HEAD                                      |
| `proof_ready -> implementing`          | Repository still matches the plan baseline                                                          |
| `implementing -> verifying`            | One clean descendant commit after the current implementation basis                                  |
| pre-PR `verifying -> implementing`     | Current failed local proof or current-HEAD changes-required pre-PR review evidence                  |
| pre-PR `verifying -> pre_pr_reviewing` | Current local and signed CI proof for every gate on the clean plan branch                           |
| `pre_pr_reviewing -> implementing`     | Current-HEAD changes-required pre-PR review evidence                                                |
| `pre_pr_reviewing -> reviewing`        | Current-HEAD clean pre-PR review outcome plus current local and signed CI proof                     |
| post-PR `verifying -> repairing`       | Current-HEAD failure and fewer than three repair entries                                            |
| post-PR `verifying -> reviewing`       | Current local and signed CI proof                                                                   |
| `repairing -> verifying`               | Clean committed repair after the failure or signed-review basis                                     |
| `reviewing -> repairing`               | Current signed changes request or any unresolved, non-outdated signed-review thread                 |
| `reviewing -> ready_for_human`         | Current verified signed-review evidence without blockers                                            |
| `ready_for_human -> repairing`         | A later current-HEAD signed-review receipt introduces a blocker                                     |
| `ready_for_human -> completed`         | Current receipt observes a same-HEAD human `User` approval and the PR merged                        |
| `verifying -> blocked`                 | Explicit block evidence after post-PR repair exhaustion (or the existing general blocking contract) |

Always forbidden are `reviewing -> implementing`, post-PR `verifying -> implementing`, `pre_pr_reviewing -> repairing`,
and a fourth post-PR repair entry.

## Pre-PR review evidence

Pre-PR review is provider-neutral transition input, not a signed-review receipt:

```json
{
  "pre_pr_review": {
    "outcome": "changes_required",
    "head_sha": "0123456789abcdef0123456789abcdef01234567",
    "evidence_ref": "review-ledger:2026-07-30",
    "evidence_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "findings": [
      {
        "id": "capture-auth-no-mutation",
        "summary": "Capture auth rejection coverage does not prove no mutation.",
        "path": "tests/payments.test.ts"
      }
    ]
  }
}
```

The HEAD must equal the live repository HEAD. `changes_required` needs at least one uniquely identified normalized
finding; `clean` needs an empty findings array. Recording the evidence is one explicit transition action. Repository
work happens only in a later serialized wake. `session next` returns
`PRE_PR_REVIEW_OUTCOME_REQUIRED -> RECORD_PRE_PR_REVIEW_OUTCOME` when operator/controller input is required.

The initial implementation basis is the proof-plan baseline. A failed local receipt replaces it with that receipt's
HEAD, and review findings replace it with their reviewed HEAD. `implementing -> verifying` requires a clean commit that
descends from and differs from this exact basis. Every implementation or repair commit makes earlier local, signed-CI,
pre-PR review, and signed-review evidence stale unless the evidence contract binds the new HEAD.

`threadloop session gate run <gate-id> --session <id>` executes only the argv, repository-relative working directory,
and timeout stored in the plan. It uses no shell, records stdout/stderr digests and a manifest, appends the receipt
after the child closes, and never advances lifecycle state. A new commit makes old receipts stale without mutating them.

`threadloop session gate import <package-path> --session <id>` verifies the immutable v2/v3/v4 GitHub/Sigstore CI
policy, appends one accepted signed-CI projection, and likewise never advances lifecycle state. See
[Signed gate receipt v2](attestations/receipt-v2.md).

`threadloop session review import <package-path> --session <id>` verifies the independent v3/v4 review policy and
appends one current-HEAD review projection without advancing lifecycle state. The latest valid receipt controls blocker,
approval, and merge projections. See [Signed review receipt v1](attestations/review-v1.md).

Re-entering verification after post-PR gate or signed-review repair requires a clean committed change after the exact
evidence basis that opened that repair. Pre-PR iterations never enter `repairing`, even when a migrated session already
has three historical repair entries. Entering the third repair exhausts new-entry authority but does not prevent that
repair from being committed, verified, and returned to review. An attempted fourth repair instead requires an explicit
evidence-bearing transition to `blocked`.

## Audit coverage

New sessions begin with `session_started`. Sessions created before schema v6 receive exactly one `audit_activated`
genesis event with `coverage: schema_v6_forward`; ThreadLoop does not invent earlier decisions. Audit corruption blocks
controller writes and export but leaves semantic note reads available for diagnosis. `session next` is a read-only
projection and creates no audit event.
