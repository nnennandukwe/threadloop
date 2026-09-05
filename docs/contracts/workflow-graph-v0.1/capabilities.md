# SDLC capability catalog v0.1

Catalog identity: `threadloop.sdlc/0.1`. These are normative contracts for future evaluation, not implemented capability
handlers. Their parameter schemas are closed in the published graph and profile schemas. A meaning change requires a new
supported catalog/schema identity; retaining the old identifier while changing its meaning is forbidden.

## Guards

Every guard consumes explicit controller inputs and accepted evidence. Missing, stale, corrupt, unsupported, or
wrong-subject evidence cannot satisfy an evidence guard. Evidence collection, signature verification, and provider
normalization belong to adapters; the graph cannot embed a provider payload or execute that adapter.

| Capability             | Parameters and required meaning                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proof_plan_bound`     | Empty parameters. Require the immutable proof plan and repository authority. On entry to proof readiness, validate the proposed plan, clean named branch, and baseline HEAD before binding once. Elsewhere require the existing binding. Preserve declared gates, setup, independent-proof and review trust policies; never retrofit missing policy into a legacy plan.                                                                      |
| `repository`           | `condition` is `baseline_matches`, `clean_descendant`, `clean_plan_branch`, or `committed_repair`. Respectively require the exact clean bound branch/HEAD; a clean committed descendant after the authoritative implementation basis; the clean bound branch at current HEAD; or a clean committed repair after its failure/review basis. Implementation basis comes from the immutable plan, failed local proof, or pre-PR review evidence. |
| `phase`                | `value` is `pre_pr` or `post_pr`. Derive it from the declared history entry states and audit genesis. Advancement is monotonic, including through suspension. Missing history cannot invent a post-PR entry.                                                                                                                                                                                                                                 |
| `local_proof`          | `result` is `passed` or `failed`. Use the current aggregate local-proof status for declared gates at the exact subject. A `setup_failed` aggregate is neither result and never establishes code-repair authority. Missing, stale, or corrupt receipts are not a failure basis. Preserve all current gate result and setup/cleanup integrity rules.                                                                                           |
| `independent_proof`    | Empty parameters. Require accepted, integrity-verified, current-subject passing independent receipts for every required gate under the immutable trust policy. Local passing proof alone does not satisfy this guard.                                                                                                                                                                                                                        |
| `pre_pr_review`        | `outcome` is `clean` or `changes_required`. Require explicitly supplied current-subject review evidence with valid outcome, evidence reference and digest, and normalized unique findings. Narrative notes are insufficient. This is separate from signed post-PR review evidence.                                                                                                                                                           |
| `review`               | `condition` is `current`, `blocking`, `clear`, or `proof_set_current`. Require an accepted current-subject review snapshot under immutable trust policy; respectively validate freshness, a changes request or unresolved non-outdated finding, absence of blockers, or agreement of current passing local and independent proof with current review evidence. No condition passes on absent or corrupt review proof.                        |
| `human_approval`       | `scope` is `current_subject` or `recovery`. The former requires a non-bot human approval of the exact repository/artifact subject. Recovery requires an identified human approver, evidence reference, and reason for this blocked run. Executors and delivery infrastructure cannot supply human authority.                                                                                                                                 |
| `completion_observed`  | `kind` is `merge` or `publication`. Require an accepted current-subject observation of the delivered result. Merge uses a trusted post-merge review observation; publication binds the approved artifact and publication destination. Observation does not substitute for human approval.                                                                                                                                                    |
| `block_evidence`       | Empty parameters. Require reason, evidence reference, recovery guidance, and stop code. Preserve the active prior state when entering suspension. Evidence must be supplied explicitly, not invented by a projection.                                                                                                                                                                                                                        |
| `recorded_prior_state` | `state` references an active state. Require exact equality with the durably recorded state from which this run was blocked. Missing, terminal, or mismatched prior state denies recovery.                                                                                                                                                                                                                                                    |
| `budget_available`     | `budget` references a declared counter. Require a trustworthy run-history count strictly below its limit. Every accepted listed transition increments once; rejected transitions, replay, setup failure, and human recovery never reset or increment it. Missing/corrupt accounting fails closed.                                                                                                                                            |
| `stop_requested`       | Empty parameters. Require an explicit accepted stop request for this run. It allows a declared stop route to be considered; it does not itself change state or invent block evidence.                                                                                                                                                                                                                                                        |
| `artifact`             | `stage` is `release_prepared`, `release_verified`, or `publication_verified`; `result` is `passed` or `failed`. Require retained evidence for that stage and the current immutable artifact identity. Editing the artifact invalidates previous verification and approval.                                                                                                                                                                   |

## Required Actions and authority

Required Actions are requests for missing capability/evidence, not executable requests or automatic fallback
instructions. All parameter objects are empty in v0.1. Subject, policy, evidence inputs, and constraints belong to the
Action Request contract in [#105](https://github.com/nnennandukwe/threadloop/issues/105). Guard references list
potential remedies; #105 must choose only a remedy appropriate to the actual failure. For example, stale evidence
requests refresh, while setup failure requests setup correction, and neither automatically requests code repair.

| Capability                 | Meaning                                                                                 |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `frame_change`             | Establish the bounded change's goal and context.                                        |
| `bind_proof_plan`          | Supply a valid immutable proof plan and its baseline observations.                      |
| `implement_change`         | Produce a scoped implementation from the authorized basis.                              |
| `commit_change`            | Commit the scoped implementation or repair on its bound branch.                         |
| `run_local_gates`          | Run the plan's declared local verification and retain receipts.                         |
| `obtain_independent_proof` | Obtain and import current independent verification evidence.                            |
| `record_pre_pr_review`     | Record a current clean or changes-required pre-PR review outcome.                       |
| `obtain_review_evidence`   | Obtain and import current post-PR review evidence.                                      |
| `repair_change`            | Address a current authorized failure or review blocker.                                 |
| `correct_gate_setup`       | Correct setup/configuration without consuming code-repair authority.                    |
| `restore_proof_authority`  | Restore or establish valid proof authority; immutable policy changes require a new run. |
| `restore_repository`       | Restore the bound clean branch/baseline without reinterpreting the binding.             |
| `restore_evidence`         | Restore intact evidence or obtain fresh accepted evidence.                              |
| `prepare_release`          | Prepare the identified release artifact.                                                |
| `verify_release`           | Verify that artifact's release requirements.                                            |
| `publish_release`          | Publish the exact human-approved artifact through an authorized executor.               |
| `verify_publication`       | Verify the observed publication of the approved artifact.                               |
| `block_run`                | Human supplies explicit block evidence; only ThreadLoop may apply the transition.       |
| `recover_run`              | Human approves recovery to the recorded prior state with retained evidence.             |
| `approve_change`           | Human approves the exact current subject.                                               |
| `merge_change`             | Human performs the merge; retain a fresh observation afterward.                         |

The last four capabilities are human-only in the schemas. Other capabilities may be assigned to a human or executor;
that assignment never grants transition authority. Every transition requires `threadloop`; human boundaries additionally
require `human`. There is no executor, scheduler, provider, or delivery-infrastructure transition-authority type.
