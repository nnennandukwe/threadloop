# ThreadLoop CLI

ThreadLoop is a repo-local CLI for preserving task intent, decisions, risks, validation notes, and reviewer guidance
while you work. The canonical operator surface is session-first; root commands remain only for compatibility.

## Commands

### `threadloop init`

Initializes `.threadloop/` in the current Git repository and ensures `.threadloop/state/` plus
`.threadloop/artifacts/receipts/` are ignored via `.git/info/exclude` without editing tracked repo files. Normal review
artifacts remain visible.

### `threadloop session start <title> [--json]`

Starts an explicit task/session in `queued` state with `state_version: 0` and returns a stable `session_id`. When
`.threadloop/` is missing, this command auto-initializes ThreadLoop state for agent automation.

Options:

- `--goal <goal>`: required task goal; prompts if missing
- `--constraint <constraint...>`: one or more constraints to preserve
- `--base <ref>`: Git base ref for comparisons; when omitted, ThreadLoop uses `main` if that ref exists
- `--issue <ref>`: issue reference for branch and PR traceability
- `--actor <cli|agent>`: source for the initial intent entry, default `cli`
- `--json`: render machine-readable session output

### `threadloop session list [--json]`

Lists known sessions in the current repository, including lifecycle status, state version, and whether each session
remains active.

### `threadloop session status --session <id> [--json]`

Shows the lifecycle status and optimistic state version of a specific session by explicit session id.

Options:

- `--session <id>`: target session id
- `--json`: render machine-readable session output

### `threadloop session capture <kind> [text] --session <id> [--json]`

Captures one structured entry for the targeted session.

Kinds:

- `intent`
- `note`
- `decision`
- `risk`
- `constraint`
- `validation`
- `reviewer_guidance`

Options:

- `--session <id>`: target session id
- `--because <reason>`: attach rationale to a decision or note
- `--actor <cli|agent>`: source for the captured entry, default `cli`
- `--edit`: open `$EDITOR` for longer capture text
- `--json`: render machine-readable session output

### `threadloop session heartbeat --session <id> [--json]`

Refreshes a session's mechanical metadata without creating a semantic entry.

Options:

- `--session <id>`: target session id
- `--source <cli|daemon|reconcile>`: record where the heartbeat came from
- `--json`: render machine-readable session output

### `threadloop session reconcile (--session <id> | --all) [--json]`

Refreshes Git-derived metadata for one or more sessions without creating semantic entries. Updates branch, head SHA,
changed files, diff stats, and commit range.

Options:

- `--session <id>`: reconcile a specific session
- `-a, --all`: reconcile all active sessions
- `--json`: render machine-readable session output

Use `--session <id>` for one explicit session or `--all` for all active sessions in the current workspace.

### `threadloop session next --session <id> [--json]`

Reads one deterministic transition candidate, current lifecycle state/version, guard failures, required work, and live
sanitized repository identity, branch, HEAD, and worktree cleanliness. This command does not heartbeat, reconcile,
refresh snapshots, migrate the database, repair projections, or mutate lifecycle state.

JSON contract v2 preserves local `proof`, then adds `ci_proof` with `policy_missing`, `missing`, `passed`, `stale`, or
`corrupt` status and one signed-receipt projection per gate. Completed and blocked sessions return terminal reasons.
Schema-v2/v3 reads report `migration_required` without mutating the database.

### `threadloop session transition <target-state> [options]`

Applies one guarded lifecycle transition through an optimistic compare-and-swap transaction.

Required options:

- `--session <id>`: target session id
- `--expected-state-version <version>`: canonical non-negative integer from the latest state read
- `--idempotency-key <key>`: stable 1-128 character request key
- `--actor <cli|agent>`: invoking actor
- `--input <json-object>`: structured transition input; `framed -> proof_ready` requires `proof_plan`

The same key and canonical request replays the original result without adding records. Reusing a key for different
content fails with `IDEMPOTENCY_CONFLICT`. Stale state versions fail without lifecycle mutation. Issue #40-owned
transitions use the immutable plan, clean Git observations, current receipts, and derived repair budget. Review,
approval, and merge evidence owned by issue #42 remains fail-closed.

Proof-plan input:

```json
{
  "proof_plan": {
    "contract_version": 2,
    "acceptance_criteria": ["All repository checks pass locally and in CI"],
    "ci": {
      "provider": "github-actions",
      "issuer": "https://token.actions.githubusercontent.com",
      "certificate_identity": "https://github.com/OWNER/REPO/.github/workflows/threadloop.yml@refs/heads/BRANCH",
      "source_repository": "https://github.com/OWNER/REPO",
      "build_signer_uri": "https://github.com/nnennandukwe/threadloop/.github/workflows/threadloop-gate-sensor.yml@FULL_SHA",
      "build_signer_sha": "FULL_SHA"
    },
    "gates": [
      {
        "id": "repository-check",
        "command": ["npm", "run", "check"],
        "working_directory": ".",
        "timeout_ms": 900000
      }
    ]
  }
}
```

All gates are required. Gate ids must be unique, commands are exact argv arrays, working directories must exist and
resolve inside the repository, and timeouts must be positive integers no greater than one day. New proof plans require
the v2 immutable CI policy and must match the checkout's GitHub origin and named branch.

### `threadloop session gate run <gate-id> --session <id> [--json]`

Runs one gate declared by the session's immutable proof plan. The command accepts no executable, argument, directory,
timeout, or shell override. It is available only in `verifying` on a clean committed worktree.

The runner captures stdout and stderr separately, waits for process and stream closure, records non-zero, timeout,
abort, spawn, cleanup, and repository-drift outcomes, then appends an immutable receipt. Gate execution never changes
lifecycle state. A later receipt for the same gate supersedes an earlier receipt by database sequence.

### `threadloop session gate import <package-path> --session <id> [--json]`

Verifies and appends one signed GitHub Actions gate receipt. The input is limited to 10 MiB and the command accepts no
trust-policy override. Identical reimports are no-ops; conflicting receipt ids fail closed. Successful import appends
proof only and does not change lifecycle state or `state_version`.

See [Signed gate receipt v1](attestations/receipt-v1.md) for the package, Sigstore verification, reusable workflow, and
failure contracts.

### `threadloop daemon run [--json]`

Runs the optional mechanical refresh loop for active sessions in the current workspace.

Options:

- `-i, --interval <seconds>`: reconcile interval in seconds, default `60`
- `--json`: render machine-readable command output

Behavior:

- periodically calls reconcile for all active sessions
- records no semantic notes
- writes running/stopped status in the normal command envelope

### Legacy compatibility commands

ThreadLoop still accepts the root commands below for compatibility. Prefer the session-first commands above for explicit
session work:

- `threadloop start <title> [--json]`
- `threadloop capture <kind> [text] [--session <id>] [--json]`
- `threadloop status [--session <id>] [--json]`
- `threadloop artifact generate [kind] [--session <id>] [--json]`

Compatibility rules:

- `start` preserves the legacy single-active-session behavior and refuses to open a second legacy root session in the
  same repo
- `capture` and `artifact generate` auto-resolve only when exactly one active session exists
- `status` fails with `SESSION_REQUIRED` when zero sessions match
- when zero sessions match for `capture` and `artifact generate`, they fail with `SESSION_REQUIRED`
- when multiple sessions match for any legacy command, they fail with `SESSION_AMBIGUOUS`
- pass `--session <id>` or use the `threadloop session ...` forms for deterministic targeting

### `threadloop artifact generate [kind]`

Renders a Markdown artifact from the active session. Use `--session <id>` for deterministic targeting.

Kinds:

- `change-brief` (default)
- `pr-summary`
- `handoff`

Options:

- `--session <id>`: target a specific session when more than one is active
- `--json`: render machine-readable command output

### `threadloop protocol [--json]`

Prints the agent integration contract derived from the current CLI configuration.

The JSON payload includes:

- supported environment variables used by the CLI contract
- command usages derived from the registered command tree
- capture kinds and artifact kinds sourced from runtime constants
- structured workflow guidance for base branch, branch naming, rebase, and PR summary generation
- truthful notes about JSON support and session targeting behavior

Current environment-variable contract:

- `EDITOR`: used by `--edit` and `--goal-edit`

## Storage

ThreadLoop stores state locally in the repo:

- `.threadloop/config.json`
- `.threadloop/state/state.db`
- `.threadloop/artifacts/*.md`

If an older repo still has `.threadloop/state/state.json`, ThreadLoop migrates that data into SQLite on first access and
intentionally leaves the JSON file in place as a safety backup. After migration, ThreadLoop reads from SQLite.

SQLite schema v5 stores transition/idempotency records, one immutable proof plan per session, append-only local gate
receipts, and append-only verified signed gate receipts. Migration is atomic, and schema metadata accepts canonical
unsigned decimal text only. Update, delete, and replace attempts against plans and receipts are rejected by persistent
triggers.

Recommended default:

- keep `.threadloop/state/` uncommitted
- keep `.threadloop/artifacts/receipts/` local and uncommitted
- commit artifacts only when they are useful for review or handoff

## Agent-mode guidance

For automation, prefer:

- `threadloop session ...` commands over legacy root commands
- explicit `--session <id>` on every session-scoped call
- `--actor agent` on agent-authored `session start` and `session capture` commands
- one autonomous task per checkout or Git worktree
- syncing `main`, creating a fresh task branch, and rebasing onto `origin/main` before PR open

Legacy root commands are still available for human compatibility, but they can fail with `SESSION_REQUIRED` or
`SESSION_AMBIGUOUS` in multi-session repos and should not be treated as the default workflow.

`session heartbeat`, `session reconcile`, and `daemon run` are mechanical operations. They refresh state but do not
create semantic entries. Use `session capture` for decisions, risks, validation, and reviewer guidance.

For the full orchestrator/operator workflow, see [agent-mode.md](agent-mode.md).
