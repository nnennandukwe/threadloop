# ThreadLoop

ThreadLoop is a local-first CLI that models an AI-assisted software-delivery task as a governed lifecycle graph. It
stores lifecycle state in repo-local SQLite, returns a deterministic next-action candidate, validates explicit
transition requests against current policy and evidence, and renders review artifacts under `.threadloop/artifacts/`.

Agents can execute work, but policy and evidence determine which lifecycle transition is allowed next. A caller must
request each transition; ThreadLoop applies it idempotently only when its structural, repository, proof, repair-budget,
and recovery requirements are satisfied.

ThreadLoop is for repository maintainers and developer-tooling teams that run AI-assisted coding work and need lifecycle
advancement to remain explicit, inspectable, and evidence-bound.

For the orchestrated v2 workflow, see [docs/agent-mode.md](docs/agent-mode.md).

## Graph and loop engineering

ThreadLoop applies graph engineering by encoding lifecycle states as nodes, permitted transitions as edges, and
repository and proof requirements as transition guards. It applies loop engineering by making verification, bounded
repair, re-entry, blocking, and recovery explicit parts of the lifecycle.

```mermaid
flowchart LR
  subgraph TL["ThreadLoop: governed software-delivery graph"]
    Q["queued"] --> F["framed"] --> P["proof_ready"] --> I["implementing"] --> V["verifying"]
    V -- "proof passes" --> R["reviewing"]
    V -- "proof fails" --> X["repairing"]
    X -- "committed repair" --> V
    R -. "review blocker" .-> X
    R -. "review clear" .-> H["ready_for_human"]
    H -. "approval and merge" .-> C["completed"]
    A["recorded active state"] -. "complete block evidence" .-> B["blocked"]
    B -. "human-approved recovery to recorded prior state" .-> A
  end

  subgraph GAA["Governed Agent Autonomy Patterns: inner agent loop"]
    G1["plan"] --> G2["permission"] --> G3["tool trust"] --> W["agent executes work"]
    W --> G4["independent verification"] --> E["content-addressed evidence"]
    W -. "observed by" .-> G5["runtime accountability"]
    G4 -. "reported through" .-> G5
  end

  I -. "bounded execution" .-> G1
  E -. "potential evidence adapter" .-> V
```

The solid lifecycle edges are executable in the current `main` implementation when their guards pass. The dashed
review-owned edges are structurally valid but remain fail-closed until ThreadLoop has authoritative review, approval,
and merge evidence. The repair loop is limited to three cycles. Entering `blocked` requires complete block evidence, and
recovery requires explicit human approval to return to the recorded prior state.

[Governed Agent Autonomy Patterns](https://github.com/nnennandukwe/governed-agent-autonomy-patterns) defines the
complementary controls around an agent run: planning, permission, tool trust, independent verification, and runtime
accountability. Those inner-loop controls can produce work and evidence; ThreadLoop governs whether a software-delivery
task may traverse its next outer lifecycle edge. This is an architectural relationship, not a runtime dependency:
ThreadLoop does not currently ingest BoundaryBench receipts.

### Primary interfaces and outputs

| Interface                                          | Output or state change                                              |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| `threadloop session next --session <id> --json`    | A read-only transition candidate, guard failures, and required work |
| `threadloop session transition <target-state> ...` | An idempotent transition or a structured guard rejection            |
| `threadloop session gate run <gate-id> ...`        | A current-HEAD gate receipt and digest-bound output artifact        |
| `threadloop artifact generate <kind> ...`          | A Markdown change brief, PR summary, or handoff artifact            |
| `.threadloop/state/state.db`                       | Canonical repo-local lifecycle, transition, plan, and receipt state |

## Current command surfaces

Canonical session contract:

- `threadloop session start <title> --goal <goal> [--json]`
- `threadloop session list [--json]`
- `threadloop session status --session <id> [--json]`
- `threadloop session capture <kind> [text] --session <id> [--json]`
- `threadloop session heartbeat --session <id> [--json]`
- `threadloop session reconcile --session <id>|--all [--json]`
- `threadloop session next --session <id> [--json]`
- `threadloop session transition <target-state> --session <id> --expected-state-version <version> --idempotency-key <key> --actor <cli|agent> --input <json-object> [--json]`
- `threadloop session gate run <gate-id> --session <id> [--json]`
- `threadloop session gate import <package-path> --session <id> [--json]`

Compatibility surface:

- `threadloop init`
- `threadloop start <title> [--json]`
- `threadloop capture <kind> [text] [--session <id>] [--json]`
- `threadloop status [--session <id>] [--json]`
- `threadloop artifact generate [change-brief|pr-summary|handoff] [--session <id>] [--json]`

Compatibility rule:

- legacy `capture` and `artifact generate` auto-resolve only when exactly one active session exists
- legacy `start` preserves the legacy single-active-session behavior and refuses to open a second legacy root session in
  the same repo
- legacy `status` fails with `SESSION_REQUIRED` when zero sessions match
- when zero sessions match for `capture` and `artifact generate`, they fail with `SESSION_REQUIRED`
- when multiple sessions match for any legacy command, they fail with `SESSION_AMBIGUOUS`
- pass `--session <id>` or use `threadloop session ...` for deterministic targeting

Implemented storage:

- `.threadloop/config.json`
- `.threadloop/state/state.db`
- `.threadloop/artifacts/*.md`
- `.threadloop/artifacts/receipts/<session-id>/<receipt-id>/`

Legacy repos with `.threadloop/state/state.json` migrate into SQLite on first init/read/write. The JSON file is
intentionally left in place as a safety backup during this phase, but ThreadLoop reads from SQLite after migration.

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

Use this path for day-to-day local development. It does not require adding ThreadLoop to the consumer repo's
dependencies.

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
- ensures `.threadloop/state/` and `.threadloop/artifacts/receipts/` are ignored via `.git/info/exclude`
- leaves normal `.threadloop/artifacts/*.md` review artifacts visible

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
- deterministic, idempotent lifecycle transitions with optimistic state versions
- immutable proof plans bound to a clean branch and baseline commit
- shell-free execution of declared local gates with digest-bound, append-only receipts
- current-HEAD staleness, artifact-integrity checks, and a transition-history-derived three-repair budget
- a read-only next-action contract with authoritative local proof and live sanitized repository observations
- protocol print / published agent-mode contract

What is not implemented yet in this slice:

- same-checkout autonomous multi-task concurrency hardening

## Quick start

```bash
npx threadloop session start "Add retry logic to job runner" --goal "Reduce transient failure rate" --base main --actor agent --json
session_id="session_123" # replace with the session_id returned from session start
npx threadloop session capture decision "Retry only idempotent jobs" --session "$session_id" --because "Non-idempotent replay is unsafe" --actor agent
npx threadloop session capture validation "Ran targeted tests for retry backoff and cancellation" --session "$session_id"
npx threadloop session next --session "$session_id" --json
npx threadloop session transition framed --session "$session_id" --expected-state-version 0 --idempotency-key "quickstart:$session_id:0" --actor agent --input '{}' --json
npx threadloop session status --session "$session_id" --json
npx threadloop protocol --json
npx threadloop artifact generate change-brief --session "$session_id"
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
9. record the exact proof plan during `framed -> proof_ready`
10. call `session gate run <gate-id>` for each declared gate while verifying
11. import each matching receipt from the commit-pinned reusable GitHub workflow
12. call `session next --json` to inspect independent local/CI proof and the repair budget
13. leave review-owned transitions and completion blocked until #42 supplies review, approval, and merge evidence

Use `threadloop protocol --json` as the machine-facing contract for current commands, entry kinds, artifact kinds,
supported environment variables, and the published branch/rebase/PR workflow guidance.

The optional daemon only performs mechanical refresh work. It does not create semantic notes or replace explicit
capture.

The governed task lifecycle and schema-v5 proof contract are documented in [`docs/lifecycle.md`](docs/lifecycle.md). The
signed package and reusable workflow are specified in
[`docs/attestations/receipt-v1.md`](docs/attestations/receipt-v1.md). `session transition` uses local proof for repair,
signed CI proof for review authorization, and remains fail-closed where #42 owns review, approval, and merge evidence.

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
npm ci
npm run check
npm run security:dependencies
```

`npm run check` is the canonical deterministic quality gate. It covers formatting, source and Markdown linting,
repository-wide type checking, dead-code analysis, community-file validation, tests, the production build, and packaged
installation. See the [contribution guide](CONTRIBUTING.md) for hook behavior and security-check details.

## Notes

- ThreadLoop requires a Git repository.
- Prefer `threadloop session ...` commands for explicit session work.
- Compatibility root `start` keeps one active session per repo.
- Compatibility root `capture` and `artifact generate` work without `--session` only when exactly one active session
  exists.
- Compatibility root `status` fails with `SESSION_REQUIRED` when zero sessions match.
- `.threadloop/state/` is ignored via `.git/info/exclude` by default.
- `.threadloop/artifacts/receipts/` is ignored locally; normal review artifacts are not hidden.
- Artifacts are local by default and may be committed when useful.

## Docs

- [CLI reference](docs/cli.md)
- [Autonomous agent mode](docs/agent-mode.md)
- [Contribution guide](CONTRIBUTING.md)
