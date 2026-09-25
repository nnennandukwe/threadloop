# ThreadLoop Agent Mode

**Implemented now:** ThreadLoop's TypeScript/Node CLI governs a fixed PR lifecycle in a repository.

The external orchestrator selects tasks, prepares execution context and policy inputs, and launches agents. ThreadLoop
stores durable lifecycle state and evidence, evaluates the applicable policy and guards, and applies explicit transition
requests. Orchestrators and agents cannot bypass those guards. Git snapshots, structured notes, and review artifacts
support that workflow.

See the [architecture guide](architecture.md) for the accepted Controller Contract v0.1 and deferred configurable graph,
Execution Claim, GAAP integration, and Rust work. This guide describes the current session CLI.

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
- Mechanical refresh: `session heartbeat`, `session reconcile`
- Lifecycle read-only: `session next`
- Audit inspection: `audit show`, `audit verify`

`session reconcile` does not create semantic notes. They only refresh branch, head SHA, changed file scope, diff stats,
and commit range.

On a current-schema repository, `audit show` and `audit verify` are storage-read-only and never apply a lifecycle
transition. A repository on schema v7 instead stops with `SESSION_SCHEMA_MIGRATION_REQUIRED`; run `threadloop init`
explicitly in a writable checkout before retrying audit inspection.

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

## Periodic refresh

ThreadLoop has no resident process. To keep Git-derived state warm while an agent works, schedule
`threadloop session reconcile --all` from the orchestrator or a loop such as
`while sleep 60; do threadloop session reconcile --all; done`. Reconcile never creates semantic entries, infers intent,
or decides when work is complete.

## Concurrency and workspace expectations

The safe default is one autonomous task per checkout or worktree.

Recommended:

- separate long-running tasks into distinct Git worktrees or independent clones
- sync `main` before each task and branch once per session
- use explicit `session_id` targeting everywhere
- rebase the session branch onto `origin/main` before opening a PR

Allowed but less desirable:

- multiple active sessions in one repository, as long as callers always pass `--session <id>`

Not the intended v2 operating model:

- multiple autonomous tasks mutating the same checkout concurrently

## Operator notes

- ThreadLoop requires a Git repository.
- `.threadloop/state/` and `.threadloop/artifacts/receipts/` are ignored via `.git/info/exclude` by default.
- Local receipts drive repair; verified signed CI receipts independently authorize review.
- Before PR creation, local failures and provider-neutral review findings drive repeatable `implementing` wakes without
  consuming repair budget.
- Verified signed review receipts drive review repair, human readiness, and completion guards.
- Audit JSONL and handoffs are projections; neither can authorize lifecycle mutation.
- `.threadloop` internal paths are excluded from artifact Git scope.
