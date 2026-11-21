# ThreadLoop Controller Runtime and Rust Prerequisites Build Plan

Track delivery in [runtime milestone #4](https://github.com/nnennandukwe/threadloop/milestone/4). The
[implementation tracker](https://github.com/nnennandukwe/threadloop/issues/168) records which prerequisites have passed
review and verification.

## Summary

Outcome: finish ThreadLoop's documented pre-Rust runtime/storage prerequisites in TypeScript, using the accepted
controller contracts and the already delivered GAAP bridge.

Authority: Nnenna's current request to create the controller-runtime implementation plan and start a larger Goal to
finish the Rust rewrite prerequisites. Existing scope comes from issue #110's runtime gate, issue #85's storage
acceptance, the architecture/authority ADR, the frozen threadloop-contracts v0.1.0 families and M003's prerequisite
boundaries.

Baseline: origin/main 7c54c2bb8055f00736e3b5f6631e9aecbe0fd212, verified November 21. Both main and the installed
lockfile pin threadloop-contracts 4ed9a94a2a089b9ae950d93297f7a6b9b939d3a6. Refresh before execution and preserve
completed #111/#112/#86/#88/#164 work.

Review units: this is an explicitly requested multi-build program. Deliver the five units below as separate coherent
PRs, with a canonical Software Build Plan for each unit before its production changes.

Primary boundary: implement the accepted configurable workflow behavior and prove readiness for a later Rust rewrite.
The Rust replacement itself stays outside this Goal.

## Skills To Use

| Stage                     | Skills                                          | Responsibility and evidence                                                                                                                                                            |
| ------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context and rules         | qodo-get-rules, qodo-codebase-wisdom            | Apply current ThreadLoop standards and inspect the actual public contract surfaces before locking each unit. Retain rule references and applicability.                                 |
| Runtime design            | codebase-design, workflow-invariants            | Put full selection behavior behind a small production interface and write explicit workflow state/authority invariants from the accepted contracts.                                    |
| Durable state             | transaction-proof, sqlite-concurrency-hardening | Record commit points, ownership, fault matrix and lifecycle proof before production persistence/migration edits. Test independent connections, CAS, replay, interruption and recovery. |
| Behavioral implementation | tdd, failure-path-testing                       | Implement one public behavior at a time; use the same state/fault model for refusal, recovery and regression tests.                                                                    |
| Developer surfaces        | cli-interactive-parity                          | Keep command/help/text/JSON/protocol/docs/runner/package behavior aligned with an explicit compatibility policy.                                                                       |
| Review/delivery           | qodo-review, qodo-review-resolver               | Complete local review of each final complete diff, assess supported findings and require a completed current-head hosted review plus CI before merge.                                  |
| Written artifacts         | voice-canon                                     | Apply the current language rules and verify_language.py to plans, docs, messages and evidence.                                                                                         |

Qodo Local Review eligibility: Git with a pushed reviewable origin/main base and prior successful Qodo use. Recheck
current review access in the implementation worktree. An eligible runtime/auth/transport failure remains a
failed/unavailable review, not a passing result or an eligibility skip.

Current scoped standards were retrieved through Qodo CLI 2.4.0. ERROR 1060877 requires producer/consumer schema
coordination and ERROR 1060865 requires exhaustive enum-consumer handling. ERROR
1060879/1060853/1060863/1060851/1060843/1060888/1060842 apply to changed shared fields, parameters, config and aliases.
WARNING 1 requires immutable changed dependency pins/lockfiles; WARNING 699152/613754/8184/7205 governs descriptive
English identifiers/text. Apply only relevant requirements; Python/Pydantic, Swift and PortalConfig-specific results
don't govern this TypeScript stack.

Coverage: the frozen glossary/ADRs define domain terms; no domain renaming or new graph language is needed.
TypeScript/Node and SQLite are the current implementation stack. No Rust, Python-typing, frontend or infrastructure
skill is selected for the core implementation. Read any additionally triggered skill before its actual stage.

## Scope

In scope:

1. Issue #85 compatibility policy, storage adoption, operation-scoped validation and runner compatibility.
2. Full deterministic controller selection from the frozen graph/input contracts.
3. Durable graph-bound Workflow Runs with explicit create/inspect/decide/apply operations and legacy-compatible
   developer surfaces.
4. Selected-action execution and evidence integration through the existing GAAP process/claims/Attempts/admission
   machinery.
5. External real-controller conformance, persistence/failure proof, a governed end-to-end workflow and refreshed
   pre-Rust parity evidence.

Out of scope:

- The Rust rewrite, Rust packaging/release or switching the default CLI implementation.
- Rewriting completed GAAP bridge/signing/isolation/contract/export work or adopting GAAP ADR 0009 recovery by
  implication.
- Arbitrary executable graph nodes, schedulers, a general DAG engine, cloud sync or new orchestration infrastructure.
- New paid model/provider trials, external account changes or real human approvals fabricated as test evidence.
- Changes to frozen expected outcomes, canonical identities or historical receipts merely to make new code pass.

## Package Layout / File-to-Task Mapping

Existing paths are relative to the implementation worktree:

- src/domain/types.ts, src/schemas/state.ts, src/domain/session-transition.ts: preserve closed legacy TaskStatus/state
  validation, planNextTransition and fixed lifecycle guards.
- src/services/session-service.ts and src/adapters/fs/sqlite-store.ts: preserve legacy services, transactional
  CAS/replay/audit patterns and implement scoped #85 storage compatibility. The fixed applySessionTransition always
  evaluates the legacy structural matrix; it isn't a generic graph-transition API.
- src/domain/proof.ts: retain the authoritative ordinary gate-result domain.
- src/services/gaap-executor.ts and src/adapters/fs/gaap-state.ts: reuse registration/run/admit/inspect, durable
  claims/Attempts and executor.sqlite state. Current evaluateGaapController validates outgoing candidates and records
  lifecycle_mutated:false; full selection/application is new runtime work.
- src/cli-program.ts, src/cli.ts, src/contracts/protocol.ts, src/commands/protocol.ts and
  .agents/skills/threadloop-runner/SKILL.md: command registration, protocol negotiation, runner expectations and
  installed-package integration.
- src/domain/audit.ts and existing export readers: preserve audit-v1 canonical bytes/hashes and #86/#88 outputs.
- Existing tests/integration/session-transition.test.ts, session-gate.test.ts, cli.test.ts, runner-replay.test.ts;
  tests/unit/state-schema.test.ts, read-snapshot.test.ts; generated controller and GAAP process/fault tests: extend
  relevant behavior seams without presenting old candidate/journal tests as full controller proof.

Proposed new modules, whose final names can be settled in the per-unit plan:

- src/domain/workflow-controller.ts: pure production selector over canonical graph/input facts.
- src/services/workflow-runtime.ts: graph-run decisions/application and selected execution orchestration.
- src/adapters/fs/workflow-store.ts plus explicit graph-run types/schemas: immutable graph/run records and transactional
  state/events, sharing the existing database ownership/lifecycle pattern where appropriate.
- src/commands/workflow.ts: explicit bounded workflow operations, with documented protocol compatibility.
- A real external controller-subject adapter/script: consumes only normalized requests and invokes production behavior.
  It mustn't read fixture IDs, expected outcomes or golden files.
- docs/plans/controller-runtime-rust-prerequisites.md, per-unit plans/ADRs and a pre-Rust evidence report: tracked
  program/checklists, compatibility decisions and exact-head proof. Add only modules justified by the implementation
  interface, not pass-through wrappers.

## Dependencies And Settings

Retain the existing locked TypeScript/Node toolchain, SQLite adapter and published threadloop-contracts APIs. Use
host-native Node ^22.22.2 || ^24.15.0 || >=26.0.0. Avoid new dependencies unless a documented requirement can't be met
by existing ones.

Treat storage integer 8 as the existing compatibility generation for proven additive additions. Reject unknown breaking,
future and malformed generations. Keep version 7's existing explicit-init boundary. No broad minimum-version acceptance.

Keep frozen workflow/controller/execution/executor/conformance identities and schemas unchanged. An explicit new CLI
protocol/capability view may be needed for new commands; retain a supported legacy view and reviewed runner
compatibility. No silent regeneration of protocol v4 content under an unchanged promise. Existing reviewed runner
files/hashes remain historical facts.

Introduce no new environment variable by default. Retain executor.sqlite separation and its ownership rules. The program
won't add a cloud service, runtime scheduler or deployment target.

## Canonical Contracts

Storage:

- A compatible additive change requires no breaking generation bump or operator migration. Capability claims are derived
  from actual validated shape, not trusted metadata alone.
- Split stable core shape requirements from operation-specific optional feature shape. Old session reads can't become
  corrupt merely because optional graph tables are absent. Read-only status/next/export stays byte-preserving and
  doesn't migrate.
- Resolve ordinary gate_receipts.result's duplicated SQL enum once through a transactional adoption conversion. Prefer a
  domain-seeded value catalog with unconditional INSERT validation so raw invalid values remain rejected even on a
  connection with FK enforcement off. Future enum additions change catalog data rather than require DDL/table rebuilds.
- Preserve signed_gate_receipts.result='passed', structural/FK/unique/NOT NULL constraints and append-only
  update/delete/replace defenses. Don't remove signed authority invariants with ordinary enum extensibility.
- Document the one-time adoption separately from the future additive path and prove rollback/restart and historical byte
  identity.

Selection:

- Use the normative precedence: input validation, outstanding execution obligations, terminal handling, verified input
  facts, eligible transition priority, exhaustive remedy selection.
- Produce the six defined outcomes from canonical facts. Ties remain AMBIGUOUS_REMEDY; missing remedies remain
  NO_APPLICABLE_REMEDY. Identical canonical inputs yield identical output.
- Implement complete applicability/priority/remedy logic rather than validating one supplied candidate or selecting from
  expected fixture labels.
- Human actions stay human handoffs. Undeclared/unavailable executor capabilities can't launch.

Workflow state:

- Store immutable canonical graph bytes/schema/digest and bind each new Workflow Run for its lifetime. Profile edits
  don't silently replace that binding.
- Keep configurable node IDs out of legacy TaskStatus; don't retroactively convert existing sessions.
- Creation atomically commits the binding, initial state/version and authoritative events. Decisions are pure
  observations; apply requires fresh version/evidence/authority and a deliberate request.
- Commands will provide explicit create/inspect/decide/apply behavior. Their final spelling, JSON shape and protocol
  negotiation must be locked and tested in unit 3's plan before implementation.
- Preserve CAS, exact replay, identity/content conflicts, stale evidence refusal, declared budgets, human completion and
  recovery authority.

Execution:

- Build engineering Action Requests from the selected action and its current run/graph/subject/policy/authority
  identities.
- Reuse existing host-adopted claims, Attempts, bounded process invocation, signed admission and durable reevaluation.
- Admission and outer-run application remain separate committed facts across separate databases. Child success alone
  can't complete or advance an outer Workflow Run.
- Recover the case where child evidence committed but outer reporting failed by reading correlated durable state and
  reevaluating, without reexecuting a completed/uncertain effect.
- New GAAP production persistence isn't a prerequisite for implementing this ThreadLoop runtime.

## TDD And BDD Implementation Strategy

Five sequential delivery units:

1. Storage compatibility: first reproduce the additive-version/runner problem. Prove generation/capability behavior,
   initial adoption, enum extension without repeated DDL, legacy reads and byte-preserved evidence.
2. Pure selector: implement one normative outcome/precedence case at a time, including exhaustive ambiguous remedies and
   human handoffs. Test real public interfaces with independent expected facts.
3. Durable graph runs and CLI: create/reopen/inspect, validate immutable bindings, then decide/apply under
   version/evidence CAS. Use a graph with different node identifiers/topology to prove configuration drives behavior.
   Add protocol/runner/package parity.
4. Bridge orchestration: generate selected requests, execute through existing claims/Attempts, admit authenticated
   evidence and reevaluate/apply from fresh outer state. Prove failure and lost-response cuts.
5. Independent conformance/E2E/parity: run the real subject through the frozen external harness and then prove a
   governed workflow through current proof/review and the actual human completion gate. Refresh pre-Rust parity and
   rollback evidence.

Each unit gets its own canonical Software Build Plan, traceable issue/PR and final verification/review. Keep tests with
the behavior they prove. No bulk speculative test suite before the first executable slice.

## Component Design

Keep a deep pure selection module behind a small interface. Production CLI, external conformance subject and
orchestration call that same behavior; the test adapter can't implement a second selector or consult oracle files.

A separate explicit graph-run model will preserve legacy task/session behavior. Store canonical graphs/bindings and
transactional versions/events with one owner for each write. Reuse BEGIN IMMEDIATE and consistent independent-reader
snapshots. New optional feature tables don't expand legacy read requirements.

The existing executor database retains execution/admission ownership. The workflow module owns outer lifecycle
application and durable correlation/reconciliation. A sequence of writes to the two databases isn't one transaction.
Define intent/commit/readback/reevaluation recovery for every cross-database cut before production orchestration edits.

## Failure And Recovery Rules

Before persistence/migration/orchestration changes, use transaction-proof to record all four gate items: exact
commit-point model, ownership invariants, operation-level fault matrix and complete lifecycle evidence.

- Unknown/malformed generation, missing required feature shape, damaged graph bytes or mismatched identity rejects
  before mutation, preserving the source for diagnosis.
- Failed initial adoption rolls back canonical state/triggers/data or leaves a bounded documented recovery state; it
  can't overwrite another writer.
- Concurrent/stale applies fail through CAS and evidence/authority checks. Identical replay returns its recorded result;
  changed bytes under reused identity conflict.
- Missing graph, altered profile, stale subject/policy, expired claim/authority or unavailable capability blocks
  dispatch/application with an executable recovery action.
- Kill/interruption before and after graph-state commit, launch, effect/admission commit and outer application must
  preserve independently observed facts. Unknown effects hold for reconciliation.
- Post-commit cleanup/reporting failure is reported as committed-with-warning when appropriate, not as permission to
  execute again.
- Human approval/merge observations are evidence with the contract's actual identity/freshness requirements; a fixture
  signer or blanket coding permission can't be reported as an observed human approval.

## Commit Plan

Use one branch/PR per delivery unit:

1. #85 compatibility decision, meaningful failing regression, transactional adoption and compatibility proof.
2. Selector interface plus one outcome at a time and complete precedence/remedy coverage.
3. Graph binding/run storage and bounded command/protocol behavior with restart/concurrency tests.
4. Selected execution, durable admission/application correlation and fault/recovery tests.
5. Real external subject, full conformance/E2E evidence and refreshed pre-Rust parity report.

Within a unit, keep plan/behavior/test commits coherent. Commit only owned changes before Qodo checkpoint/final review.

## Branch And PR Flow

1. Fetch and use current origin/main in fresh isolated worktrees, preserving the original checkout, existing branches
   and the old staged threadloop-actions-20261113 worktree. Read current AGENTS.md, CONTRIBUTING.md and nested guidance.
2. Save this program plan before product edits. The user's current instruction authorizes this documented
   runtime/prerequisite program. Create the source-derived controller-runtime implementation tracker/milestone and
   bounded issue links if required by #110 and CONTRIBUTING, without reopening the closed contract-freeze tracker or
   inventing features. Reuse #85 for its acceptance.
3. For each unit, lock its canonical plan/interfaces, apply Qodo rules, implement vertical slices and run focused plus
   full checks. Pin the pushed merge-base, attach decisions/actual evidence/recent_work and review the complete intended
   local diff. Use fast async checkpoints for completed milestones and auto depth for final review.
4. Reproduce and assess findings, fix supported actionable issues, rerun affected/full checks and review changed final
   heads. Require a completed structured hosted review at the PR head and current required CI. Prefer automatic fix
   re-attribution; stored dismissals require specific user authorization. Undocumented review_complete metadata isn't an
   extra gate.
5. Recheck the exact head/gates, safely merge with the reviewed SHA, compare merged trees and verify post-merge CI.
   Rebase/reconcile later units from observed merged predecessors without force-pushing shared work. Update trackers
   only to the level actually proved.

Bound review runtime/access failures according to the skills and retain required gaps. Public release/package
publication, global configuration changes and the Rust rewrite aren't part of this delivery authority.

## Test Plan

Native checks per unit:

```bash
npm ci
npm run check
npm run security:dependencies
git diff --check origin/main...HEAD
```

Use narrower `npm test -- <paths>` and existing npm run test:controller scripts for iteration. npm run check includes
static checks, tests, build and packaged-install smoke. Keep current supported Node/OS CI and security checks. Don't
claim new behavior is proved by old-head checks.

Storage/runtime proof must include independent database connections and actual production readers, raw invalid inserts,
immutable record/trigger enforcement, old schema-8 reads without graph features, version-7 behavior, unknown future
generation rejection, adoption cuts, graph-create rollback, missing/mismatched bindings, deterministic replay,
concurrency, stale version/evidence and lost commit responses. Verify historical signed/audit/export bytes
independently.

Conformance: use the existing RunInvariant external harness and frozen 38-case corpus. RunInvariant main
54be0d2240c44ee11b65d5e278a2cb667ee523b4 currently pins the identical corpus at ThreadLoop
fde510deca780c7cada8a2e461bd15af0fe4ae88; corpus digest
11620588c6f4b39353ea9f77e361a50b5cb0dc970410b1ac10aa8bef13efad84. Confirm exact full revisions and all schema/corpus
hashes before execution. The threadloop-contracts pin contains the same frozen assets. Don't change the corpus or use
the synthetic subject that reads fixture.expected. The real subject consumes normalized requests and production behavior
only. Prove case_024's AMBIGUOUS_REMEDY through full selection, and keep target faults/evidence independent from the
oracle.

Additional existing checks and external proof recipe, using an extracted/verified read-only contracts checkout and
implemented real subject:

```bash
npm run test:controller
npm run test:controller:deep
# In the pinned threadloop-contracts checkout:
npm run spec:conformance:check
npm run check
# In the pinned RunInvariant checkout:
npm test
THREADLOOP_CHECKOUT=/absolute/contracts npm run test:threadloop
node bin/run-invariant.js threadloop --checkout /absolute/contracts --subject /absolute/identity.json --subject-kind controller --json -- /absolute/controller conformance
```

The final subject path/identity are proposed adapter outputs and aren't available yet. Implement compile_graph, decide
and execution_scenario against production behavior. Keep expected outcomes, selected actions, fixture
titles/rationale/coverage and oracle files outside the subject. Retain all 38 results, subject/artifact identities,
graph/schema/corpus pins and runner limits.

ThreadLoop owns the deterministic Goose proof. Its npm script runs the Python driver. Supply the ThreadLoop checkout as
the npm prefix so both commands also work from the RunInvariant checkout. Each case needs a fresh output directory.
[ThreadLoop npm scripts](../../package.json) · [Proof driver](../../scripts/prove-gaap-goose.py) ·
[Executor proof and prerequisites](../gaap-executor.md)

```bash
npm --prefix /absolute/threadloop run prove:gaap:goose -- --gaap /absolute/gaap --goose /absolute/goose --output /absolute/new-proof
npm --prefix /absolute/threadloop run prove:gaap:goose -- --gaap /absolute/gaap --goose /absolute/goose --output /absolute/new-bad-patch-proof --case bad_patch
```

It needs locked built GAAP host/attestor binaries and pinned Goose 1.54.0. It has no model inference/external billing
and uses public fixture trust. Existing assertions deliberately keep the lifecycle at implementing/version 2 without an
available transition; add the new configurable-runtime progression/refusal evidence rather than claiming the old bridge
proof already establishes it. Treat a paid provider experiment as a separate specification/cost decision, not a
prerequisite for this deterministic proof.

E2E: reuse existing native Goose success and bad-patch paths and declared sandbox profiles. Keep
deterministic-provider/fixture-signing results explicitly labeled. Verify real claims/Attempts, signed admission,
correct advance/refusal, fresh proof/review, and same-head human completion evidence. A required live provider call or
actual human approval needs its prepared bounded request; continue independent local/CI proof while that decision is
pending. Don't invent live/model/authenticated evidence.

## Definition Of Done

- Issue #85's acceptance is met with an explicit compatible-adoption policy, cheap future enum additions,
  capability-aware consumers, retained old snapshots and unchanged historical evidence meaning.
- Configurable graph runs actually persist and execute decisions from frozen selection semantics; legacy
  CLI/session/public artifacts retain their compatibility promises.
- The production selector and controller pass all applicable frozen external cases, plus real persistence, concurrency,
  interruption and recovery checks.
- The reused GAAP bridge drives selected engineering actions with independent receipt admission and ThreadLoop-owned
  guarded progression, including human handoff/completion requirements.
- All units meet final local/hosted review, required CI, merged-tree and post-merge gates. The pre-Rust report maps
  every #110/#85/M003 prerequisite to exact observed evidence and records any remaining real decision/blocker.
- M003's stale main@750ae36/schema-v1 parity assumptions are refreshed from the proven TypeScript baseline while its
  Rust implementation remains a later step. Don't call prerequisites complete with required proof missing, or call
  ThreadLoop rewritten in Rust.

## Assumptions And Defaults

The user now explicitly authorizes the missing controller-runtime implementation plan and its documented prerequisite
implementation. Routine module/table/CLI spelling, supported initial graph profile and protocol-negotiation choices may
be resolved in the per-unit plans without another generic approval round.

Start with the existing governed-PR capability slice and implement the accepted selector catalog. Only explicitly
available/mapped capabilities launch; other contract cases can be evaluated without publication automation. Preserve
same-HEAD human authority, canonical identities and frozen contracts.

ThreadLoop owns this repository's changes. The separate GAAP roadmap Goal owns GAAP work; RunInvariant and
threadloop-contracts remain read-only dependencies unless a separately authorized owning task is required. GAAP recovery
adoption isn't an artificial prerequisite for ThreadLoop selector/storage work. No duration estimate or token budget is
assumed.
