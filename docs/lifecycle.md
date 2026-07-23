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

SQLite schema version 2 migrates legacy `active` tasks to `queued`, preserves `completed`, initializes `state_version`
to `0`, and rebuilds the active-session compatibility projection from every non-completed task with an unended session.

`threadloop session transition` and `threadloop session next` are introduced in the next M002 increment. Until those
commands own completion guards, the existing `session finish` behavior is a compatibility surface and must not be used
as an autonomous approval or merge decision.
