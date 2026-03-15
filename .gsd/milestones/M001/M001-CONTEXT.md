# M001: Autonomous agent mode — Context

**Gathered:** 2026-03-14
**Status:** Ready for planning

## Project Description

ThreadLoop is evolving from a single-session, human-oriented repo-local CLI into a generic control plane for orchestrated coding-agent workflows. M001 completes the v2 transition by preserving the current local-first artifact workflow while adding explicit session addressing, machine-readable CLI contracts, mechanical reconcile flows, optional background maintenance, and end-to-end proof that the assembled system works safely in multi-session environments.

## Why This Milestone

The current codebase already contains the storage foundation for v2, including SQLite-backed state and migration from legacy JSON state. What is still missing is the explicit contract and operational behavior that make ThreadLoop usable by orchestrators and agents in real workflows. This milestone matters now because the value proposition depends on deterministic session addressing, inspectable failures, trustworthy mechanical refresh, and documentation that tells humans and machines how to interact with the tool correctly.

## User-Visible Outcome

### When this milestone is complete, the user can:

- start, inspect, update, finish, and reconcile specific sessions through an explicit CLI contract that is safe for orchestrators and coding agents to parse
- run an optional repo-local daemon that refreshes active sessions and artifacts mechanically while preserving semantic capture boundaries

### Entry point / environment

- Entry point: `threadloop` CLI commands, including explicit `session` subcommands, reconcile commands, daemon commands, protocol output, and artifact generation
- Environment: local development inside Git repositories, including distinct workspaces and worktrees
- Live dependencies involved: Git repository state, SQLite database at `.threadloop/state/state.db`, filesystem artifacts, optional long-running daemon process

## Completion Class

- Contract complete means: CLI commands, JSON envelopes, error codes, protocol output, and documented environment variables are stable and test-covered
- Integration complete means: session commands, reconcile flows, artifact generation, and daemon behavior work together against real repo state and SQLite persistence
- Operational complete means: background reconcile lifecycle, signal handling, and concurrent access from orchestrator, agent, and daemon flows are exercised without corrupting state or inventing semantic entries

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- a real repo can migrate into SQLite-backed state, start a session with machine-readable output, capture semantic entries, reconcile mechanical Git state, generate artifacts for an explicit session, and finish cleanly
- a repo with ambiguous active sessions fails legacy convenience commands with a clear session-required response instead of guessing
- the daemon can start, perform interval-based reconcile work for active sessions, refresh artifacts, and shut down cleanly while concurrent writes preserve durable state and semantic integrity

## Risks and Unknowns

- CLI contract drift between text output, JSON output, docs, and protocol print — if these diverge, orchestrator integrations will be brittle
- Mechanical and semantic boundaries may blur during reconcile or daemon work — if the daemon creates notes or inferred state, the product loses trust
- SQLite concurrency and lifecycle correctness under orchestrator-plus-agent-plus-daemon access — if writes block incorrectly or state is corrupted, the control plane fails under real use
- Legacy v1 convenience behavior may regress during the transition to explicit session addressing — current human workflows must stay usable in the safe single-session case

## Existing Codebase / Prior Art

- `src/cli.ts` — current v1 command surface and global error handling
- `src/services/session-service.ts` — orchestration layer for init, start, capture, status, artifact generation, and finish
- `src/adapters/fs/sqlite-store.ts` — SQLite schema bootstrap, migration from legacy JSON state, transactional writes, and artifact persistence
- `src/adapters/git/client.ts` — repo snapshotting, base-ref validation, and Git-derived mechanical context
- `src/renderers/markdown/artifacts.ts` — artifact rendering path that v2 explicit-session generation must preserve
- `README.md` and `docs/cli.md` — current public contract and baseline documentation to evolve for v2
- `tests/integration/cli.test.ts` — existing integration test surface that can anchor v2 contract verification

> See `.gsd/DECISIONS.md` for all architectural and pattern decisions — it is an append-only register; read it during planning, append to it during execution.

## Relevant Requirements

- R001 — introduce explicit session-scoped commands and stable session IDs
- R002 — publish machine-readable JSON envelopes and stable errors
- R003 — preserve safe legacy convenience behavior
- R004 — add reconcile and snapshot persistence without semantic pollution
- R005 — support explicit-session artifact generation
- R006 — add repo-local daemon lifecycle for mechanical refresh
- R007 — expose protocol print for orchestrator and agent integration
- R008 — document the v2 autonomous agent workflow
- R009 — prove the assembled system under integration and concurrency conditions

## Scope

### In Scope

- explicit session namespace commands and JSON output
- stable machine-readable errors and session-addressed flows
- safe legacy wrappers for the single-session case
- reconcile commands and persisted snapshot metadata
- artifact generation by explicit session
- optional daemon loop for active sessions
- protocol print and autonomous-agent documentation
- integration and concurrency verification for the v2 contract

### Out of Scope / Non-Goals

- transcript parsing as a product capability
- daemon-authored semantic notes or inferred intent
- same-checkout multi-task concurrency guarantees
- automatic Git commit creation
- GitHub API integration inside M001

## Technical Constraints

- preserve the local-first repository model and `.threadloop/` storage layout
- keep `.threadloop/state/` excluded from Git-derived artifact scope
- preserve SQLite as the durable source of truth and keep migration-safe behavior for legacy repos
- keep the CLI usable by humans while adding a machine-safe contract for orchestrators
- use English for documentation and comments
- avoid unpinned dependency changes unless they are actually required by the milestone

## Integration Points

- Git working tree — reconcile and artifact generation derive branch, diff, and commit context from real repo state
- SQLite state database — all v2 session, snapshot, and artifact metadata persist through `.threadloop/state/state.db`
- filesystem artifacts — change briefs, PR summaries, and handoff documents remain repo-local outputs
- orchestrator and coding-agent prompts — protocol print becomes the integration surface for external automation
- optional daemon process — periodically performs mechanical refresh work across active sessions

## Open Questions

- whether `heartbeat` should update a lightweight session timestamp only or also gate active-session liveness decisions — current expectation is to keep it lightweight and mechanical
- whether protocol print should be a dedicated top-level command or a nested subcommand — both fit the epic wording, so final CLI shape should optimize discoverability and contract stability
- whether artifact refresh should be daemon-configured or always-on for certain artifact types — current expectation is configurable refresh behavior tied to active sessions
