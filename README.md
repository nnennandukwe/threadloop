# ThreadLoop

ThreadLoop is a local-first CLI companion for AI-assisted coding work. It captures the small set of task intent, decisions, risks, validation notes, and reviewer guidance that matter, then renders that context into a review-ready artifact.

## Positioning

ThreadLoop is deliberately not a passive provenance recorder and not a generic PR template generator.

It is:
- task-first
- repo-local
- Markdown-first
- optimized for review preparation through lightweight session memory

## Current v1 scope

Implemented command surface:
- `threadloop init`
- `threadloop start <title>`
- `threadloop capture <kind> [text]`
- `threadloop status`
- `threadloop artifact generate [change-brief|pr-summary|handoff]`
- `threadloop finish`

Implemented storage:
- `.threadloop/config.json`
- `.threadloop/state/state.db`
- `.threadloop/artifacts/*.md`

Legacy v1 repos with `.threadloop/state/state.json` migrate into SQLite on first init/read/write. The JSON file is intentionally left in place as a safety backup during this phase, but ThreadLoop reads from SQLite after migration.

## Install

Prerequisites:
- Node 22+
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
threadloop init
threadloop start "Add retry logic" --goal "Reduce transient failures"
threadloop capture decision "Retry only idempotent jobs" --because "Replay must stay safe"
threadloop artifact generate change-brief
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
npx threadloop init
npx threadloop start "Add retry logic" --goal "Reduce transient failures"
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
- ensures `.threadloop/state/` is ignored in the target repo's `.gitignore`
- leaves `.threadloop/artifacts/` visible by default

## SQLite migration status

The current SQLite work is the first storage slice toward ThreadLoop v2 autonomous agent mode.

What is implemented now:
- SQLite-backed durable state
- transactional writes for core mutations
- migration from legacy `state.json`

What is not implemented yet in this slice:
- multi-session agent mode
- explicit `session` namespace commands
- `--json` machine-output contract
- reconcile/daemon-backed DB workflows

## Quick start

```bash
npx threadloop init
npx threadloop start "Add retry logic to job runner" --goal "Reduce transient failure rate" --base main
npx threadloop capture decision "Retry only idempotent jobs" --because "Non-idempotent replay is unsafe"
npx threadloop capture validation "Ran targeted tests for retry backoff and cancellation"
npx threadloop artifact generate change-brief
npx threadloop finish
```

## Longer notes with `$EDITOR`

For longer capture text, use your editor:

```bash
export EDITOR="vim"
npx threadloop capture note --edit
npx threadloop start "Reshape queue workers" --goal-edit
```

## Entry kinds

Supported v1 entry kinds:
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

## Coast workflow

This project uses Coast for runtime verification.

Typical commands:

```bash
coast lookup
coast start dev-1
coast exec dev-1 -- sh -c "npm ci"
coast exec dev-1 -- sh -c "npm run test"
coast exec dev-1 -- sh -c "npm run build"
```

Because ThreadLoop now depends on `better-sqlite3`, the shared `node_modules` directory can become platform-mismatched between the host and the Coast container. If you see errors loading `better_sqlite3.node` or an `Exec format error`, reinstall dependencies inside the Coast runtime with `npm ci`.

## Development

```bash
npm run test
npm run build
npm run smoke:pack
```

## Notes

- ThreadLoop requires a Git repository.
- v1 keeps one active session per repo.
- `.threadloop/state/` is gitignored by default.
- Artifacts are local by default and may be committed when useful.

## Docs

- CLI reference: `docs/cli.md`
