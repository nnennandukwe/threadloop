# ThreadLoop CLI

ThreadLoop is a repo-local CLI for preserving task intent, decisions, risks, validation notes, and reviewer guidance while you work.

## Commands

### `threadloop init`
Initializes `.threadloop/` in the current Git repository and ensures `.threadloop/state/` is ignored in the repo's `.gitignore`.

### `threadloop session start <title> [--json]`
Starts an explicit task/session and returns a stable `session_id`.

Options:
-- `--goal <goal>`: required task goal; prompts if missing
-- `--constraint <constraint...>`: one or more constraints to preserve
-- `--base <ref>`: Git base ref for comparisons
-- `--json`: render machine-readable session output

### `threadloop session list [--json]`
Lists known sessions in the current repository, including which one is active.

### `threadloop session status --session <id> [--json]`
Shows the status of a specific session by explicit session id.

Options:
-- `--session <id>`: target session id
-- `--json`: render machine-readable session output

### `threadloop session capture <kind> [text] --session <id> [--json]`
Captures one structured entry for the targeted session.

Kinds:
-- `intent`
-- `note`
-- `decision`
-- `risk`
-- `constraint`
-- `validation`
-- `reviewer_guidance`

Options:
-- `--session <id>`: target session id
-- `--because <reason>`: attach rationale to a decision or note
-- `--edit`: open `$EDITOR` for longer capture text
-- `--json`: render machine-readable session output

### `threadloop session heartbeat --session <id> [--json]`
Refreshes a session's mechanical metadata without creating a semantic entry.

Options:
-- `--session <id>`: target session id
-- `--source <cli|daemon|reconcile>`: record where the heartbeat came from
-- `--json`: render machine-readable session output

### `threadloop session reconcile --session <id> [--json]`
Refreshes Git-derived metadata for one or more sessions without creating semantic entries. Updates branch, head SHA, changed files, diff stats, and commit range.

Options:
-- `--session <id>`: reconcile a specific session
-- `-a, --all`: reconcile all active sessions
-- `--json`: render machine-readable session output

Use `--session <id>` for one explicit session or `--all` for all active sessions in the current workspace.

### `threadloop session finish --session <id> [--json]`
Marks a specific session complete.

### `threadloop daemon run [--json]`
Runs the optional mechanical refresh loop for active sessions in the current workspace.

Options:
-- `-i, --interval <seconds>`: reconcile interval in seconds, default `60`
-- `--json`: render machine-readable command output

Behavior:
-- periodically calls reconcile for all active sessions
-- records no semantic notes
-- writes running/stopped status in the normal command envelope

### Legacy compatibility commands

ThreadLoop still accepts the root commands below for compatibility while the namespaced session contract is the primary operator surface:

- `threadloop start <title> [--json]`
- `threadloop capture <kind> [text] [--session <id>] [--json]`
- `threadloop status [--session <id>] [--json]`
- `threadloop artifact generate [kind] [--session <id>] [--json]`
- `threadloop finish [--session <id>] [--json]`

Compatibility rules:
- `start` preserves the legacy single-active-session behavior and refuses to open a second legacy root session in the same repo
- `capture`, `artifact generate`, and `finish` auto-resolve only when exactly one active session exists
- `status` fails with `SESSION_REQUIRED` when zero sessions match
- when zero sessions match for `capture`, `artifact generate`, and `finish`, they fail with `SESSION_REQUIRED`
- when multiple sessions match for any legacy command, they fail with `SESSION_AMBIGUOUS`
- pass `--session <id>` or use the `threadloop session ...` forms for deterministic targeting

### `threadloop artifact generate [kind]`
Renders a Markdown artifact from the active session.

Kinds:
-- `change-brief` (default)
-- `pr-summary`
-- `handoff`

Options:
-- `--session <id>`: target a specific session when more than one is active
-- `--json`: render machine-readable command output

### `threadloop protocol [--json]`
Prints the agent integration contract derived from the current CLI configuration.

The JSON payload includes:
- supported environment variables used by the CLI contract
- command usages derived from the registered command tree
- capture kinds and artifact kinds sourced from runtime constants
- truthful notes about JSON support and session targeting behavior

Current environment-variable contract:
- `EDITOR`: used by `--edit` and `--goal-edit`

## Storage

ThreadLoop stores state locally in the repo:

- `.threadloop/config.json`
- `.threadloop/state/state.db`
- `.threadloop/artifacts/*.md`

If an older repo still has `.threadloop/state/state.json`, ThreadLoop migrates that data into SQLite on first access and intentionally leaves the JSON file in place as a safety backup. After migration, ThreadLoop reads from SQLite.

This SQLite work is the storage foundation for v2, and the explicit session namespace / JSON contract now lands on top of it.

Recommended default:
- keep `.threadloop/state/` uncommitted
- commit artifacts only when they are useful for review or handoff

## Agent-mode guidance

For automation, prefer:

- `threadloop session ...` commands over legacy root commands
- explicit `--session <id>` on every session-scoped call
- one autonomous task per checkout or Git worktree

Legacy root commands are still available for human compatibility, but they can fail with `SESSION_REQUIRED` or `SESSION_AMBIGUOUS` in multi-session repos.

`session heartbeat`, `session reconcile`, and `daemon run` are mechanical operations. They refresh state but do not create semantic entries. Use `session capture` for decisions, risks, validation, and reviewer guidance.

For the full orchestrator/operator workflow, see [agent-mode.md](agent-mode.md).

## Coast note

If you are using Coast, reinstall dependencies inside the Coast runtime after native dependency changes such as `better-sqlite3`:

```bash
coast exec dev-1 -- sh -c "npm ci"
```

If you skip that and the shared workspace still has host-built native modules, you may see load failures for `better_sqlite3.node` or an `Exec format error`.
