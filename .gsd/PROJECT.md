# Project

## What This Is

ThreadLoop is a local-first CLI for AI-assisted coding workflows. It preserves task intent, decisions, risks, validation notes, and reviewer guidance in repo-local state, then renders that context into review-ready artifacts. The current codebase already supports a v1 single-session flow and has introduced SQLite-backed storage with legacy JSON migration. This planning pass defines M001 as the completion of ThreadLoop v2 autonomous agent mode.

## Core Value

A human or orchestrator can run ThreadLoop as a stable, explicit session-memory control plane for coding agents without relying on transcript parsing.

## Current State

- A working CLI exists with `init`, `start`, `capture`, `status`, `artifact generate`, and `finish`.
- State is stored in `.threadloop/state/state.db` with migration support from legacy `.threadloop/state/state.json`.
- Markdown artifact generation already exists for `change-brief`, `pr-summary`, and `handoff`.
- The current UX is still primarily v1-style and single-session oriented.
- Explicit session namespace commands, machine-stable JSON contracts, reconcile flows, daemon support, protocol print, and full v2 integration coverage are not yet complete.

## Architecture / Key Patterns

- TypeScript CLI built with Commander and packaged via `tsup`.
- Repo-local storage under `.threadloop/` with SQLite as the durable state layer.
- Service-oriented orchestration in `src/services/session-service.ts` with adapters for filesystem and Git access.
- Markdown renderers in `src/renderers/markdown/` generate review and handoff artifacts from stored task/session context.
- Git-derived context is treated as mechanical state and must remain separate from semantic entries captured by humans or agents.

## Capability Contract

See `.gsd/REQUIREMENTS.md` for the explicit capability contract, requirement status, and coverage mapping.

## Milestone Sequence

- [ ] M001: Autonomous agent mode — complete the v2 session contract, mechanical reconcile flows, daemon support, protocol output, docs, and end-to-end proof on top of the current SQLite foundation.
