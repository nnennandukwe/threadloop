# Scheduler-retained wake record fields

Field template for the record the scheduler retains per wake, keyed by exact `(repo_root, session_id, wake_id)`. This
record is external to ThreadLoop and does not add a fifth runner input. The retention rules that govern it are normative
in `SKILL.md`.

```text
record_version: 2
repo_root:
session_id:
wake_id:
mode: normal | duplicate_delivery
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

Version 1 records retain `record_version: 1` and `mode: normal | replay`. Read them under the v1 vocabulary and never
rewrite their version or mode on retry. Version 2 is an explicit opt-in for updated schedulers and validators; an
unchanged v1 consumer must continue using v1. A mode mismatch for the same retained wake stops without action.
