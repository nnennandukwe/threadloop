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

SQLite schema version 4 retains the lifecycle and idempotency records from v3, adds one immutable proof plan per
session, and appends sequenced local gate receipts. Persistent triggers reject update, delete, and replacement. Repair
usage is derived from applied `verifying -> repairing` transitions rather than a second mutable counter.

`threadloop session next --session <id> --json` is read-only and returns one deterministic candidate or `null`. It
reports live Git facts without refreshing persisted snapshots. It rehashes the latest receipt manifest and output
artifacts, classifies proof as missing/current/stale/failed/corrupt, and reports the three-cycle repair budget. Reading
schema v2 or v3 reports proof migration without writing v4 objects.

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
| `verifying -> reviewing`      | Every latest gate passes for current HEAD, with a clean checkout on the proof-plan branch   |
| `verifying -> repairing`      | Current-HEAD failure and fewer than three repair cycles                                     |
| `repairing -> verifying`      | Clean committed repair after the failure HEAD                                               |
| `verifying -> blocked`        | Explicit block evidence after repair exhaustion (or the existing general blocking contract) |

`threadloop session gate run <gate-id> --session <id>` executes only the argv, repository-relative working directory,
and timeout stored in the plan. It uses no shell, records stdout/stderr digests and a manifest, appends the receipt
after the child closes, and never advances lifecycle state. A new commit makes old receipts stale without mutating them.
