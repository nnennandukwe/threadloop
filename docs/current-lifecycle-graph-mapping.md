# Current Lifecycle Graph Mapping

Inspected implementation: origin/main@71452630e803911ad5ceaeb41bac45bc158f6489

Artifact status: current-state compatibility mapping, not executable graph schema

This artifact maps the current ThreadLoop governed PR lifecycle to the planned SDLC graph language. It is the
compatibility input for #103 and should be read with the terminology and ADR work in #102, the future versioned Workflow
Profile and Compiled Graph contracts in #104, the storage-version evolution tracked by #85, the immutable run and
configuration identity work tracked by #86, and the issue-sequence tracker in #110.

This file is documentation only. It does not propose lifecycle behavior changes, CLI output changes, source type
renames, storage migration, Rust runtime changes, a configurable graph interpreter, or a new schema. Current sessions
and SQLite data keep their existing meaning; the current persisted schema is schema v8, and no migration is proposed.

## Runtime Authority Sources

The mapping intentionally points at current runtime seams rather than restating a standalone lifecycle theory.

| Source                             | Current authority                                                                           | Graph-language concept                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `src/domain/types.ts`              | Ordered task status set and phase names                                                     | State identifiers and phase identifiers                        |
| `src/domain/lifecycle.ts`          | Structural transition matrix, terminal rule, blocked recovery, phase derivation             | Nodes, edges, terminal nodes, recovery edges, phase projection |
| `src/domain/session-transition.ts` | Guard evaluation, `requiredWork`, idempotent request canonicalization, next-action planning | Guard families, required work families, controller candidates  |
| `src/domain/proof.ts`              | Immutable proof plans, local gate receipts, setup outcome semantics                         | Proof-plan contract, local proof receipt family                |
| `src/domain/attestation.ts`        | Signed CI package validation, GitHub Actions trust policy, Sigstore package shape           | Signed CI receipt family and adapter trust policy              |
| `src/domain/review.ts`             | Signed review package validation, blocking finding, approval, and merge projections         | Signed review receipt family and human completion authority    |
| `src/domain/audit.ts`              | Hash-linked audit event chain and root verification                                         | Audit ledger invariant                                         |
| `src/contracts/protocol.ts`        | Current protocol and public contract versions                                               | Compatibility contract surface                                 |
| `docs/lifecycle.md`                | Human-readable current lifecycle explanation                                                | Discoverability and reviewer-facing narrative                  |

The current public protocol reports `contract_version: 4` for session-next compatibility. That version remains a CLI and
protocol contract, not a compiled graph schema version.

## State And Phase Mapping

ThreadLoop currently publishes these lifecycle states as fixed graph nodes. The mapping below names the current meaning
and the planned graph concept without introducing new executable contracts.

| Current state      | Phase projection                | Current runtime meaning                                                                                          | Planned graph concept                  | Gap or constraint                                                                |
| ------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| `queued`           | `pre_pr`                        | Session exists and can be framed.                                                                                | Initial active node.                   | No additional graph field is needed.                                             |
| `framed`           | `pre_pr`                        | Goal and task frame exist before proof authority is bound.                                                       | Framing node before proof-plan guard.  | Future schema must not treat framing as proof evidence.                          |
| `proof_ready`      | `pre_pr`                        | Immutable proof plan is bound to a clean named branch and baseline HEAD.                                         | Proof-plan-authorized node.            | Git cleanliness and branch facts are repository observations, not node identity. |
| `implementing`     | `pre_pr`                        | Agent repository-work authority is active after a valid basis.                                                   | Work-execution node.                   | Future graph must preserve the implementation-basis guard, not just state order. |
| `verifying`        | `pre_pr` or `post_pr`           | Local proof, signed CI proof, pre-PR review, and repair-budget evidence select the next path.                    | Evidence-routing node.                 | This state is phase-sensitive; phase is derived, not separately mutable.         |
| `pre_pr_reviewing` | `pre_pr`                        | Operator or controller must record a provider-neutral clean or changes-required review outcome before PR review. | Pre-PR review gate node.               | This is not a signed-review receipt and must stay provider-neutral.              |
| `reviewing`        | `post_pr`                       | Signed-review evidence controls blockers, clearance, and post-PR repair entry.                                   | Post-PR review node.                   | Entering this node permanently closes the pre-PR phase.                          |
| `repairing`        | `post_pr` for new entries       | Bounded repair authority exists after post-PR failed proof or signed-review blockers.                            | Bounded repair node.                   | Legacy migrated `repairing` without `reviewing` history remains `pre_pr`.        |
| `ready_for_human`  | `post_pr`                       | Signed review is clear; completion waits for human approval and observed merge.                                  | Human-release node.                    | Mechanical merge observations cannot substitute for human approval.              |
| `blocked`          | prior phase retained by history | Session is stopped pending explicit evidence and human recovery.                                                 | Blocked terminal-until-recovered node. | Recovery may return only to the recorded prior state.                            |
| `completed`        | `post_pr` when reached          | Session is done after current same-HEAD human approval and observed merge.                                       | Completed terminal node.               | The completed terminal rule forbids any later transition.                        |

Lifecycle phase has only two values:

| Current phase | Current derivation                                                                                                  | Planned graph concept                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `pre_pr`      | Default until transition history or audit genesis proves entry into `reviewing`, `ready_for_human`, or `completed`. | Phase projection from transition history.              |
| `post_pr`     | Permanent after `reviewing` is reached, including migrated sessions whose audit genesis starts in a post-PR state.  | Monotonic phase projection, not mutable session state. |

## Structural Transition Mapping

Structural permission says an edge exists. It is not enough to authorize execution; guards still decide whether a
specific transition request is accepted.

| Current edge                           | Guard owner              | Current guard summary                                                                | Planned graph concept             |
| -------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------ | --------------------------------- |
| `queued -> framed`                     | none                     | Structural start edge.                                                               | Unguarded graph edge.             |
| `framed -> proof_ready`                | proof_plan               | Immutable plan and repository authority are required.                                | Plan-binding guard edge.          |
| `proof_ready -> implementing`          | proof                    | Live repository must still match the proof-plan baseline.                            | Baseline-preservation guard edge. |
| `implementing -> verifying`            | proof                    | Clean descendant commit after the current implementation basis.                      | Work-output guard edge.           |
| pre-PR `verifying -> implementing`     | proof                    | Current failed local proof or changes-required pre-PR review evidence.               | Pre-PR iteration edge.            |
| pre-PR `verifying -> pre_pr_reviewing` | proof                    | Current local proof and signed CI proof pass on the clean plan branch.               | Pre-PR proof-clearance edge.      |
| `pre_pr_reviewing -> implementing`     | proof                    | Current changes-required pre-PR review evidence.                                     | Review-feedback iteration edge.   |
| `pre_pr_reviewing -> reviewing`        | proof                    | Current clean pre-PR review outcome plus current local and signed CI proof.          | PR-boundary crossing edge.        |
| post-PR `verifying -> reviewing`       | proof                    | Current local and signed CI proof pass.                                              | Post-PR proof-clearance edge.     |
| post-PR `verifying -> repairing`       | proof                    | Current failed local proof and fewer than three repair entries.                      | Bounded proof-repair edge.        |
| `reviewing -> repairing`               | review                   | Current signed changes request or unresolved non-outdated signed-review thread.      | Signed-review repair edge.        |
| `reviewing -> ready_for_human`         | review                   | Current signed-review evidence is clear and proof set is current.                    | Human-readiness edge.             |
| `repairing -> verifying`               | proof                    | Clean committed repair after the failure or signed-review basis.                     | Repair-output guard edge.         |
| `ready_for_human -> repairing`         | review                   | A later current-HEAD signed-review receipt introduces a blocker.                     | Late-review repair edge.          |
| `ready_for_human -> completed`         | review                   | Current human `User` approval and signed observation that the PR is merged.          | Human completion edge.            |
| any active state `-> blocked`          | none plus evidence input | Complete block evidence is supplied.                                                 | Evidence-bearing block edge.      |
| `blocked -> recorded prior state`      | none plus evidence input | Explicit human recovery evidence is supplied and target matches durable prior state. | Human recovery edge.              |

The structural lifecycle exposes these decision codes:

| Decision code                              | Mapping                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `TRANSITION_ALLOWED`                       | Edge exists and structural phase rules permit the requested direction. |
| `INVALID_TRANSITION`                       | No edge exists, or the edge is unavailable in the derived phase.       |
| `COMPLETED_TERMINAL`                       | `completed` has no outgoing transition authority.                      |
| `BLOCKED_RESUME_REQUIRED`                  | A blocked session has no recorded prior state suitable for recovery.   |
| `BLOCKED_RESUME_MISMATCH`                  | Recovery target does not match the recorded prior state.               |
| `PRE_PR_REVIEW_BOUNDARY_REQUIRED`          | Pre-PR `verifying -> reviewing` must pass through `pre_pr_reviewing`.  |
| `POST_PR_IMPLEMENTATION_REENTRY_FORBIDDEN` | Post-PR work must use `repairing`; it cannot re-enter `implementing`.  |

Always-forbidden current paths remain forbidden in the mapping: `reviewing -> implementing`, post-PR
`verifying -> implementing`, `pre_pr_reviewing -> repairing`, and a fourth post-PR repair entry.

## Guard And Required Work Mapping

The current runtime reports guard failures and `requiredWork` entries as controller guidance. A future compiled graph
may encode those as guard nodes, predicates, or edge requirements, but it must preserve their authority boundaries.

| Guard family            | Current guard codes                                                                                                               | Current required work                           | Graph mapping                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Proof authority         | `PROOF_PLAN_REQUIRED`, `PROOF_AUTHORITY_DEFERRED`                                                                                 | `RESTORE_PROOF_AUTHORITY`, `IMPLEMENT_ISSUE_40` | No proof-owned edge may execute without immutable proof-plan and repository authority.                      |
| Proof baseline          | `PROOF_BASELINE_MISMATCH`                                                                                                         | `RESTORE_PROOF_BASELINE`                        | Implementation starts only from the clean branch and HEAD bound to the plan.                                |
| Implementation output   | `IMPLEMENTATION_BASIS_NOT_ADVANCED`, `COMMITTED_IMPLEMENTATION_REQUIRED`                                                          | `COMMIT_IMPLEMENTATION`                         | Repository-work authority must create one clean descendant commit after the current basis.                  |
| Pre-PR review input     | `PRE_PR_REVIEW_INPUT_REQUIRED`, `PRE_PR_REVIEW_OUTCOME_REQUIRED`, `PRE_PR_REVIEW_FINDINGS_INVALID`, `PRE_PR_REVIEW_HEAD_MISMATCH` | `RECORD_PRE_PR_REVIEW_OUTCOME`                  | Pre-PR review evidence is explicit transition input, not an inferred observation.                           |
| Proof checkout          | `PROOF_CHECKOUT_MISMATCH`                                                                                                         | `RESTORE_PROOF_CHECKOUT`                        | Current-HEAD proof and review entry require a clean proof-plan branch.                                      |
| Local proof pass        | `CURRENT_PASSING_PROOF_REQUIRED`                                                                                                  | `COMPLETE_CURRENT_PROOF`                        | Review entry requires current passing local proof.                                                          |
| Missing local proof     | `PROOF_GATES_MISSING`                                                                                                             | `RUN_MISSING_GATES`                             | `session next` can request missing declared gate receipts without mutation.                                 |
| Stale local proof       | `PROOF_RECEIPTS_STALE`                                                                                                            | `RERUN_STALE_GATES`                             | A new commit makes old local receipts unusable for current transitions.                                     |
| Corrupt local proof     | `PROOF_RECEIPTS_CORRUPT`                                                                                                          | `RERUN_CORRUPT_GATES`                           | Integrity failure requires restore or rerun before transition.                                              |
| Setup failure           | `PROOF_GATE_SETUP_FAILED`                                                                                                         | `CORRECT_GATE_SETUP`                            | Setup failure is operator/configuration work and must not consume repair budget.                            |
| Signed CI policy        | `CI_PROOF_POLICY_REQUIRED`                                                                                                        | `START_SESSION_WITH_CI_POLICY`                  | Independent CI proof cannot be retrofitted into an immutable legacy plan.                                   |
| Signed CI missing       | `SIGNED_CI_PROOF_REQUIRED`                                                                                                        | `IMPORT_SIGNED_CI_PROOF`                        | Trusted CI adapter must produce and import verified current proof.                                          |
| Signed CI stale         | `CURRENT_SIGNED_CI_PROOF_REQUIRED`                                                                                                | `RERUN_AND_IMPORT_CI_PROOF`                     | Signed CI package must bind the current repository HEAD.                                                    |
| Signed CI corrupt       | `UNCORRUPTED_SIGNED_CI_PROOF_REQUIRED`                                                                                            | `RESTORE_SIGNED_CI_PROOF`                       | Stored signed CI package integrity is a guard requirement.                                                  |
| Repair budget           | `REPAIR_BUDGET_EXHAUSTED`                                                                                                         | `TRANSITION_TO_BLOCKED`                         | Current profile allows three post-PR repair attempts; no fourth repair entry.                               |
| Failed proof repair     | `CURRENT_FAILED_PROOF_REQUIRED`                                                                                                   | `RUN_CURRENT_GATES`, `COMMIT_IMPLEMENTATION`    | Pre-PR failures re-enter implementation; post-PR failures enter bounded repair.                             |
| Repair output           | `COMMITTED_REPAIR_REQUIRED`                                                                                                       | `COMMIT_REPAIR`                                 | Repair must produce a clean committed change after the failure basis.                                       |
| Signed review policy    | `REVIEW_PROOF_POLICY_REQUIRED`                                                                                                    | `START_SESSION_WITH_REVIEW_POLICY`              | Review-owned edges require immutable review sensor policy.                                                  |
| Signed review missing   | `SIGNED_REVIEW_PROOF_REQUIRED`                                                                                                    | `IMPORT_SIGNED_REVIEW_PROOF`                    | Trusted review adapter must produce and import a signed review snapshot.                                    |
| Signed review stale     | `CURRENT_REVIEW_PROOF_REQUIRED`                                                                                                   | `REFRESH_SIGNED_REVIEW_PROOF`                   | Signed review snapshot must bind the current PR HEAD.                                                       |
| Signed review corrupt   | `UNCORRUPTED_REVIEW_PROOF_REQUIRED`                                                                                               | `RESTORE_SIGNED_REVIEW_PROOF`                   | Stored signed review package integrity is a guard requirement.                                              |
| Blocking review absent  | `BLOCKING_REVIEW_FINDING_REQUIRED`                                                                                                | `REFRESH_SIGNED_REVIEW_PROOF`                   | Entering repair from review needs current blocking review evidence.                                         |
| Blocking review present | `BLOCKING_REVIEW_FINDINGS`                                                                                                        | `ENTER_REVIEW_REPAIR`                           | Blockers route to bounded repair while budget remains.                                                      |
| Review proof set        | `CURRENT_REVIEW_PROOF_SET_REQUIRED`                                                                                               | `REFRESH_REVIEW_PROOF_SET`                      | Review progression requires local proof, signed CI proof, and signed review proof to agree on current HEAD. |
| Human approval          | `CURRENT_HUMAN_APPROVAL_REQUIRED`                                                                                                 | `OBTAIN_CURRENT_HUMAN_APPROVAL`                 | Completion authority belongs to a same-HEAD non-bot human approval.                                         |
| Merge observation       | `OBSERVED_MERGE_REQUIRED`                                                                                                         | `MERGE_AND_REFRESH_REVIEW_PROOF`                | Merge must be observed by the signed review sensor after human authority acts.                              |
| Block evidence          | `BLOCK_EVIDENCE_REQUIRED`                                                                                                         | `PROVIDE_BLOCK_EVIDENCE`                        | Blocking is explicit and evidence-bearing; a projection cannot block silently.                              |
| Recovery evidence       | `RECOVERY_EVIDENCE_REQUIRED`                                                                                                      | `PROVIDE_RECOVERY_EVIDENCE`                     | Recovery requires explicit human approval and durable evidence.                                             |
| Blocked prior state     | `BLOCKED_PRIOR_STATE_REQUIRED`                                                                                                    | `RESTORE_BLOCKED_PRIOR_STATE`                   | A blocked session cannot resume without its durable prior state.                                            |

## Receipt And Observation Mapping

Receipts are evidence inputs to guards. They are not lifecycle transitions, and their commands never advance state by
themselves.

| Receipt family         | Current command or source                                         | Current statuses                                                                                                                                                          | Graph mapping                                                                              |
| ---------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Proof plan             | `session transition` into `proof_ready` with immutable plan input | Plan present or absent; `contract_version: 4` supports setup declarations.                                                                                                | Plan-bound graph profile input, not compiled graph schema.                                 |
| Local gate receipt     | `session gate run`                                                | `missing`, `passed`, `failed`, `setup_failed`, `stale`, `corrupt`                                                                                                         | Local proof receipt family used by proof-owned guards.                                     |
| Local gate result      | `threadloop-local-gate` receipt payload                           | `passed`, `failed`, `timed_out`, `aborted`, `invalidated`, `execution_error`, `cleanup_failed`, `setup_failed`                                                            | Result vocabulary stored in receipts and projected into proof status.                      |
| Signed CI receipt      | `session gate import` of GitHub Actions/Sigstore package          | `policy_missing`, `missing`, `passed`, `stale`, `corrupt`                                                                                                                 | Independent CI proof receipt family.                                                       |
| Pre-PR review evidence | `pre_pr_review` transition input                                  | `changes_required`, `clean`                                                                                                                                               | Provider-neutral controller input; not signed review proof.                                |
| Signed review receipt  | `session review import` of GitHub Actions/Sigstore package        | `policy_missing`, `missing`, `current`, `stale`, `corrupt`                                                                                                                | Independent review proof receipt family.                                                   |
| Review decision        | Signed review snapshot                                            | `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, `null`                                                                                                                | Review-state observation used for blockers, readiness, and completion.                     |
| Repository observation | Live Git reads in `session next` and transition guards            | branch, head SHA, clean/dirty, descendant relationship, committed repair/work flags                                                                                       | Repository sensor facts; they support guards but do not define semantic lifecycle entries. |
| Audit event            | Transactional mutation and receipt import paths                   | `session_started`, `audit_activated`, `proof_receipt_recorded`, `signed_proof_receipt_imported`, `signed_review_receipt_imported`, `guard_decision`, `transition_applied` | Hash-linked audit ledger entries.                                                          |

Mechanical observations, receipts, daemon/reconcile activity, telemetry, and future executors cannot invent semantic
entries or authorize transitions. They may provide facts that guards consume, and accepted transitions must still pass
through `session transition` semantics.

## Command Surface Mapping

The mapping preserves current public command families and their responsibilities:

| Public command family   | Current role                                                                                                                                      | Mapping constraint                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `session next`          | Read-only deterministic candidate, guard failures, `requiredWork`, phase, schema status, proof and review projections.                            | Must remain projection-only and must not write audit events.      |
| `session transition`    | Idempotent state mutation with expected state version, idempotency key, actor, input, guard decision, audit append, and active projection update. | Only accepted path for semantic lifecycle transition.             |
| `session gate run`      | Runs declared local gate or setup command without shell expansion, records receipt and artifacts.                                                 | Produces local proof evidence only.                               |
| `session gate import`   | Verifies and appends signed CI proof packages.                                                                                                    | Produces signed CI evidence only.                                 |
| `session review import` | Verifies and appends signed review snapshots.                                                                                                     | Produces signed review evidence only.                             |
| `audit verify`          | Verifies audit sequence, link, canonicalization, hash, and optional root.                                                                         | Detects ledger corruption before controllers trust history.       |
| `audit export`          | Exports append-only audit JSONL with no overwrite.                                                                                                | Provides external observability without changing lifecycle state. |

This doc uses only commands that exist in `package.json`-backed project documentation. The local workflow remains Node
`>=22.13.0` with npm scripts such as `npm run check`, `npm run lint:markdown`, `npm run check:community`, and
`npm run security:dependencies`.

## Repair, Terminal, And Recovery Rules

The current default profile permits unlimited pre-PR implement/verify/pre-PR-review iteration because each new commit
stales old evidence and must re-prove at the new HEAD. That iteration uses `implementing`, not `repairing`.

Post-PR repair is deliberately bounded. The current implementation allows three counted repair entries in the default
profile. The persisted count is derived from every applied transition into `repairing` from `verifying`, `reviewing`, or
`ready_for_human`; it does not filter historical entries by derived phase. Current guards prevent new pre-PR `repairing`
entries, but migrated legacy entries that remain `pre_pr` can still consume the count. Entering the third counted repair
consumes the last new-entry authority but does not prevent that repair from being committed, verified, and returned to
review. A fourth repair attempt reports `REPAIR_BUDGET_EXHAUSTED -> TRANSITION_TO_BLOCKED`.

The `blocked recovery` rule has two parts: entering `blocked` requires `PROVIDE_BLOCK_EVIDENCE`, and leaving `blocked`
requires `PROVIDE_RECOVERY_EVIDENCE` plus a target that matches the durable prior state. `completed terminal` means
`completed` has no outgoing transition, even to `blocked`.

## Audit And Idempotency Invariants

The graph mapping must preserve these current invariants:

- `session transition` requires `expectedStateVersion` and an idempotency key.
- Transition input is canonicalized before hashing; exact replays return the recorded outcome without duplicate
  lifecycle, receipt, or audit writes.
- Accepted transitions append `transition_applied` in the same transaction as lifecycle state, transition history,
  idempotency outcome, active projection, and completion changes.
- Rejected guards keep lifecycle state unchanged and record one idempotent `guard_decision`.
- New sessions start audit coverage with `session_started`.
- Migrated sessions can start coverage with one `audit_activated` genesis event; ThreadLoop does not invent earlier
  decisions.
- Audit verification fails closed on sequence mismatch, link mismatch, canonicalization mismatch, hash mismatch, or root
  mismatch.
- Persistent storage triggers reject update, delete, and replacement of append-only records.
- Existing sessions and SQLite data keep their meaning under schema v8. Future storage changes belong to #85, and no
  migration is proposed by this artifact.
- Immutable run, configuration, and corpus identity concerns belong to #86; this mapping references them but does not
  duplicate their contracts.

## Platform Assumption Classification

Only these five classification categories are used here: core invariant, default Workflow Profile behavior, adapter
responsibility, current implementation limitation, and compatibility requirement.

| Current platform assumption                                                                                                                                                | Classification                    | Preservation note                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Lifecycle states and structural edges are fixed in TypeScript.                                                                                                             | current implementation limitation | #104 may make topology configurable, but must preserve compatibility for current sessions.                    |
| Proof authority is bound to a clean named branch and baseline HEAD during `framed -> proof_ready`, not raw session start.                                                  | core invariant                    | Proof-owned edges need an immutable baseline; existing sessions may start from observed repository snapshots. |
| The default workflow base reference for branch creation, rebase, and PR targeting is `main`; proof-plan `baselineBranch` is the checked-out named branch at proof binding. | default Workflow Profile behavior | Future profiles may parameterize the workflow base without making proof authority `main`-only.                |
| `origin/main` is the normal upstream sync target for issue work.                                                                                                           | default Workflow Profile behavior | This is workflow policy, not a provider-neutral lifecycle concept.                                            |
| Git repository facts include branch name, head SHA, cleanliness, and descendant/commit checks.                                                                             | adapter responsibility            | Git is the current repository sensor; graph semantics consume observations.                                   |
| GitHub PRs provide review, approval, and merge observations.                                                                                                               | adapter responsibility            | Provider-neutral lifecycle meaning is review evidence, human approval, and merge observation.                 |
| GitHub Actions provides trusted CI and review sensor execution.                                                                                                            | adapter responsibility            | CI and review evidence are independent receipts; GitHub Actions is only the current adapter.                  |
| Sigstore and in-toto validate signed receipt provenance.                                                                                                                   | adapter responsibility            | Signature mechanism is not a provider-neutral lifecycle node.                                                 |
| One autonomous task owns one checkout or worktree.                                                                                                                         | default Workflow Profile behavior | Concurrency outside that shape needs a future profile/runtime design.                                         |
| The post-PR repair budget is exactly three entries.                                                                                                                        | default Workflow Profile behavior | Future profiles may express a number, but current behavior and data use three.                                |
| Existing schema v8 SQLite sessions remain readable with current semantics.                                                                                                 | compatibility requirement         | Future graph storage cannot reinterpret existing state, receipt, or audit rows.                               |
| Mechanical observations never create semantic lifecycle entries.                                                                                                           | core invariant                    | Receipts, telemetry, reconcile, and daemons can only supply guard facts.                                      |
| Human approval is required before completion.                                                                                                                              | core invariant                    | A sensor may observe approval, but cannot provide human authority itself.                                     |
| `completed` is terminal.                                                                                                                                                   | core invariant                    | Future runtimes must require a new session for additional work.                                               |

## Preservation Checklist

Future compiled graphs, Workflow Profiles, adapters, and Rust runtime work must not weaken these current guarantees:

- Preserve every current state: `queued`, `framed`, `proof_ready`, `implementing`, `verifying`, `pre_pr_reviewing`,
  `reviewing`, `repairing`, `ready_for_human`, `blocked`, and `completed`.
- Preserve both lifecycle phases, `pre_pr` and `post_pr`, as derived monotonic projections unless a future migration
  explicitly proves equivalent behavior.
- Preserve the pre-PR review boundary; a pre-PR session cannot jump from `verifying` directly to `reviewing`.
- Preserve the post-PR implementation boundary; post-PR work must use `repairing`, not `implementing`.
- Preserve current local, signed CI, pre-PR review, and signed review evidence staleness on new commits.
- Preserve the separation between provider-neutral lifecycle meaning and GitHub Actions, GitHub PR, Sigstore, and
  in-toto adapter details.
- Preserve the distinction between `failed` proof and `setup_failed` proof so setup failures do not consume repair
  budget.
- Preserve three post-PR repair attempts for existing/current default-profile sessions.
- Preserve `blocked` entry evidence, `blocked recovery` evidence, and recorded-prior-state recovery.
- Preserve the `completed terminal` rule.
- Preserve idempotency, optimistic state-version checking, transactional audit append, and audit verification.
- Preserve existing sessions and SQLite data. Storage version work belongs to #85; immutable run and configuration
  identity work belongs to #86.

## Explicit Unresolved Gaps

- #104 owns the versioned Workflow Profile and Compiled Graph schemas. This artifact does not define their field names,
  validation rules, fixture format, interpreter, or migration path.
- #85 owns storage capability and version evolution. This artifact states only that no migration is proposed for current
  schema v8 data.
- #86 owns immutable run, configuration, and corpus identity. This artifact references those requirements but does not
  duplicate or extend them.
- #102 may refine graph terminology. This artifact should align to #102 terms without duplicating a glossary.
- Rust-runtime execution is out of scope for #103. This artifact is a compatibility map for future runtime work, not a
  Rust acceptance test.
