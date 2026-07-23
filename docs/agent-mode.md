# ThreadLoop Agent Mode

ThreadLoop v2 is a repo-local control plane for orchestrated coding workflows.

The external orchestrator owns task selection, agent launch, and policy. ThreadLoop owns durable session state, Git-derived snapshots, structured notes, and review artifacts.

## Mental model

Use ThreadLoop when you want agents to exchange structured state through the repository instead of through transcript parsing.

- The orchestrator starts a session and keeps the returned `session_id`.
- Agents and tools write semantic notes with `threadloop session capture`.
- ThreadLoop records mechanical repo state with `session heartbeat` and `session reconcile`.
- Review artifacts are generated from the stored task, entry, and Git snapshot state.

Semantic vs mechanical operations:

- Semantic: `session start`, `session capture`, `artifact generate`, `session finish`
- Mechanical: `session heartbeat`, `session reconcile`, `daemon run`

`session reconcile` and the daemon do not create semantic notes. They only refresh branch, head SHA, changed file scope, diff stats, and commit range.

## Recommended orchestrator flow

The current operator model is one autonomous task per checkout or worktree.

1. Prepare a dedicated Git checkout or `git worktree` for the task.
2. Fetch `origin`, fast-forward local `main` to `origin/main`, and create a fresh task branch from updated `main`.
3. Start an explicit session and persist the returned `session_id`.
4. Pass the `session_id` to every subsequent ThreadLoop command.
5. Capture intent, decisions, risks, validation, and reviewer guidance as the task evolves.
6. Reconcile before artifact generation when Git-derived scope needs a refresh.
7. Rebase the task branch onto the latest `origin/main` before PR open.
8. Generate the artifact you need, then stop for human review. Until the guarded transition commands land, do not use compatibility `session finish` as evidence of approval or merge.

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
threadloop artifact generate pr-summary --session "$SESSION_ID" --json
```

## Machine-facing contract

Use `threadloop protocol --json` to discover the current command contract instead of hard-coding it in an orchestrator.

The protocol currently publishes:

- command usages derived from the actual CLI tree
- supported entry kinds and artifact kinds
- structured workflow guidance for `main` sync, branch naming, rebase, and PR summary generation
- truthful notes about `--json` support and session targeting
- environment variables that are actually used by the CLI

Current environment-variable contract:

- `EDITOR`: used only by `--edit` and `--goal-edit`

ThreadLoop does not currently use environment variables for session targeting or workspace selection. Pass `--session <id>` explicitly and run commands from the intended repository root or subdirectory.

ThreadLoop also does not perform Git fetch, branch creation, rebase, or PR open for you in this slice. Those remain orchestrator responsibilities.

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
- replace explicit orchestrator calls for capture or finish

Use it when you want Git-derived state to stay warm while an agent works, but keep semantic capture under explicit orchestrator or agent control.

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

Legacy root commands exist for compatibility, but automation should prefer the explicit `threadloop session ...` namespace because it avoids ambiguity.

## Operator notes

- ThreadLoop requires a Git repository.
- `.threadloop/state/` is ignored via `.git/info/exclude` by default.
- `.threadloop` internal paths are excluded from artifact Git scope.
- Legacy `.threadloop/state/state.json` data migrates to SQLite on first access and is kept as a backup file.
