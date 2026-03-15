# Decisions Register

<!-- Append-only. Never edit or remove existing rows.
     To reverse a decision, add a new row that supersedes it.
     Read this file at the start of any planning or research phase. -->

| # | When | Scope | Decision | Choice | Rationale | Revisable? |
|---|------|-------|----------|--------|-----------|------------|
| D001 | M001 | scope | Milestone authority | Use GitHub epic #2 and linked issues #3-#11 as the authoritative M001 planning scope | The user confirmed the epic issue set is the source of milestone intent | No |
| D002 | M001 | scope | Current-state baseline | Plan from actual codebase reality instead of issue status alone | The repo already contains SQLite-backed state and migration work, so planning must reflect what exists rather than stale issue state | No |
| D003 | M001 | arch | V2 control-plane boundary | Keep ThreadLoop as an explicit CLI- and state-driven control plane rather than a transcript-parsing system | The epic defines stable CLI contracts and durable session memory as the product boundary | No |
| D004 | M001 | convention | Mechanical versus semantic separation | Reconcile and daemon flows may refresh mechanical state and artifacts but must never invent semantic entries | Trust in stored task context depends on preserving intentional semantic capture boundaries | No |
| D005 | M001 | scope | Milestone exclusions | Exclude transcript parsing, daemon-authored semantic notes, same-checkout multi-task concurrency, auto-commit behavior, and GitHub API integration from M001 | These are explicit non-goals in the epic and prevent scope creep away from the local control-plane contract | Yes — if later milestone scope changes |
| D006 | M001 | pattern | Planning strategy | Use a final explicit integration slice to prove the assembled CLI, reconcile, daemon, protocol, and concurrency model end-to-end | The milestone crosses multiple runtime and lifecycle boundaries, so contract-only proof is insufficient | No |
