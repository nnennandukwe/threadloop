# ThreadLoop

ThreadLoop is a local-first CLI companion for AI-assisted coding work. It captures the small set of task intent, decisions, risks, validation notes, and reviewer guidance that matter, then renders that context into a review-ready artifact.

For the orchestrated v2 workflow, see [docs/agent-mode.md](docs/agent-mode.md).

## Positioning

ThreadLoop is deliberately not a passive provenance recorder and not a generic PR template generator.

It is:
- task-first
- repo-local
- Markdown-first
- optimized for review preparation through lightweight session memory

## Current command surfaces

Canonical session contract:
- `threadloop session start <title> --goal <goal> [--json]`
- `threadloop session list [--json]`
- `threadloop session status --session <id> [--json]`
- `threadloop session capture <kind> [text] --session <id> [--json]`
- `threadloop session heartbeat --session <id> [--json]`
- `threadloop session reconcile --session <id>|--all [--json]`
- `threadloop session finish --session <id> [--json]`

Compatibility surface:
- `threadloop init`
- `threadloop start <title> [--json]`
- `threadloop capture <kind> [text] [--session <id>] [--json]`
- `threadloop status [--session <id>] [--json]`
- `threadloop artifact generate [change-brief|pr-summary|handoff] [--session <id>] [--json]`
- `threadloop finish [--session <id>] [--json]`

Compatibility rule:
- legacy `capture`, `artifact generate`, and `finish` auto-resolve only when exactly one active session exists
- legacy `start` preserves the legacy single-active-session behavior and refuses to open a second legacy root session in the same repo
- legacy `status` fails with `SESSION_REQUIRED` when zero sessions match
- when zero sessions match for `capture`, `artifact generate`, and `finish`, they fail with `SESSION_REQUIRED`
- when multiple sessions match for any legacy command, they fail with `SESSION_AMBIGUOUS`
- pass `--session <id>` or use `threadloop session ...` for deterministic targeting

Implemented storage:
- `.threadloop/config.json`
- `.threadloop/state/state.db`
- `.threadloop/artifacts/*.md`

Legacy repos with `.threadloop/state/state.json` migrate into SQLite on first init/read/write. The JSON file is intentionally left in place as a safety backup during this phase, but ThreadLoop reads from SQLite after migration.

## Install

Prerequisites:
- Node 22.13.0 or newer
- a Git repository

```bash
npm install
npm run build
```

## Try it in another repo

ThreadLoop supports two local install flows right now.

### 1. `npm link` for fast local iteration

In the ThreadLoop repo:

```bash
npm link
```

In another Git repo:

```bash
threadloop session start "Add retry logic" --goal "Reduce transient failures" --actor agent --json
session_id="session_123" # replace with the session_id returned from session start
threadloop session capture decision "Retry only idempotent jobs" --session "$session_id" --because "Replay must stay safe" --actor agent
threadloop session status --session "$session_id" --json
```

Use this path for day-to-day local development. It does not require adding ThreadLoop to the consumer repo's dependencies.

### 2. `npm pack` for install verification

In the ThreadLoop repo:

```bash
npm pack
```

Then in another Git repo, install the generated tarball:

```bash
npm install /absolute/path/to/threadloop-0.1.0.tgz
npx threadloop session start "Add retry logic" --goal "Reduce transient failures" --json
```

Use this path to verify packaging and distribution behavior.

You can also run the automated smoke check from the ThreadLoop repo:

```bash
npm run smoke:pack
```

### What `threadloop init` does

- creates `.threadloop/` if needed
- creates or opens `.threadloop/state/state.db`
- migrates legacy `.threadloop/state/state.json` into SQLite when present
- ensures `.threadloop/state/` is ignored via `.git/info/exclude`
- leaves `.threadloop/artifacts/` visible by default

## SQLite migration status

The current SQLite work is the storage foundation for ThreadLoop v2 autonomous agent mode.

What is implemented now:
- SQLite-backed durable state
- transactional writes for core mutations
- migration from legacy `state.json`
- explicit `session` namespace commands
- compatibility wrappers that safely fail on ambiguous multi-session state
- `--json` machine-output contract for session commands and legacy wrappers
- reconcile and snapshot persistence
- daemon-driven mechanical refresh
- protocol print / published agent-mode contract

What is not implemented yet in this slice:
- same-checkout autonomous multi-task concurrency hardening

## Quick start

```bash
npx threadloop session start "Add retry logic to job runner" --goal "Reduce transient failure rate" --base main --actor agent --json
session_id="session_123" # replace with the session_id returned from session start
npx threadloop session capture decision "Retry only idempotent jobs" --session "$session_id" --because "Non-idempotent replay is unsafe" --actor agent
npx threadloop session capture validation "Ran targeted tests for retry backoff and cancellation" --session "$session_id"
npx threadloop session status --session "$session_id" --json
npx threadloop protocol --json
npx threadloop artifact generate change-brief --session "$session_id"
npx threadloop session finish --session "$session_id" --json
```

## Autonomous agent mode

Use explicit session commands for automation and keep one autonomous task per checkout or Git worktree.

Recommended loop:

1. fetch `origin` and fast-forward local `main` to `origin/main`
2. create a fresh task branch from updated `main`
3. `threadloop session start ... --base main --actor agent --json`
4. persist the returned `session_id`
5. `threadloop session capture ... --session "$session_id" --actor agent`
6. `threadloop session reconcile --session "$session_id"` when Git-derived scope needs refresh
7. rebase the task branch onto the latest `origin/main`
8. `threadloop artifact generate pr-summary --session "$session_id"`
9. stop for human review; do not infer approval, merge, or lifecycle completion from the compatibility `session finish` command

Use `threadloop protocol --json` as the machine-facing contract for current commands, entry kinds, artifact kinds, supported environment variables, and the published branch/rebase/PR workflow guidance.

The optional daemon only performs mechanical refresh work. It does not create semantic notes or replace explicit capture.

The governed task lifecycle and schema-v2 migration contract are documented in [`docs/lifecycle.md`](docs/lifecycle.md). Autonomous transition and guard commands are delivered as later M002 increments; the current `session finish` compatibility command is not proof of approval or merge.

## Longer notes with `$EDITOR`

For longer capture text, use your editor:

```bash
export EDITOR="vim"
session_id="session_123" # replace with the session_id returned from session start
npx threadloop session capture note --edit --session "$session_id"
npx threadloop session start "Reshape queue workers" --goal-edit --json
```

## Entry kinds

Supported entry kinds:
- `intent`
- `note`
- `decision`
- `risk`
- `constraint`
- `validation`
- `reviewer_guidance`

## Artifact kinds

- `change-brief`: full review-ready artifact
- `pr-summary`: thinner PR-oriented view
- `handoff`: current-state handoff note

Example artifacts live in `examples/`.

## Development

```bash
npm run test
npm run build
npm run smoke:pack
```

## Notes

- ThreadLoop requires a Git repository.
- Prefer `threadloop session ...` commands for explicit session work.
- Compatibility root `start` keeps one active session per repo.
- Compatibility root `capture`, `artifact generate`, and `finish` work without `--session` only when exactly one active session exists.
- Compatibility root `status` fails with `SESSION_REQUIRED` when zero sessions match.
- `.threadloop/state/` is ignored via `.git/info/exclude` by default.
- Artifacts are local by default and may be committed when useful.

## Docs

- CLI reference: `docs/cli.md`
- Autonomous agent mode: `docs/agent-mode.md`
