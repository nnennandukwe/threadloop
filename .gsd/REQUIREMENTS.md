# Requirements

This file is the explicit capability and coverage contract for the project.

Use it to track what is actively in scope, what has been validated by completed work, what is intentionally deferred, and what is explicitly out of scope.

Guidelines:
- Keep requirements capability-oriented, not a giant feature wishlist.
- Requirements should be atomic, testable, and stated in plain language.
- Every **Active** requirement should be mapped to a slice, deferred, blocked with reason, or moved out of scope.
- Each requirement should have one accountable primary owner and may have supporting slices.
- Research may suggest requirements, but research does not silently make them binding.
- Validation means the requirement was actually proven by completed work and verification, not just discussed.

## Active

### R001 — Explicit session-scoped CLI
- Class: core-capability
- Status: active
- Description: ThreadLoop must support explicit session-scoped commands so orchestrators and agents can address a specific session by stable ID instead of relying on one implicit repo-wide active session.
- Why it matters: Autonomous agent workflows need deterministic addressing when multiple workspaces or worktrees are active.
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: none
- Validation: mapped
- Notes: Covers `session start|capture|status|list|finish|heartbeat` and stable `session_id` return behavior.

### R002 — Machine-readable JSON contract and stable errors
- Class: failure-visibility
- Status: active
- Description: Machine-consumed commands must support `--json` and return stable envelopes and error codes that are safe for orchestrators to parse.
- Why it matters: Agent automation breaks when output formats drift or when failures are only human-readable.
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: M001/S04, M001/S05
- Validation: mapped
- Notes: Includes contract alignment between real CLI behavior, protocol output, and documentation.

### R003 — Safe legacy convenience commands
- Class: continuity
- Status: active
- Description: Existing v1-style convenience commands must keep working in single-session repos and must fail clearly when zero or multiple matching sessions exist.
- Why it matters: The v2 transition must not silently break current human usage or guess the wrong session in ambiguous repos.
- Source: user
- Primary owning slice: M001/S01
- Supporting slices: M001/S05
- Validation: mapped
- Notes: Ambiguity behavior is part of the public contract, not an implementation detail.

### R004 — Mechanical reconcile and snapshot refresh
- Class: operability
- Status: active
- Description: ThreadLoop must support explicit reconcile flows that refresh Git-derived snapshot metadata for one session or all active sessions without creating semantic notes.
- Why it matters: Orchestrators need up-to-date branch, diff, and commit-range context, but semantic memory must remain intentional and trustworthy.
- Source: user
- Primary owning slice: M001/S02
- Supporting slices: M001/S03, M001/S05
- Validation: mapped
- Notes: Mechanical state and semantic capture must remain separated.

### R005 — Explicit-session artifact generation
- Class: core-capability
- Status: active
- Description: Artifact generation must work against an explicitly selected session and persist artifact metadata in SQLite while preserving human-friendly output.
- Why it matters: Multi-session workflows require deterministic artifact refresh for the right task without relying on implicit active state.
- Source: user
- Primary owning slice: M001/S02
- Supporting slices: M001/S05
- Validation: mapped
- Notes: Generated Git scope must continue excluding ThreadLoop-owned internal paths.

### R006 — Repo-local daemon for mechanical refresh only
- Class: operability
- Status: active
- Description: ThreadLoop must provide an optional repo-local daemon that periodically reconciles active sessions, refreshes configured artifacts, and shuts down cleanly without inventing semantic entries.
- Why it matters: Long-running agent workflows need background mechanical maintenance, but the daemon must not fabricate intent, decisions, risks, or notes.
- Source: user
- Primary owning slice: M001/S03
- Supporting slices: M001/S05
- Validation: mapped
- Notes: Operational correctness includes signal handling and safe concurrent access.

### R007 — Published orchestrator and agent protocol
- Class: integration
- Status: active
- Description: ThreadLoop must print the approved agent usage contract, including commands, environment variables, supported capture kinds, and JSON/text output forms.
- Why it matters: External orchestrators need one stable source of truth to inject into agent prompts and automation.
- Source: user
- Primary owning slice: M001/S04
- Supporting slices: M001/S01, M001/S05
- Validation: mapped
- Notes: Protocol output must stay aligned with the actual CLI surface.

### R008 — Operator-facing v2 documentation
- Class: launchability
- Status: active
- Description: The repo must document how to run ThreadLoop in autonomous agent workflows, including orchestrator flow, daemon role, environment variables, worktree assumptions, and human versus machine usage.
- Why it matters: The milestone is not launchable if a new contributor cannot understand how to use the system correctly.
- Source: user
- Primary owning slice: M001/S04
- Supporting slices: M001/S05
- Validation: mapped
- Notes: Docs must clearly distinguish semantic capture from mechanical reconcile.

### R009 — Integration and concurrency proof for v2 flows
- Class: quality-attribute
- Status: active
- Description: The milestone must include automated proof for migration, JSON CLI behavior, ambiguity handling, reconcile, daemon lifecycle, artifact refresh, and concurrent writes across orchestrator, agent, and daemon flows.
- Why it matters: V2 changes cross storage, CLI, Git snapshotting, and background lifecycle boundaries, so contract-only proof is not enough.
- Source: user
- Primary owning slice: M001/S05
- Supporting slices: M001/S01, M001/S02, M001/S03, M001/S04
- Validation: mapped
- Notes: Concurrency proof must verify no lost entries or corrupted state.

## Validated

### R010 — Local-first repo-scoped state and artifacts
- Class: primary-user-loop
- Status: validated
- Description: ThreadLoop stores task state inside the repository and generates local Markdown artifacts from that state and Git context.
- Why it matters: Repo-local operation is the foundation that makes ThreadLoop practical for day-to-day coding workflows.
- Source: execution
- Primary owning slice: M001/S00
- Supporting slices: none
- Validation: validated
- Notes: Present in the current codebase through `.threadloop/` storage, renderer modules, and the existing artifact commands.

### R011 — SQLite-backed state with legacy JSON migration
- Class: core-capability
- Status: validated
- Description: ThreadLoop uses SQLite as the durable source of truth and can migrate legacy `.threadloop/state/state.json` data without discarding the original file.
- Why it matters: V2 depends on a durable, transactional state layer and a safe upgrade path for existing repos.
- Source: execution
- Primary owning slice: M001/S00
- Supporting slices: none
- Validation: validated
- Notes: The current repo includes database bootstrap, schema versioning, migration logic, and README/CLI documentation reflecting this behavior.

### R012 — Human-friendly v1 CLI loop
- Class: continuity
- Status: validated
- Description: A human can initialize ThreadLoop, start a task, capture semantic entries, inspect status, generate an artifact, and finish the active session through the current CLI.
- Why it matters: M001 must preserve and extend this workflow rather than replace it blindly.
- Source: execution
- Primary owning slice: M001/S00
- Supporting slices: none
- Validation: validated
- Notes: Current commands are defined in `src/cli.ts` and implemented through `src/commands/*` and `src/services/session-service.ts`.

## Deferred

None currently.

## Out of Scope

### R020 — Transcript parsing as a source of truth
- Class: anti-feature
- Status: out-of-scope
- Description: ThreadLoop will not infer task state by parsing coding-agent transcripts in this milestone.
- Why it matters: This prevents the project from drifting away from explicit, durable CLI-based capture.
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: The orchestrator and agents must call the stable CLI contract directly.

### R021 — Daemon-generated semantic notes
- Class: anti-feature
- Status: out-of-scope
- Description: The daemon must not create intent, decision, risk, note, or validation entries on behalf of users or agents.
- Why it matters: Mechanical refresh and semantic memory must remain separate to preserve trust in stored context.
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: The daemon is limited to mechanical reconciliation and artifact refresh.

### R022 — Same-checkout multi-task concurrency
- Class: constraint
- Status: out-of-scope
- Description: M001 does not promise multiple concurrent tasks sharing the exact same checkout.
- Why it matters: This keeps the concurrency model bounded around distinct workspaces or worktrees.
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: The milestone focuses on multi-session workflows across distinct workspaces or worktrees.

### R023 — Automatic commit creation
- Class: anti-feature
- Status: out-of-scope
- Description: ThreadLoop will not create Git commits automatically in this milestone.
- Why it matters: Commit control remains with the human or orchestrator, which avoids unexpected repository mutations.
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: Artifact and snapshot features stop short of write-side Git automation.

### R024 — GitHub API integration inside M001
- Class: constraint
- Status: out-of-scope
- Description: ThreadLoop will not integrate with the GitHub API as part of this milestone.
- Why it matters: This prevents scope creep away from the local CLI control-plane contract.
- Source: user
- Primary owning slice: none
- Supporting slices: none
- Validation: n/a
- Notes: The GitHub issue epic provided planning context only.

## Traceability

| ID | Class | Status | Primary owner | Supporting | Proof |
|---|---|---|---|---|---|
| R001 | core-capability | active | M001/S01 | none | mapped |
| R002 | failure-visibility | active | M001/S01 | M001/S04, M001/S05 | mapped |
| R003 | continuity | active | M001/S01 | M001/S05 | mapped |
| R004 | operability | active | M001/S02 | M001/S03, M001/S05 | mapped |
| R005 | core-capability | active | M001/S02 | M001/S05 | mapped |
| R006 | operability | active | M001/S03 | M001/S05 | mapped |
| R007 | integration | active | M001/S04 | M001/S01, M001/S05 | mapped |
| R008 | launchability | active | M001/S04 | M001/S05 | mapped |
| R009 | quality-attribute | active | M001/S05 | M001/S01, M001/S02, M001/S03, M001/S04 | mapped |
| R010 | primary-user-loop | validated | M001/S00 | none | validated |
| R011 | core-capability | validated | M001/S00 | none | validated |
| R012 | continuity | validated | M001/S00 | none | validated |
| R020 | anti-feature | out-of-scope | none | none | n/a |
| R021 | anti-feature | out-of-scope | none | none | n/a |
| R022 | constraint | out-of-scope | none | none | n/a |
| R023 | anti-feature | out-of-scope | none | none | n/a |
| R024 | constraint | out-of-scope | none | none | n/a |

## Coverage Summary

- Active requirements: 9
- Mapped to slices: 9
- Validated: 3
- Unmapped active requirements: 0
