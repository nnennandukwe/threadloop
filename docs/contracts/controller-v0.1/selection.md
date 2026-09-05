# Deterministic decision rules v0.1

Identity: `threadloop.remedies/0.1`. These rules are normative for a future evaluator. The development tooling validates
supplied candidates and examples; it does not implement this selector.

## Decision precedence

Use only explicit input; never query environment, filesystem, clock, scheduler, provider, model, or executor state.

1. Validate versions, closed types, graph semantics/binding, policy digest, identities, and timestamp representation.
   Invalid input returns diagnostics without an actionable output.
2. Resolve execution obligations first. Reconciliation, expired/fenced claims, or changed active-request bindings/policy
   produce `blocked`. Healthy matching execution with current observation/history produces `waiting`, referencing the
   existing request/claim/Attempt. Never invent replacement work.
3. With no execution outstanding, an already terminal state produces `terminal` without a request or transition.
4. Require a current verified observation, verified history, and required authority identities for actionable output.
   Missing facts produce `blocked` with a stable reason and recovery guidance.
5. Evaluate registered guards. Among fully eligible outgoing transitions, choose the lowest integer priority. Return
   `transition_available` with all guard evidence and source/target bindings; do not apply it.
6. If no transition is eligible, find missing prerequisites on applicable progress, suspension, or recovery paths using
   the rules below. Select one appropriate remedy from the graph's declared references. Return a human or engineering
   action outcome according to the graph-declared actor.
7. No applicable remedy produces `NO_APPLICABLE_REMEDY`; a remaining semantic tie produces `AMBIGUOUS_REMEDY`. Both are
   blocked decisions. Declaration order, alphabetical IDs, and executor preference never break a tie.

Identical canonical inputs must produce identical decisions, diagnostic ordering, and requests. A refreshed input can
have a different decision digest even when the logical next action is unchanged.

## Applicable guards and interventions

Guards and authorities are conjunctive. A possible remedy is not a command to execute whenever a predicate is false:

- Another phase makes a branch inapplicable; it does not request a phase change.
- Passing proof does not request a failed result to unlock repair. Evidence collection reports what happened, never a
  fabricated desired outcome. Known failure follows its applicable failure route.
- Suspended runs use their human recovery handoff and recorded prior state. Recovery does not reset phase or budgets.
  Accepted recovery evidence may make its transition available.
- Block/stop routes require explicit evidence. Their priority does not demand blocking during ordinary progress.
  Demonstrated failure with exhausted new repair-entry authority requests human block evidence; it does not invent it.
- Several remedies for one guard require a known failure reason: collection for missing proof, correction for setup
  failure, restoration for lost authority. Insufficient distinguishing facts produce a blocked decision.
- Human approval becomes due after current proof/review prerequisites. A missing merge/publication observation does not
  establish approval; harness completion does not complete the Workflow Run.

## Remedy order and prerequisites

Use this semantic order on an applicable progress path. Skip satisfied requirements. Interventions supported by explicit
stop, recovery, setup failure, or exhausted-repair facts precede ordinary progress. Conflicting interventions require a
graph resolution or a blocked decision.

| Situation                                                                               | Next capability or result                                                                                                      |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Suspended run needs recovery                                                            | Human `recover_run` to the recorded prior state.                                                                               |
| Explicit stop needs block evidence, or demonstrated repair exhausts new-entry authority | Human `block_run`, retaining reason, stop code, and recovery guidance.                                                         |
| Proof setup failed                                                                      | Graph-declared `correct_gate_setup`; no repair consumption. Changing an immutable plan requires a new run.                     |
| Bound branch/baseline needs restoration                                                 | Graph-declared `restore_repository`; never reinterpret the binding.                                                            |
| Proof authority needs establishment/restoration                                         | `bind_proof_plan` or `restore_proof_authority` only when explicit facts distinguish them; otherwise block.                     |
| Authorized implementation is missing                                                    | `implement_change`, then `commit_change` for an observed scoped working-tree change, using an explicit implementation basis.   |
| Current local proof is missing/stale                                                    | `run_local_gates` on the clean bound branch and immutable plan.                                                                |
| Local proof passes; independent proof is missing/stale                                  | `obtain_independent_proof` with current local proof.                                                                           |
| Both proof sets pass; pre-PR review is due                                              | `record_pre_pr_review`.                                                                                                        |
| Both proof sets pass; post-PR review evidence is due                                    | `obtain_review_evidence`.                                                                                                      |
| Current code failure or review blocker requires repair                                  | Offer an eligible repair transition first; request `repair_change` within admitted repair authority, then commit and reverify. |
| PR proof/review is clear, or release verification passes, but approval is absent        | Human `approve_change` for the exact subject.                                                                                  |
| Current approval exists but PR merge is not observed                                    | Human `merge_change`, then fresh completion observation.                                                                       |
| Verified release has current approval and publication is due                            | `publish_release` for the exact artifact and policy destination.                                                               |
| Publication is observed but verification is absent                                      | `verify_publication`.                                                                                                          |
| Release preparation/verification evidence is absent                                     | `prepare_release` then `verify_release`, according to graph state and artifact stage.                                          |
| Evidence admission/integrity is unavailable                                             | `restore_evidence` only when graph and current facts establish a safe remedy; otherwise block.                                 |

Several missing PR proofs resolve as local proof, independent proof, then review. Multiple gates within one proof
capability belong to one Action Request. An executor cannot choose another lifecycle action. `frame_change` remains in
the catalog; a guard-free framing transition takes precedence and does not invent an unguarded action. Unreferenced
capabilities cannot be dispatched implicitly.

Preserve #104 budget semantics: accepted counted entry consumes once; replay consumes nothing; the final permitted
repair may finish work and verification. Exhaustion prevents a new entry, not completion of an admitted repair. Setup
failure, stale evidence, and recovery never reset counters. Pre-PR iteration remains distinct from post-PR repair.

## Failure outcomes and remaining proof

Stale receipts cannot satisfy guards or action prerequisites. A current observation permits bounded refresh; a stale
observation permits only blocking until refreshed. Unsupported capabilities cannot be remedied by changing actors.

Blocked codes distinguish stale observation, invalid history, unavailable capability/authority/evidence, execution
reconciliation, expiry, identity conflict, ambiguous remedy, and no applicable remedy. Reasons must describe supplied
facts without inventing a lifecycle event.

Candidate validation checks reason-specific facts and rejects unsupported assertions, including expired-claim reports
without an expired active claim. It rejects `AMBIGUOUS_REMEDY` and `NO_APPLICABLE_REMEDY` with
`SELECTION_PROOF_REQUIRED` until a selector can prove them exhaustively. Required local and independent proof sets must
be nonempty when their guards or review proof-set conditions are asserted; profiles that do not use them may keep empty
sets. Empty configuration is not passing proof.

Examples cover all six outcomes, proof ordering, stale refresh, human approval/merge, completion, setup failure,
exhausted repair, waiting, expiry, uncertain execution, and artifact publication. Their validation proves schema,
identity, and binding consistency. A future evaluator must additionally prove full branch applicability, priority
selection, remedy completeness, verified history derivation, and rejection of alternative decisions in #108's corpus.
