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

Structural permission is not evidence that a transition should occur. Gate receipts, review state, attempt budgets,
approval, and merge observations are separate guards layered onto this graph.

SQLite schema version 3 migrates legacy `active` tasks to `queued`, preserves `completed`, initializes `state_version`
to `0`, records `blocked_from_state`, and rebuilds the active-session compatibility projection from every non-completed
task with an unended session. It also stores operational transition and idempotency records.

`threadloop session next --session <id> --json` is read-only and returns one deterministic candidate or `null`. It
reports live Git facts without refreshing persisted snapshots. Staleness and repair-budget authority remain deferred to
issue #40.

`threadloop session transition` requires the caller's expected state version and an idempotency key. State mutation,
transition history, idempotency outcome, active projection, and session completion are one transaction. Only
`queued -> framed`, evidence-complete blocking, and evidence-complete recovery are publicly executable in M002-2. Other
structurally valid edges fail closed under #40 or #42. Completion remains unavailable until #42 provides authoritative
approval and merge evidence.
