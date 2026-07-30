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

On a schema-v7 repository, `audit show` and `audit verify` are storage-read-only and never apply a lifecycle transition.
On an older repository, their first migration-aware call may append the honest `audit_activated` event that begins
forward-only coverage. Run migration-aware audit inspection in a writable checkout.

## Recommended orchestrator flow

The current operator model is one autonomous task per checkout or worktree.

1. Prepare a dedicated Git checkout or `git worktree` for the task.
2. Fetch `origin`, fast-forward local `main` to `origin/main`, and create a fresh task branch from updated `main`.
3. Start an explicit session and persist the returned `session_id`.
4. Pass the `session_id` to every subsequent ThreadLoop command.
5. Capture intent, decisions, risks, validation, and reviewer guidance as the task evolves.
6. Reconcile before artifact generation when Git-derived scope needs a refresh.
7. Rebase the task branch onto the latest `origin/main` before PR open.
8. Generate the artifact you need and inspect `session next --json`.
9. Record a proof plan at `framed -> proof_ready`, then execute only its declared gates while verifying.
10. Run every local gate and import the matching signed CI receipt produced by the commit-pinned reusable workflow.
11. Use `session next` to rerun missing/stale/corrupt gates. Before PR creation, a failed gate returns to `implementing`
    without consuming repair budget.
12. After current local and signed CI proof pass, enter `pre_pr_reviewing` and have the operator/controller record a
    current-HEAD clean or changes-required outcome as explicit transition input.
13. Repeat one-commit implementation, verification, and pre-PR review wakes as often as the task requires.
14. A clean pre-PR outcome closes the phase at `reviewing`; only then hand off PR creation to the external authority.
15. Run the commit-pinned review sensor for the PR, import its signed package, and let `session next` select bounded
    post-PR repair or human readiness from the revalidated current-HEAD snapshot.
16. Complete only after a later current-HEAD receipt observes both a human `User` approval and the merged PR.
17. Verify and export the audit ledger for durable handoff or non-authoritative telemetry ingestion.

Example:

```bash
threadloop session start "Add retry backoff to worker queue" \
  --goal "Reduce transient failure noise without changing job semantics" \
  --base main \
  --issue ISSUE-42 \
  --actor agent \
  --json
```

Save the returned `session_id`, then use it consistently:

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

threadloop session reconcile --session "$SESSION_ID" --json
threadloop session next --session "$SESSION_ID" --json
threadloop session gate run repository-check --session "$SESSION_ID" --json
threadloop session gate import ./signed-receipt.json --session "$SESSION_ID" --json
threadloop session review import ./signed-review-receipt.json --session "$SESSION_ID" --json
threadloop audit verify --session "$SESSION_ID" --json
threadloop audit export --session "$SESSION_ID" --output ./threadloop-audit.jsonl --json
threadloop artifact generate pr-summary --session "$SESSION_ID" --json
```

## Machine-facing contract

Use `threadloop protocol --json` to discover the current command contract instead of hard-coding it in an orchestrator.

The protocol currently publishes:

- explicit protocol v4 component contract versions, including session-next v4 and handoff v3
- command usages derived from the actual CLI tree
- supported entry kinds and artifact kinds
- structured workflow guidance for `main` sync, branch naming, rebase, and PR summary generation
- truthful notes about `--json` support and session targeting
- environment variables that are actually used by the CLI

Current environment-variable contract:

- `EDITOR`: used only by `--edit` and `--goal-edit`

ThreadLoop does not currently use environment variables for session targeting or workspace selection. Pass
`--session <id>` explicitly and run commands from the intended repository root or subdirectory.

The four-input runner contract is documented in
[`../.agents/skills/threadloop-runner/SKILL.md`](../.agents/skills/threadloop-runner/SKILL.md). Its inputs remain
exactly `repo_root`, `session_id`, `wake_id`, and `mode`. It stops for schema migration, pre-PR review input, signed
evidence, PR creation, approval, merge, blocked recovery, and every other controller or human authority.

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
- Before PR creation, local failures and provider-neutral review findings drive repeatable `implementing` wakes without
  consuming repair budget.
- Verified signed review receipts drive review repair, human readiness, and completion guards.
- Audit JSONL and handoffs are projections; neither can authorize lifecycle mutation.
- `.threadloop` internal paths are excluded from artifact Git scope.
- Legacy `.threadloop/state/state.json` data migrates to SQLite on first access and is kept as a backup file.
