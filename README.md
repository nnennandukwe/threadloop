# ThreadLoop

ThreadLoop stores a software-delivery task's lifecycle state, checks evidence before allowing transitions, and generates
Markdown review artifacts. Its local CLI uses repo-local SQLite, returns a read-only next-action candidate, and applies
explicit transition requests only when the current repository, proof, review, repair, and recovery requirements pass.

Repository maintainers and developer-tooling teams use ThreadLoop to govern AI-assisted coding work from intent through
verification, review, and human completion. Agents perform work; ThreadLoop owns advancement through the outer software
development lifecycle (SDLC). Completion requires current evidence of same-HEAD human approval and the merged PR.

ThreadLoop currently runs a fixed governed PR lifecycle. It is neither an agent harness nor a general-purpose DAG
engine. It does not supply a model/tool loop, model routing, or protected-effect permission enforcement.

## Capability status

| Status                                           | What it covers                                                                                                                                                                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Implemented now**                              | Fixed PR lifecycle, durable SQLite state, current-HEAD proof and signed review checks, bounded post-PR repair, human completion, review artifacts, and verified audit export.                                                                                          |
| **Accepted in Controller Contract v0.1**         | Workflow Profile and Compiled Graph, Controller Decision and Action Request, Execution Claim and Attempt, executor/GAAP mapping, and controller conformance specifications, published in [threadloop-contracts](https://github.com/nnennandukwe/threadloop-contracts). |
| **Deferred to the controller-runtime milestone** | Configurable graph execution, durable Execution Claim enforcement, GAAP process invocation and authenticated receipt admission, and conformance by a real controller through the external suite.                                                                       |
| **Deferred to the Rust migration**               | A Rust ThreadLoop replacement, after the contract freeze and separate runtime milestone demonstrate the required behavior.                                                                                                                                             |

The contracts and their offline compiler and validators live in
[threadloop-contracts](https://github.com/nnennandukwe/threadloop-contracts); nothing there is executable through the
ThreadLoop CLI. Existing sessions do not acquire graph bindings or Execution Claims from the accepted specifications.

The [contract freeze #110](https://github.com/nnennandukwe/threadloop/issues/110) is complete.
[RunInvariant PR #4](https://github.com/nnennandukwe/run-invariant/pull/4) merged the external harness for this corpus.
Synthetic subjects exercise that harness; conformance by a real ThreadLoop controller remains unproven. These milestones
do not establish a release or completion of the separate runtime milestone.

The [architecture guide](docs/architecture.md) explains the four system roles, the YAML-to-canonical-JSON contract, and
the relationship between a ThreadLoop Workflow Run and a GAAP Agent Run. It links the normative contracts and separates
current usage from future runtime obligations.

## Primary interfaces and outputs

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
- `threadloop session review import <package-path> --session <id> [--json]`
- `threadloop audit show --session <id> [--json]`
- `threadloop audit verify --session <id> [--root <sha256>] [--json]`
- `threadloop audit export --session <id> --output <path> [--json]`

Repository and artifact commands:

- `threadloop init`
- `threadloop artifact generate [change-brief|pr-summary|handoff] [--session <id>] [--json]`

Without `--session`, `artifact generate` targets the only active session. It fails with `SESSION_REQUIRED` when none is
active and `SESSION_AMBIGUOUS` when several are.

Implemented storage:

- `.threadloop/config.json`
- `.threadloop/state/state.db`
- `.threadloop/artifacts/*.md`
- `.threadloop/artifacts/receipts/<session-id>/<receipt-id>/`

ThreadLoop opens schema v7 and v8 state databases and upgrades v7 in place with `threadloop init`.

## Install

Prerequisites:

- Node.js 22.22.2+ within Node 22, 24.15.0+ within Node 24, or Node 26+
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
- upgrades a schema-v7 state database to the current schema
- ensures `.threadloop/state/` and `.threadloop/artifacts/receipts/` are ignored via `.git/info/exclude`
- leaves normal `.threadloop/artifacts/*.md` review artifacts visible

## Implemented now: fixed lifecycle and storage

The current TypeScript/Node implementation provides:

- SQLite-backed durable state
- transactional writes for core mutations
- explicit `session` namespace commands
- `--json` machine-output contract for session commands
- reconcile and snapshot persistence
- deterministic, idempotent lifecycle transitions with optimistic state versions
- immutable proof plans bound to a clean branch and baseline commit
- shell-free execution of declared local gates with digest-bound, append-only receipts
- current-HEAD staleness, artifact-integrity checks, and a transition-history-derived three-repair budget
- signed current-HEAD review evidence for blockers, same-HEAD human approval, and merge observation
- a shared three-cycle gate/review repair budget
- repeatable pre-PR implementation with a durable `pre_pr_reviewing` boundary and HEAD-bound review evidence
- history-derived `pre_pr`/`post_pr` phase separation so pre-PR iteration never consumes signed-review repair budget
- a hash-linked, append-only controller audit ledger with verified no-overwrite JSONL export
- a read-only next-action v4 contract with lifecycle phase, implementation basis, pre-PR review, proof, signed review,
  audit, and next-human-action projections
- protocol v4 and governed handoff v3

Use one autonomous task per checkout or worktree. The current operator model does not promise safe concurrent autonomous
tasks in one checkout.

## Quick start

After using either local install flow above, run this in the consumer Git repository. Start on a dedicated task branch
from updated `main`; ThreadLoop does not create the branch for you. With the tarball install, prefix `threadloop` with
`npx`.

```bash
threadloop session start "Add retry logic to job runner" --goal "Reduce transient failure rate" --base main --actor agent --json
session_id="session_123" # replace with the session_id returned from session start
threadloop session capture decision "Retry only idempotent jobs" --session "$session_id" --because "Non-idempotent replay is unsafe" --actor agent
threadloop session capture note "Verification will use the declared proof plan" --session "$session_id"
threadloop session next --session "$session_id" --json
threadloop session transition framed --session "$session_id" --expected-state-version 0 --idempotency-key "quickstart:$session_id:0" --actor agent --input '{}' --json
threadloop session status --session "$session_id" --json
threadloop protocol --json
threadloop artifact generate change-brief --session "$session_id"
```

The first command returns a `session_id` and creates `.threadloop/state/state.db` when needed. Replace the example ID
with that returned value. `session next` reports the candidate and missing work without advancing state; the explicit
transition enters `framed`. The final command renders a change brief under `.threadloop/artifacts/` for you to inspect.
Captured notes and generated artifacts do not satisfy proof guards by themselves.

Continue with the [agent-mode flow](docs/agent-mode.md) and [consumer onboarding](docs/consumer-onboarding.md): bind a
proof plan, run its declared gates, import trusted signed evidence, and follow review and human-completion guards. The
quickstart does not complete a governed PR.

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
12. call `session next --json`; failed pre-PR proof returns to `implementing` without repair-budget use
13. after proof passes, enter `pre_pr_reviewing` and explicitly record a current-HEAD clean or changes-required pre-PR
    review outcome
14. repeat implementation, proof, and pre-PR review wakes until a clean outcome closes the phase at `reviewing`
15. after PR creation, import current signed review snapshots and follow their bounded repair, approval, and merge
    projections
16. verify and export the audit ledger for handoff or telemetry

Use `threadloop protocol --json` as the machine-facing contract for current commands, entry kinds, artifact kinds,
supported environment variables, and the published branch/rebase/PR workflow guidance.

The governed task lifecycle and schema-v8 contract are documented in [`docs/lifecycle.md`](docs/lifecycle.md). The
signed package and reusable workflow are specified in
[`docs/attestations/receipt-v2.md`](docs/attestations/receipt-v2.md) and
[`docs/attestations/review-v1.md`](docs/attestations/review-v1.md). `session transition` revalidates local, CI, and
review evidence and records every unique guard decision in the audit ledger.

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

- [Architecture and capability status](docs/architecture.md)
- [Domain glossary](CONTEXT.md)
- [Authority-model ADR](docs/adr/0001-sdlc-graph-authority-model.md)
- [CLI reference](docs/cli.md)
- [Consumer onboarding](docs/consumer-onboarding.md)
- [Autonomous agent mode](docs/agent-mode.md)
- [Governed lifecycle](docs/lifecycle.md)
- [Current lifecycle graph mapping](docs/current-lifecycle-graph-mapping.md)
- [Audit export and OpenTelemetry](docs/observability.md)
- [Contribution guide](CONTRIBUTING.md)

## Shared research

The
[harness engineering review](https://github.com/nnennandukwe/governed-agent-autonomy-patterns/blob/84fb12dae4fed69c684e59eb52c9272b14acac30/docs/research/2026-09-10-harness-engineering-review.md)
is the shared research snapshot dated September 10, 2026, for GAAP, ThreadLoop, and RunInvariant. The
[adoption decision tracker](https://github.com/nnennandukwe/governed-agent-autonomy-patterns/issues/29) records
candidate owners, prerequisites, next experiments, and implementation links. Candidates remain research proposals until
explicitly accepted into a repository roadmap.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
