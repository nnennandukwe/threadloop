# M001: Autonomous agent mode

**Vision:** Complete ThreadLoop v2 as a stable, repo-local control plane for orchestrated coding-agent workflows by extending the current SQLite-backed foundation into explicit session-scoped commands, safe machine-readable contracts, mechanical reconcile and daemon behavior, protocol and documentation surfaces, and end-to-end proof that the assembled system works without corrupting state or inventing semantic notes.

## Success Criteria

- Orchestrators and agents can start, inspect, update, reconcile, artifact, and finish explicit sessions through stable CLI commands and `--json` output.
- Human users can keep using legacy convenience commands in the single-session case, and ambiguous cases fail clearly instead of guessing.
- Reconcile and daemon flows refresh Git-derived metadata and artifacts mechanically without creating semantic entries.
- Protocol output and documentation match the real CLI contract closely enough for a new contributor to run the v2 workflow correctly.
- Integration and concurrency verification proves migration, JSON behavior, ambiguity handling, mechanical refresh, daemon lifecycle, and state durability under concurrent access.

## Key Risks / Unknowns

- CLI contract drift across real command behavior, JSON envelopes, protocol output, and docs — this would break orchestrator integrations.
- Mechanical refresh may leak into semantic capture during reconcile or daemon work — this would undermine trust in ThreadLoop memory.
- Concurrent access from orchestrator, agent, and daemon flows may expose SQLite locking or corruption issues — this would invalidate the operational model.
- Preserving safe human-friendly legacy behavior during the transition to explicit session addressing may be harder than the new command surface itself.

## Proof Strategy

- CLI contract drift across commands, JSON, protocol, and docs → retire in S01 and S04 by proving the real session commands exist with stable machine output and the published protocol matches them.
- Mechanical refresh leaking into semantic capture → retire in S02 and S03 by proving reconcile and daemon updates are mechanical-only and do not create semantic entries.
- Concurrent access across orchestrator, agent, and daemon flows → retire in S05 by proving concurrent writes and interval refresh complete without lost entries or corrupted state.
- Legacy convenience regressions during the shift to explicit sessions → retire in S01 and S05 by proving single-session compatibility and explicit ambiguity failures.

## Verification Classes

- Contract verification: integration tests, CLI JSON fixtures, artifact output checks, and protocol-content assertions
- Integration verification: real Git repo interaction, SQLite persistence, session-addressed artifact generation, and explicit reconcile flows
- Operational verification: daemon start/stop lifecycle, interval reconcile behavior, signal handling, and concurrent access proof
- UAT / human verification: a maintainer follows the documented autonomous-agent workflow in a real repo and confirms the contract is understandable

## Milestone Definition of Done

This milestone is complete only when all are true:

- all slice deliverables are complete and mapped requirements are satisfied at the promised proof level
- explicit session commands, legacy wrappers, reconcile, artifact generation, daemon behavior, protocol output, and docs are actually wired together
- the real `threadloop` entrypoint exists and is exercised through v2 session flows rather than only isolated helpers
- success criteria are re-checked against live behavior and automated verification, not just planned interfaces
- final integrated acceptance scenarios pass, including concurrency and daemon lifecycle proof

## Requirement Coverage

- Covers: R001, R002, R003, R004, R005, R006, R007, R008, R009
- Partially covers: none
- Leaves for later: none
- Orphan risks: none

## Slices

- [ ] **S01: Session namespace and compatibility contract** `risk:high` `depends:[]`
  > After this: explicit `threadloop session ...` flows and `--json` output work for core session operations, and legacy convenience commands remain safe in the single-session case with clear ambiguity failures.

- [ ] **S02: Reconcile and explicit-session artifact refresh** `risk:high` `depends:[S01]`
  > After this: a caller can reconcile one session or all active sessions, persist updated Git snapshots, and generate artifacts deterministically for an explicit session without polluting semantic memory.

- [ ] **S03: Repo-local daemon lifecycle** `risk:medium` `depends:[S02]`
  > After this: an optional daemon can mechanically refresh active sessions and configured artifacts on an interval and shut down cleanly.

- [ ] **S04: Published protocol and operator docs** `risk:medium` `depends:[S01,S02]`
  > After this: ThreadLoop can print its agent-orchestrator usage contract in text and JSON forms, and the docs explain how to run the v2 workflow correctly.

- [ ] **S05: Integrated v2 proof and concurrency hardening** `risk:high` `depends:[S01,S02,S03,S04]`
  > After this: automated verification proves migration, JSON contracts, ambiguity handling, reconcile, daemon lifecycle, artifact refresh, and concurrent write safety across the assembled system.

## Boundary Map

### S01 → S02

Produces:
- `threadloop session start|capture|status|list|finish|heartbeat` command surface
- stable `session_id` addressing rules and JSON envelope conventions
- legacy command resolution policy: auto-resolve only when exactly one active session exists for the current workspace
- stable machine error codes for missing, zero-match, and ambiguous-session failures
- persisted session records shaped for multi-session lookup rather than single implicit active-state assumptions

Consumes:
- current SQLite-backed task/session storage and migration baseline from the existing codebase

### S01 → S03

Produces:
- explicit active-session registry semantics that the daemon can enumerate safely
- JSON and error contract rules the daemon-facing commands must preserve
- compatibility invariants preventing daemon behavior from breaking single-session human workflows

Consumes:
- current SQLite-backed task/session storage and migration baseline from the existing codebase

### S01 → S04

Produces:
- canonical session command names, flags, JSON envelopes, and error codes to document
- approved environment variable list and machine-facing session workflow shape

Consumes:
- current CLI naming and packaging conventions from the existing codebase

### S02 → S03

Produces:
- persisted repo snapshot model for branch, head SHA, changed files, diff stats, commit range, and last reconcile metadata
- `threadloop reconcile --session <id>` and `threadloop reconcile --all` flows
- explicit-session artifact generation contract and persisted artifact metadata
- invariant that reconcile and artifact refresh do not create semantic entries

Consumes from S01:
- explicit session IDs and session lookup/error behavior
- stable JSON output conventions for machine-consumed commands

### S02 → S04

Produces:
- real reconcile and explicit-session artifact commands to publish in protocol output and docs
- actual environment and workflow assumptions for orchestrator usage

Consumes from S01:
- command naming, flag shapes, and JSON contract conventions

### S03 → S05

Produces:
- daemon run command, interval behavior, signal-handling lifecycle, and active-session refresh loop
- concurrency-sensitive write paths exercised under background refresh conditions
- invariant that daemon work is mechanical only

Consumes from S02:
- reconcile engine and explicit-session artifact refresh behavior

### S04 → S05

Produces:
- protocol print command and documentation assertions that can be tested against live CLI behavior
- operator-facing workflow documentation for human verification

Consumes from S01 and S02:
- actual CLI contract and workflow semantics

### S05 → Milestone completion

Produces:
- integrated test coverage for migration, JSON CLI, ambiguity handling, reconcile, daemon lifecycle, artifact refresh, and concurrency
- proof that `.threadloop` internal paths remain excluded from Git-derived artifact scope across tested flows
- final evidence that the milestone contract holds in the assembled system

Consumes from S01, S02, S03, S04:
- the complete v2 command surface, mechanical refresh model, daemon lifecycle, and published protocol/docs
