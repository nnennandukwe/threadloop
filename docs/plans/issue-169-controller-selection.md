# Issue 169 Deterministic Controller Selection Build Plan

## Summary

A caller can ask ThreadLoop whether a proposed decision fits a run snapshot. A configurable Workflow Run needs
ThreadLoop to choose the decision itself, including when every possible action must stop. This build will deliver a pure
TypeScript selector over the accepted Workflow Graph and Controller Input v0.1. Its one review unit starts at
`8014d80acc8b6209560f2d6df5c9cf450544c4f2`, after the storage delivery.
[Five-unit program plan](controller-runtime-rust-prerequisites.md) ·
[Selector issue #169](https://github.com/nnennandukwe/threadloop/issues/169) ·
[Runtime tracker #168](https://github.com/nnennandukwe/threadloop/issues/168) ·
[Accepted selection rules](https://github.com/nnennandukwe/threadloop-contracts/blob/v0.1.0/docs/contracts/controller-v0.1/selection.md)

## Skills To Use

| Stage          | Skills                                         | Responsibility and evidence                                                                                                                                                                                                                            |
| -------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sources        | qodo-get-rules, qodo-codebase-wisdom           | Apply the program's retrieved schema coordination and exhaustive enum rules, especially 1060877 and 1060865. Trace the pinned public types, request builder and existing candidate call. Refresh rules or source evidence if the scope or pin changes. |
| Design         | codebase-design, workflow-invariants           | Give callers one pure function. Verify the precedence table, receipt supersession, graph priority and human authority through that function.                                                                                                           |
| Implementation | tdd, failure-path-testing                      | Add one public example per behavior before implementing it. Exercise changed facts, blocked decisions, recovery and ambiguity.                                                                                                                         |
| Delivery       | qodo-review, qodo-review-resolver, voice-canon | Review the complete verified change, reconcile current-head findings and verify the plan, documentation and PR language.                                                                                                                               |

Qodo Local Review is eligible. The program established access to the pushed repository and base. Confirm that the
isolated worktree has the intended base and that the review service can access it. This unit uses the existing
TypeScript toolchain. The function has no persistent state, CLI or interactive command.

The repository-scoped Qodo lookup for this selector returned rule 1060865 on exhaustive enum consumers and rule 1060877
on matching producer and consumer validation. Exercise every existing decision variant and use the frozen validator for
the shared input and request formats. Rule 2280961 retains the repository's single `npm run check` entry point. Rules
8184, 7205 and 613754 require descriptive English names and comments.

## Scope

- Select all six decision variants across the v0.1 typed guard and action catalog. Cover the governed pull-request and
  artifact profiles, different state names and another graph topology.
- Use only the supplied graph, run binding, observation, verified history, admitted receipts, execution projection,
  capability list, authorities, policy, known requests and explicit evaluation time.
- Keep the existing fixed session lifecycle and GAAP candidate inspection compatible. Unit 3 will bind the selector to a
  stored run and CLI. Unit 4 will dispatch selected engineering work. Unit 5 will run the independent conformance
  process.

## Package Layout / File-to-Task Mapping

- New `src/domain/workflow-controller.ts` will export the decision function. Keep fact indexing, guard evaluation and
  remedy selection private to the implementation. Split them into domain files only where their responsibilities justify
  it.
- Reuse `src/domain/canonical-json.ts` and `src/adapters/crypto/sha256.ts` for digest-bound payloads. Use the public
  `threadloop-contracts/controller` and `threadloop-contracts/workflow` exports.
- New `tests/unit/workflow-controller.test.ts` will exercise the production function. Use the public graph compiler and
  independently authored facts to build inputs. Keep expectations and subject inputs separate in tests.
- `src/services/gaap-executor.ts` currently tests each outgoing candidate with every receipt ID. Its candidate list is
  an existing inspection surface. Keep it usable until Unit 4 integrates full selection into governed execution.
- Place this plan under `docs/plans/` before production edits. Update the architecture's selector status only for the
  interface and outcomes the delivery verifies.

## Dependencies And Settings

Use the existing lockfile, supported Node versions, and contracts pin `4ed9a94a2a089b9ae950d93297f7a6b9b939d3a6`. Retain
`threadloop.remedies/0.1`, `threadloop.sdlc/0.1`, graph schema `0.1`, storage generation 8 and protocol v4. The
implementation needs no new environment, provider or dependency.

## Canonical Contracts

Expose `selectWorkflowDecision(input: unknown): ValidationResult<ControllerDecision>`. The success value contains
`decision` and `decision_digest`. Digest the complete validated snapshot for `input_digest`, retaining array order.
Digest the complete decision payload for `decision_digest`. Use the public input validator's diagnostics for invalid
input. Every successful evaluation returns exactly one outcome and leaves its input unchanged.

| First applicable condition                                                                                 | Result                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Invalid version, graph/binding, policy identity, input shape, receipt identity or required evaluation time | Return validation diagnostics.                                                                                                                                                                                     |
| Outstanding execution                                                                                      | Report a fenced, expired, conflicted or uncertain obligation as blocked. Return `waiting` only for a matching, valid in-flight request with current observation/history. Reference its request, claim and Attempt. |
| Idle execution in a terminal node                                                                          | Return `terminal` for that node.                                                                                                                                                                                   |
| Active idle run lacks current observation or verified history                                              | Return the applicable blocked reason and an operator recovery action. Check required authorities for each applicable transition and proposed handoff.                                                              |
| One or more eligible outgoing transitions                                                                  | Select the lowest integer priority. Include source/target bindings and evidence for every guard. The compiled graph requires distinct outgoing priorities.                                                         |
| No eligible transition                                                                                     | Exhaust all applicable declared remedies. Return one engineering or human Action Request for the selected capability, or a supported blocked reason.                                                               |

The selector can only observe a transition. A human handoff remains pending until the snapshot contains accepted human
evidence. Policy and transition authority stay separate from executor capability.
[Authority and outcome contract](https://github.com/nnennandukwe/threadloop-contracts/blob/v0.1.0/docs/contracts/controller-v0.1/README.md)

## TDD And BDD Implementation Strategy

1. Start with a compiled graph and an independently built invalid binding. Verify the validator diagnostics. Add an idle
   terminal case, a healthy waiting case and a fenced case whose unchanged source otherwise permits progress.
2. Add a renamed graph with two eligible outgoing transitions. Verify the lower number wins, declared-order changes
   preserve the winner, and complete evidence binds the exact subject. Vary one receipt's expiry, subject, binding or
   fence at a time. Include the expired newest receipt that supersedes an older pass.
3. Add the first progress remedy and build its request through the public builder. Then exercise local proof,
   independent proof, review, human approval and observed completion in order. Include an artifact route, a dirty
   implementation with and without a scoped change, missing authority and an unavailable actor capability.
4. Exercise suspension, explicit stop, setup failure, admitted repair and exhausted new-entry budget. Preserve an active
   repair admission on its final permitted iteration. A prior count alone can't authorize repair.
5. Add semantically tied declared actions, no applicable remedy and logical idempotency conflicts. Re-evaluate the same
   input, verify both complete bytes and digest, and prove that removing one tied action changes the decision. Test a
   graph with renamed guards and verify that the result doesn't depend on fixture names or display labels.

## Component Design

**Receipt selection.** Index receipts by subject, Workflow policy and evidence stream. Stream selectors include payload
type plus gate, stage, scope and approver, completion kind and destination, or prior state where present. Select the
highest authoritative sequence before checking expiry and invalidated claims. A superseded receipt never regains
authority. Input validation enforces run/graph identity, producer version, trusted verification policy and payload
digest. Retain earlier producer versions that still meet the current subject and policy conditions.

**Guard evidence.** For each outgoing edge, evaluate all conjunctive guards against the same facts. Use empty evidence
references for predicates established by graph, policy, observation or history alone. Use current receipt IDs for
receipt-backed predicates. Match each configured gate, review condition, approval scope and policy-listed human,
artifact stage, block prior state or completion target. For a complete review proof set, include the selected local,
independent and review witnesses. Track failure type as well as success so a failed predicate can't fabricate the
opposite result. Keep evidence ordering deterministic, and avoid searching a power set of receipt combinations.

**Transition eligibility.** A route needs every guard witness and every authority identity that its edge declares.
Choose the lowest integer priority among the edges that meet both conditions. A witnessed edge with missing authority
allows a different fully eligible edge to advance. When all witnessed edges lack authority, the blocked decision names
the highest-priority affected transition and describes how to restore its authority.
[Frozen selection precedence](https://github.com/nnennandukwe/threadloop-contracts/blob/v0.1.0/docs/contracts/controller-v0.1/selection.md#decision-precedence)

**Branch applicability.** Use the graph's state kind, outgoing edges, guard capabilities, parameters, remedy references,
priority and budget bindings. A phase or prior-state mismatch removes that route. A repair entry requires observed
failure, applicable phase and remaining new-entry authority. A known pass can't request failure. An eligible transition
precedes remedy selection. A suspension handoff uses the recorded prior state. A priority on a route into suspension
doesn't make stopping due without supporting evidence. The applicable graph and facts must resolve competing
interventions.

**Remedy selection.** Enumerate the relevant guard/action pairs on applicable routes. Rank by the frozen semantic
prerequisites. Stop/recovery, exhausted repair entry and setup correction come before ordinary work when their
conditions hold. Restore the bound branch or proof authority when the input identifies that failure. Use the graph's
declared bootstrap transition for the first proof-plan binding. Implementation needs the declared basis. A commit needs
a dirty in-scope tree on its bound branch with a matching basis and content change. Select local proof before
independent proof, then pre- or post-PR review as the verified phase requires. Request human approval only after clear
current proof/review or verified release evidence, then the declared merge or publication action. Artifact preparation,
verification, publication and observation use the graph's exact stages and policy destination. A missing receipt alone
can't establish broken admission or justify `restore_evidence`. Only select applicable graph-declared capabilities.

Collect all still-equal remedies before deciding. Several missing gates for one capability belong to one request.
Distinct equally applicable actions that remain unresolved produce `AMBIGUOUS_REMEDY`. An empty applicable set produces
`NO_APPLICABLE_REMEDY`. A unique required but unavailable action produces `UNSUPPORTED_CAPABILITY` with its declared ID.
An actor assignment can't switch to another actor to escape a refusal. Use the frozen validator's supported reason
shape, including exact referenced action, transition, guard or conflicted request.

**Request construction.** Build the selected intent with its transition ID, remedied guard IDs, subject-bound evidence
requirements, prerequisite receipt IDs and immutable artifact inputs. The evidence family must match both the guard's
failed requirement and the selected capability. Attach the bound proof-plan identity to governed repository work where
applicable. A commit also binds the implementation basis by revision and content digest. Use only input-backed artifact
identities. With no separate approved deadline, pass `valid_until: null` and let `buildActionRequest` clamp validity to
observation and evidence deadlines. The public builder canonicalizes request arrays and computes its logical identity.
If the known-request registry conflicts, reconstruct the otherwise valid proposal without that registry and confirm the
conflict is the sole error against the original input. Bind the blocked decision to the original complete snapshot.

Use public `validateControllerInput`, `buildActionRequest`, `validateRequestInSnapshot` and candidate validation where
applicable. Exhaustive absence/tie decisions require the selector's own proof. The pinned candidate validator returns
`SELECTION_PROOF_REQUIRED` for those two codes by design. Private package paths and fixture readers aren't production
interfaces.
[Public controller exports](https://github.com/nnennandukwe/threadloop-contracts/blob/4ed9a94a2a089b9ae950d93297f7a6b9b939d3a6/src/public/controller.ts)

## Failure And Recovery Rules

- Invalid input returns diagnostics before any action or transition. A stale observation, corrupt history or expired
  authority returns a blocked decision with the refresh or restoration it needs. Healthy in-flight work waits. An
  unresolved effect requires reconciliation of the existing claim and Attempt.
- A valid late receipt for an old subject, policy or fenced claim can't authorize work. Refresh the required evidence on
  the current subject. A missing receipt-backed guard may use `EVIDENCE_UNAVAILABLE` when its documented condition
  holds. A current failed receipt carries evidence of failure.
- A missing edge authority names the affected transition. If an ordinary capability is human-assigned on an otherwise
  ThreadLoop-only edge and its human policy identity is missing, reject the handoff. Use exhaustive
  `NO_APPLICABLE_REMEDY` if no authorized alternative exists, and explain which identity the policy needs.
- A changed request under a retained logical identity returns `IDEMPOTENCY_CONFLICT` with the full conflicting proposal.
  Preserve the original slot. A subsequent evaluation must use reconciled facts.
- Tests for a missing or tied remedy must demonstrate why alternative routes were inapplicable. The selector performs no
  durable writes, launches or lifecycle transitions, so retry means evaluating another explicit snapshot.

## Commit Plan

1. Record the unit plan, then add validation, execution obligations and terminal handling with their public examples.
2. Add guard witnesses, authority checks and priority selection with changed-subject and supersession regressions.
3. Add applicable remedy enumeration, action requests, human handoffs and explicit block reasons with their tests.
4. Complete renamed-profile checks and the verified selector documentation. Keep each behavior with its test.

## Branch And PR Flow

1. Verify the storage PR's merged tree and post-merge checks, fetch `origin/main` and create an isolated
   `feat/issue-169-controller-selector` worktree at `8014d80acc8b6209560f2d6df5c9cf450544c4f2`. Confirm current
   instructions, pin and scope.
2. Run the focused and full checks. Commit owned changes before each review. Submit a fast asynchronous Qodo checkpoint
   on a completed slice, retain its operation ID and collect it. Attach #169, design decisions, verification and recent
   changes. Submit auto-depth local review of the complete final diff against the pinned pushed base.
3. Reproduce findings on the reviewed head. Repair confirmed defects, rerun affected and full checks, and review changed
   code again. Report any service or transport failure with its recovery attempt. A failed eligible review stays open.
4. Open one PR with `Closes #169`. Compare the completed structured hosted review's commit SHA with the actual PR head.
   Check every open finding and required CI result. Prefer automatic attribution after fixes. A stored dismissal needs
   authorization for that finding.
5. Merge the reviewed SHA only after the gates pass. Compare the merged tree, verify post-merge CI and record the
   revision in #168 before Unit 3 starts.

## Test Plan

Run the focused selector test after each new behavior. Check the generated-controller suite for regressions. Recheck
after any review repair. Capture results at the commit submitted for final review.

```bash
npm ci
npm test -- tests/unit/workflow-controller.test.ts
npm run test:controller
npm run check
npm run security:dependencies
git diff --check origin/main...HEAD
```

Check all six outcomes, ordered precedence, supersession/expiry/fencing, scoped dirty-tree authorization, handoff and
current-subject completion, full ambiguity and absence. Include equivalent authoring-order variants that compile to the
same graph. For canonical input equivalence, preserve the array order defined by that input. Verify bounded work with
many same-stream receipts and multiple configured gates using independent expected results. Unit 5 owns the frozen
external harness run and its recorded 38-case result.

## Definition Of Done

One public production function deterministically computes every outcome from explicit run facts. Tests show the winning
transition and its witnesses, the one permitted request, and the reason competing remedies or stale authority prevented
action. Known-good independent examples and refusal/recovery checks pass for different graph topologies. The frozen
graph, controller and execution identities remain compatible. Native checks, local and hosted review, merged-tree
inspection and post-merge CI have current links and revisions.

## Assumptions And Defaults

Most choices follow directly from the accepted contracts, including the selector's scope, authority rules and request
canonicalization. One wire-order choice needs an explicit implementation decision. The candidate validator checks
transition guard coverage as a set. The frozen external comparator also checks the order of `decision.checks`. For an
ordinary review handoff the accepted example lists clear review, current review, then the proof set. For the terminal
transition it lists current review, clear review, proof set, human approval, then observed merge. Compiled guard
references are normalized, so authoring order can't recover both sequences.

The proposed convention uses normalized guard order on ordinary transitions. For terminal transitions, order the
prerequisite checks before human authorization and observed delivery. Within review prerequisites, order current review,
its clearance and the complete proof set. Other prerequisites retain normalized order within their stage. Use the typed
guard capability, parameters and target state kind. The examples support these two outputs, while the frozen prose
leaves the extension to other graphs unspecified. Record the selected convention before implementing guard-check
serialization. Test unrelated guard IDs and an artifact terminal transition. Keep all fixture identities, expected
arrays and external comparison logic outside the selector.

## Implementation evidence

The canonical per-unit plan preceded source changes in commit `c96c3c961f5f4417f4c1b82bfe34a305c49cd43d`. At
`b9d680decee78ee189f22c5f514c377afc905114`, all 823 tests, the build and the installed-package smoke check passed. At
`babf903e0726b7ae3d07d3b8ae1d7746d201101e`, the selector matched all 20 published controller examples and all 25
normalized decision cases in-process. In the same revision, 270 governed-PR variations returned valid outcomes and 135
additional scenarios passed, including 92 independently specified outcomes. The issue's linked pull request records the
final reviewed revision, review findings, CI and package results.
[Delivery record for #169](https://github.com/nnennandukwe/threadloop/issues/169)
