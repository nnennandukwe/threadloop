# ThreadLoop Agent Mode

ThreadLoop v2 is a repo-local control plane for orchestrated coding workflows.

The external orchestrator owns task selection, agent launch, and policy. ThreadLoop owns durable session state,
Git-derived snapshots, structured notes, and review artifacts.

## Mental model

Use ThreadLoop when you want agents to exchange structured state through the repository instead of through transcript
parsing.

- The orchestrator starts a session and keeps the returned `session_id`.
- Agents and tools write semantic notes with `threadloop session capture`.
- ThreadLoop records mechanical repo state with `session heartbeat` and `session reconcile`.
- Orchestrators inspect `session next`, run declared local gates, import trusted signed CI and review receipts, and
  submit guarded mutations through `session transition`.
- Review artifacts are generated from the stored task, entry, and Git snapshot state.

Semantic vs mechanical operations:

- Semantic: `session start`, `session capture`, `artifact generate`, `session transition`
- Mechanical evidence: `session gate run`, `session gate import`, `session review import`
- Mechanical refresh: `session heartbeat`, `session reconcile`, `daemon run`
- Lifecycle read-only: `session next`
- Audit inspection: `audit show`, `audit verify`

`session reconcile` and the daemon do not create semantic notes. They only refresh branch, head SHA, changed file scope,
diff stats, and commit range.

On a schema-v6 repository, `audit show` and `audit verify` are storage-read-only and never apply a lifecycle transition.
On an older repository, their first call may perform the one-time schema-v6 migration and append the honest
`audit_activated` event that begins forward-only coverage. Run migration-aware audit inspection in a writable checkout.

## Recommended orchestrator flow

The current operator model is one autonomous task per checkout or worktree.

1. Prepare a dedicated Git checkout or `git worktree` for the task.
2. Fetch `origin`, fast-forward local `main` to `origin/main`, and create a fresh task branch from updated `main`.
3. Start an explicit session and persist the returned `session_id`.
4. On first initialization, add and commit the visible `.threadloop/config.json`; ThreadLoop keeps state and receipt
   artifacts locally ignored, but the configuration file is intentionally visible.
5. Require an empty `git status --porcelain=v1 --untracked-files=all --ignore-submodules=none` before scheduling the
   first runner wake.
6. Pass the `session_id` to every subsequent ThreadLoop command.
7. Capture intent, decisions, risks, validation, and reviewer guidance as the task evolves.
8. Reconcile before artifact generation when Git-derived scope needs a refresh.
9. Rebase the task branch onto the latest `origin/main` before PR open.
10. Generate the artifact you need and inspect `session next --json`.
11. Record a proof plan at `framed -> proof_ready`, then execute only its declared gates while verifying.
12. Run every local gate. The external controller runs the commit-pinned sensor and imports its matching signed CI
    receipt outside the runner wake.
13. Use `session next` to rerun missing/stale/corrupt gates, enter bounded repair after local failures, or proceed only
    when local and CI proof pass.
14. Have the external controller run the commit-pinned review sensor and import its signed package, then let a fresh
    runner wake use `session next` to select repair or human readiness from the revalidated current-HEAD snapshot.
15. Complete only after a later current-HEAD receipt observes both a human `User` approval and the merged PR.
16. Verify and export the audit ledger for durable handoff or non-authoritative telemetry ingestion.

## Canonical runner wake

The repo-local [ThreadLoop runner skill](../.agents/skills/threadloop-runner/SKILL.md) defines the canonical wake
contract for an external scheduler. The npm package installs the CLI only, not the skill. ThreadLoop does not provide
that scheduler. A scheduler using this contract must assign each session one dedicated Git worktree and serialize wakes
so that only one wake mutates that worktree at a time.

Every wake must provide these explicit inputs:

- `repo_root`: the dedicated worktree root
- `session_id`: the ThreadLoop session to inspect
- `wake_id`: the stable delivery identifier, reused for a duplicate delivery
- `mode`: `normal` or `replay`

Any other `mode` is invalid, and the runner must fail closed without running a ThreadLoop command. `replay` does not
locate a fixture or evidence source; the external controller prepares the scenario outside the wake. It does not change
transition authority, budgets, or stop rules.

For each valid wake:

1. Inspect the named session from `repo_root`.
2. Before considering a candidate, stop without mutation when the lifecycle is `ready_for_human`, `blocked`, or
   `completed`, or when the repair budget is exhausted.
3. Otherwise, apply at most one executable transition or perform at most one runner-authorized `required_work` action,
   then stop. Unknown required work fails closed without substitution or inference.

Review repair starts only through an executable `reviewing -> repairing` candidate.
`BLOCKING_REVIEW_FINDINGS -> ENTER_REVIEW_REPAIR` is recognized but does not authorize repository work.

Signed-evidence codes are also recognized stop boundaries. Because the four wake inputs and `session next` do not carry
a package path or commit-pinned sensor invocation, the runner starts no action and hands the exact code to
`external_controller`. The controller may collect or import evidence outside the wake; a later wake rereads public
state. No descriptor may be hidden in the scheduler record as an undeclared fifth input.

For a transition, derive the stable idempotency key `runner:v1:<wake_id>:<expected_state_version>` from the wake and
candidate. If the response is ambiguous, retry the exact same transition request with the same target, expected state
version, input, and idempotency key. Before retrying, require the fresh canonical repository root, named branch, HEAD,
and clean status to equal the original retained wake snapshot. Git snapshot drift invalidates the original authorization
even when the lifecycle state version is unchanged. Stop without invoking the transition and do not derive a new key.

Before starting an action, the scheduler must retain the selected action and exact transition request under
`(repo_root, session_id, wake_id)`. That scheduler-owned record is not new ThreadLoop state. A duplicate with no
complete record stops instead of reconstructing a request from current lifecycle state.

Resolve a complete retained transition before applying fresh-wake stop policy. An exact retry may retrieve its cached
result after the original request reached `ready_for_human`; a new wake at `ready_for_human` still stops.

Idempotency applies only to `session transition`. Local gate execution is not idempotent, and the scheduler must not
claim exactly-once agent execution. An uncertain local-gate or agent-work outcome requires inspection before another
wake; it is not authorization to replay the action automatically.

## Multi-wake operator and controller sequence

The commands below span controller setup, semantic capture, separate serialized runner wakes, and external-controller
evidence work. They are not one canonical runner wake and must not be run as one batch. Each runner wake rereads the
public projection, performs at most one authorized transition, repository action, or local gate, and then stops.

Controller setup:

```bash
threadloop session start "Add retry backoff to worker queue" \
  --goal "Reduce transient failure noise without changing job semantics" \
  --base main \
  --issue ISSUE-42 \
  --actor agent \
  --json
```

Save the returned `session_id`, then use it consistently for semantic capture outside the scheduled runner wake:

```bash
threadloop session capture decision \
  "Retry only idempotent jobs" \
  --session "$SESSION_ID" \
  --because "Non-idempotent replay is unsafe" \
  --actor agent \
  --json

threadloop session capture validation \
  "Ran focused tests for retry backoff and cancellation" \
  --session "$SESSION_ID" \
  --json
```

After controller-owned proof-plan setup and separate transition wakes reach `verifying`, the controller may refresh
mechanical state before scheduling the next wake:

```bash
threadloop session reconcile --session "$SESSION_ID" --json
```

The runner wake rereads the projection and, only when `required_work` selects the gate, runs that one local gate:

```bash
threadloop session next --session "$SESSION_ID" --json
threadloop session gate run repository-check --session "$SESSION_ID" --json
```

That runner wake stops after the gate. The external controller imports the exact signed CI package outside the wake:

```bash
threadloop session gate import ./signed-receipt.json --session "$SESSION_ID" --json
```

After later runner wakes advance the session to `reviewing`, the controller imports the exact signed review package:

```bash
threadloop session review import ./signed-review-receipt.json --session "$SESSION_ID" --json
```

After later wakes reach the intended handoff state, the operator or controller can inspect and export the audit ledger
and generate the review artifact:

```bash
threadloop audit verify --session "$SESSION_ID" --json
threadloop audit export --session "$SESSION_ID" --output ./threadloop-audit.jsonl --json
threadloop artifact generate pr-summary --session "$SESSION_ID" --json
```

## Machine-facing contract

Use `threadloop protocol --json` to discover the current command contract instead of hard-coding it in an orchestrator.

The protocol currently publishes:

- explicit protocol v3 component contract versions
- command usages derived from the actual CLI tree
- supported entry kinds and artifact kinds
- structured workflow guidance for `main` sync, branch naming, rebase, and PR summary generation
- truthful notes about `--json` support and session targeting
- environment variables that are actually used by the CLI

Current environment-variable contract:

- `EDITOR`: used only by `--edit` and `--goal-edit`

ThreadLoop does not currently use environment variables for session targeting or workspace selection. Pass
`--session <id>` explicitly and run commands from the intended repository root or subdirectory.

ThreadLoop also does not perform Git fetch, branch creation, rebase, or PR open for you in this slice. Those remain
orchestrator responsibilities.

## Human-assisted flows

The agent-mode contract is still usable for mixed human/agent workflows.

For long-form capture or goal text:

```bash
export EDITOR="vim"
threadloop session capture reviewer_guidance --edit --session "$SESSION_ID"
threadloop session start "Reshape queue workers" --goal-edit --json
```

For review output:

```bash
threadloop artifact generate change-brief --session "$SESSION_ID"
threadloop artifact generate pr-summary --session "$SESSION_ID"
threadloop artifact generate handoff --session "$SESSION_ID"
```

## Daemon role

`threadloop daemon run` is optional. It exists to perform periodic mechanical refresh of active sessions.

What the daemon does:

- loops on an interval
- runs reconcile for all active sessions in the current workspace
- writes running/stopped status through the normal command envelope
- logs reconcile ticks and errors

What the daemon does not do:

- create semantic entries
- infer intent from transcripts
- decide when work is complete
- replace explicit orchestrator calls for capture or guarded transition

Use it when you want Git-derived state to stay warm while an agent works, but keep semantic capture under explicit
orchestrator or agent control.

## Concurrency and workspace expectations

The safe default is one autonomous task per checkout or worktree.

Recommended:

- separate long-running tasks into distinct Git worktrees or independent clones
- sync `main` before each task and branch once per session
- use explicit `session_id` targeting everywhere
- rebase the session branch onto `origin/main` before opening a PR
- keep one daemon per workspace if you use the daemon at all

Allowed but less desirable:

- multiple active sessions in one repository, as long as callers always pass `--session <id>`

Not the intended v2 operating model:

- multiple autonomous tasks mutating the same checkout concurrently
- depending on legacy root commands in multi-session automation

Legacy root commands exist for compatibility, but automation should prefer the explicit `threadloop session ...`
namespace because it avoids ambiguity.

## Operator notes

- ThreadLoop requires a Git repository.
- `.threadloop/state/` and `.threadloop/artifacts/receipts/` are ignored via `.git/info/exclude` by default.
- Local receipts drive repair; verified signed CI receipts independently authorize review.
- Verified signed review receipts drive review repair, human readiness, and completion guards.
- Audit JSONL and handoffs are projections; neither can authorize lifecycle mutation.
- `.threadloop` internal paths are excluded from artifact Git scope.
- Legacy `.threadloop/state/state.json` data migrates to SQLite on first access and is kept as a backup file.
