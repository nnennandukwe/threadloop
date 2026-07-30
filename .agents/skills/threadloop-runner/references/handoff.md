# Handoff report fields

Field template for the report a wake returns when it stops. The reporting constraints that govern it are normative in
`SKILL.md`.

```text
repo_root:
session_id:
wake_id:
mode:
preflight: passed | stopped
snapshot_branch:
snapshot_head_sha:
snapshot_worktree_clean:
lifecycle_phase:
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
