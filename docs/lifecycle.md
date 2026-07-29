# Governed lifecycle

ThreadLoop stores lifecycle state on the task. A session remains the execution record attached to that task.

The ordered states are:

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

The structural forward transitions are:

```text
queued -> framed
framed -> proof_ready
proof_ready -> implementing
implementing -> verifying
verifying -> reviewing | repairing
reviewing -> repairing | ready_for_human
repairing -> verifying
ready_for_human -> completed
```

Every state except `blocked` and `completed` may transition to `blocked`. Recovery from `blocked` may return only to the
recorded prior state, and `completed` is terminal.

Structural permission is not evidence that a transition should occur. Proof plans, gate receipts, review state, attempt
budgets, approval, and merge observations are separate guards layered onto this graph.

SQLite schema version 6 retains prior lifecycle and proof records, adds append-only verified signed review receipts, and
records authoritative controller activity in a hash-linked audit ledger. Persistent triggers reject update, delete, and
replacement. Repair usage is derived from every applied gate or review transition into `repairing`, so both sources
share one three-cycle budget.

`threadloop session next --session <id> --json` is read-only and returns one deterministic candidate or `null`. It
reports live Git facts without refreshing persisted snapshots. It rehashes the latest receipt manifest and output
artifacts, classifies local proof as missing/current/stale/failed/corrupt, and reports independent CI proof as
policy-missing/missing/passed/stale/corrupt. It also reports the three-cycle repair budget. Reading schema v2 or v3
reports proof migration without writing newer objects. Contract v3 also reports lifecycle history, current review
findings and approval/merge state, audit validity/root/coverage, and one next human action.

`threadloop session transition` requires the caller's expected state version and an idempotency key. State mutation,
transition history, idempotency outcome, audit guard decision, active projection, and session completion are one
transaction. Accepted transitions append `transition_applied` in that same transaction. Exact replays add no duplicate
events, while rejected guards retain the unchanged lifecycle and one idempotent `guard_decision`.

| Transition                     | Required authority                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `framed -> proof_ready`        | Valid immutable plan plus clean named branch and baseline HEAD                              |
| `proof_ready -> implementing`  | Repository still matches the plan baseline                                                  |
| `implementing -> verifying`    | Clean committed diff from the baseline                                                      |
| `verifying -> reviewing`       | Current local and signed CI proof for every gate, with a clean checkout on the plan branch  |
| `verifying -> repairing`       | Current-HEAD failure and fewer than three repair cycles                                     |
| `repairing -> verifying`       | Clean committed repair after the failure HEAD                                               |
| `reviewing -> repairing`       | Current changes requested or any unresolved, non-outdated review thread                     |
| `reviewing -> ready_for_human` | Current verified review evidence without blockers                                           |
| `ready_for_human -> repairing` | A later current-HEAD review receipt introduces a blocker                                    |
| `ready_for_human -> completed` | Current receipt observes a same-HEAD human `User` approval and the PR merged                |
| `verifying -> blocked`         | Explicit block evidence after repair exhaustion (or the existing general blocking contract) |

`threadloop session gate run <gate-id> --session <id>` executes only the argv, repository-relative working directory,
and timeout stored in the plan. It uses no shell, records stdout/stderr digests and a manifest, appends the receipt
after the child closes, and never advances lifecycle state. A new commit makes old receipts stale without mutating them.

`threadloop session gate import <package-path> --session <id>` verifies the immutable v2/v3 GitHub/Sigstore CI policy,
appends one accepted signed-CI projection, and likewise never advances lifecycle state. See
[Signed gate receipt v1](attestations/receipt-v1.md).

`threadloop session review import <package-path> --session <id>` verifies the independent v3 review policy and appends
one current-HEAD review projection without advancing lifecycle state. The latest valid receipt controls blocker,
approval, and merge projections. See [Signed review receipt v1](attestations/review-v1.md).

Re-entering verification after either gate or review repair requires a clean committed change after the evidence basis
that caused repair. Once all three shared cycles are consumed, the caller must submit an explicit evidence-bearing
transition to `blocked`.

## Audit coverage

New sessions begin with `session_started`. Sessions created before schema v6 receive exactly one `audit_activated`
genesis event with `coverage: schema_v6_forward`; ThreadLoop does not invent earlier decisions. Audit corruption blocks
controller writes and export but leaves semantic note reads available for diagnosis. `session next` is a read-only
projection and creates no audit event.
