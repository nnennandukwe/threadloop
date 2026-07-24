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

SQLite schema version 5 retains the lifecycle, idempotency, proof-plan, and local-receipt records from v4 and adds
append-only verified signed gate receipts. Persistent triggers reject update, delete, and replacement. Repair usage is
derived from applied `verifying -> repairing` transitions rather than a second mutable counter.

`threadloop session next --session <id> --json` is read-only and returns one deterministic candidate or `null`. It
reports live Git facts without refreshing persisted snapshots. It rehashes the latest receipt manifest and output
artifacts, classifies local proof as missing/current/stale/failed/corrupt, and reports independent CI proof as
policy-missing/missing/passed/stale/corrupt. It also reports the three-cycle repair budget. Reading schema v2 or v3
reports proof migration without writing newer objects.

`threadloop session transition` requires the caller's expected state version and an idempotency key. State mutation,
transition history, idempotency outcome, active projection, and session completion are one transaction. Only
proof-authorized issue #40 edges, evidence-complete blocking, and evidence-complete recovery are executable here.
Review-owned transitions and completion remain unavailable until #42 provides authoritative review, approval, and merge
evidence.

| Transition                    | Required authority                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| `framed -> proof_ready`       | Valid immutable plan plus clean named branch and baseline HEAD                              |
| `proof_ready -> implementing` | Repository still matches the plan baseline                                                  |
| `implementing -> verifying`   | Clean committed diff from the baseline                                                      |
| `verifying -> reviewing`      | Current local and signed CI proof for every gate, with a clean checkout on the plan branch  |
| `verifying -> repairing`      | Current-HEAD failure and fewer than three repair cycles                                     |
| `repairing -> verifying`      | Clean committed repair after the failure HEAD                                               |
| `verifying -> blocked`        | Explicit block evidence after repair exhaustion (or the existing general blocking contract) |

`threadloop session gate run <gate-id> --session <id>` executes only the argv, repository-relative working directory,
and timeout stored in the plan. It uses no shell, records stdout/stderr digests and a manifest, appends the receipt
after the child closes, and never advances lifecycle state. A new commit makes old receipts stale without mutating them.

`threadloop session gate import <package-path> --session <id>` verifies the immutable v2 GitHub/Sigstore trust policy,
appends one accepted signed-CI projection, and likewise never advances lifecycle state. See
[Signed gate receipt v1](attestations/receipt-v1.md).
