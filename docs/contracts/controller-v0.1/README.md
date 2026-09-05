# Controller Decision and Action Request v0.1

Status: specification and development tooling for [#105](https://github.com/nnennandukwe/threadloop/issues/105), built
on the [Workflow Profile and Compiled Graph](../workflow-graph-v0.1/README.md) accepted in #104. This does not enable
configurable graph evaluation or execution in the shipped CLI.

## Published interface

- [Controller Input](schemas/controller-input.schema.json): every fact available to a decision.
- [Controller Decision](schemas/controller-decision.schema.json): one typed outcome bound to that input.
- [Action Request](schemas/action-request.schema.json): one bounded authorization candidate for a human or executor.
- [Decision rules](selection.md): normative precedence and remedy selection, `threadloop.remedies/0.1`.
- [Positive examples](fixtures/valid/manifest.json) and [rejection corpus](fixtures/invalid/manifest.json).

Strict Zod definitions in `scripts/controller-contract/contracts.ts` generate Draft 2020-12 schemas. Tests compare the
checked-in schemas to those definitions and validate examples independently with Ajv, using local documents only. Ajv's
`strictTypes` style lint is disabled because Zod can put a type behind a `$ref` with a sibling `minimum`; schema type
constraints still apply. Date patterns are checked by both validators; semantic validation also rejects impossible UTC
instants. No external format plugin is required.

The development tooling exposes four pure functions:

```typescript
validateControllerInput(snapshot: unknown): ValidationResult<ControllerInput>
buildActionRequest(snapshot: unknown, intent: unknown): ValidationResult<ActionRequest>
validateActionRequest(snapshot: unknown, request: unknown): ValidationResult<ActionRequest>
validateControllerDecision(snapshot: unknown, candidate: unknown): ValidationResult<ControllerDecision>
```

`ValidationResult<T>` follows #104: `{ ok: true, value: T }` or `{ ok: false, diagnostics }`. Diagnostics contain a
code, path, optional identifier, message, and recovery guidance. Invalid documents receive no new request or decision.
Validation never writes files, reads the clock, queries a provider, or mutates its arguments.

**Successful validation is contract consistency, not authorization.** These functions check a supplied candidate; they
do not search outgoing edges, choose a remedy, acquire a claim, execute an action, or advance a run. The builder
requires a separately supplied intent. Validators check bindings, freshness, actor restrictions, required guard
evidence, and selected capability prerequisites. They do not prove that the candidate wins against every eligible
alternative. This is not a complete reference evaluator or a runtime conformance claim.

## Explicit input and trust boundary

Input contains the complete canonical graph, immutable run binding, repository/artifact observation, history projection,
policy contents and digest, authority identities, available actor capabilities, accepted normalized receipts, current
execution, invalidated claim versions, known request identities, and optional evaluation time.

The binding contains `workflow_run_id`, `graph_schema_version`, `graph_digest`, `source_state`, `state_version`, and
`subject`. A repository subject identifies the repository, revision, and exact content digest; the observation
separately reports branch, cleanliness, and relationship to an explicit implementation basis. An artifact subject
identifies the artifact and content digest. New commits, changed working trees, and edited artifacts change the subject.
Core types contain no GitHub, CI-provider, model, tool-call, or executor implementation types.

Policy rules contain the immutable proof-plan identity, repository baseline and branch, required local/independent gate
IDs, publication destination, accepted verification-policy identities, and authority identities. The policy digest
hashes the exact canonical `rules` object. An artifact reference is not permission to fetch facts that change the
decision: everything a selector needs must already be represented by normalized input. Request inputs name immutable
content that a later authorized actor may consume; they do not embed shell commands or provider payloads.

Verified history supplies phase, one count per graph budget, the active prior state before suspension, and
implementation basis, and an optional active `repair_admission`. Its digest identifies retained source history. An
adapter must derive these projections from verified history, preserve monotonic phase, and count accepted budget entries
once. A caller cannot create authority by labeling history `verified`. Missing/corrupt history is explicit and prevents
actionable decisions. Counter derivation and durable audit verification remain runtime obligations.

Repair admission records the exact repair action, counted entry transition and `entry_state_version`, budget ID and
consumed count, plus the current `bound_state_version`. The entry must target the active state, use that budget's guard,
and consume the recorded count within its limit. An aggregate budget count alone never grants repair authority. The
adapter must retain the original entry through suspension and verified recovery to the same state, rebinding only
`bound_state_version` to the current version. Normal progress out of that state clears the admission. It must never
reuse a historical admission for a new repair episode. Verifying this history derivation remains an admission-boundary
obligation; the candidate validator checks its explicit references and bindings. The final admitted repair remains
usable at the budget limit. The admission is required for repair work, any commit action satisfying `committed_repair`,
and the committed-repair guard that permits progress to verification. Completing work does not bypass admission or
consume another entry.

Receipts retain identity and authoritative sequence; run, graph, producer state version, subject; verification-policy
and Workflow policy identities; acceptance-record identity; typed payload and digest; optional deadline; and, for
attempt-produced evidence, request, claim/version, and Attempt references.

The closed payload families are proof plan, local proof, independent proof, pre-PR review, review, human approval,
completion observation, block evidence, stop request, and artifact verification. Signature checks, artifact integrity,
producer trust, acceptance-record authenticity, sequence assignment, and claim fencing precede normalization. Payload
hashes detect inconsistent input; they do not authenticate an adversarial caller. No `accepted: true` boolean, arbitrary
guard verdict, or narrative note substitutes for that admission boundary.

Only receipts from this run and graph, produced no later than its state version, enter accepted input. Current receipt
use additionally requires the current subject and Workflow policy, an unexpired interval, and a non-invalidated claim.
Earlier producer state versions remain usable when these bindings hold: advancing from verification to review does not
by itself invalidate local proof.

For each subject and Workflow policy, the highest authoritative sequence supersedes earlier receipts of the same payload
type and typed selectors: gate, artifact stage, approval scope and approver, completion kind and destination, or block
prior state. Receipts for another policy or selector do not supersede that stream. Supersession never silently revives
an older receipt when the newest is expired or fenced. Duplicate identities/sequences are invalid. Human approval
identifies a human authority present in the policy; publication evidence must match the policy destination.

## Decision outcomes

The envelope is `{ decision, decision_digest }`. Its payload binds the schema version, full canonical input digest, run
binding, and exactly one variant:

| Outcome                       | Additional information                                             |
| ----------------------------- | ------------------------------------------------------------------ |
| `transition_available`        | Transition, target state, and evidence references for every guard. |
| `engineering_action_required` | One Action Request whose actor is `executor`.                      |
| `human_action_required`       | One Action Request whose actor is `human`.                         |
| `waiting`                     | Existing request, claim identity/version, and Attempt identity.    |
| `blocked`                     | Stable reason codes, explanation, and recovery guidance.           |
| `terminal`                    | The already terminal lifecycle state.                              |

Neither `blocked` nor `human_action_required` changes lifecycle state. Entering suspension requires a separate guarded
transition with block evidence. `terminal` reports an already terminal run, not a completion command. Structural errors
return validation diagnostics rather than a decision bound to invalid input.

Each blocked reason is checked against explicit facts. Unavailable capability names an `action_id`, unavailable
authority names a `transition_id`, unavailable evidence names a `guard_id`, and an idempotency conflict names the full
proposed Action Request envelope. A conflict validates only if its contents pass request validation with the registry
conflict as the sole error. These references must belong to the current state. Reason text cannot substitute for facts.
Unavailable evidence requires a missing current receipt for a receipt-backed guard; a failed result or an inapplicable
phase, budget, repository, or prior-state predicate is not missing evidence. `AMBIGUOUS_REMEDY` and
`NO_APPLICABLE_REMEDY` remain valid wire codes for the future selector, but this candidate validator returns
`SELECTION_PROOF_REQUIRED` for them: proving a tie or absence of remedies requires exhaustive selection, which is
outside #105. A successful candidate check never proves precedence over alternatives.

Healthy in-flight executor work reports `waiting`. Stale subject/state binding, expired/invalidated claims, changed
policy, cancellation, and uncertain effects require reconciliation. Waiting contains no new Action Request. The
projection is limited to `idle`, `in_flight`, and `reconciliation_required`. Embedded requests must satisfy the graph's
immutable action, actor, transition, guard, and evidence requirements even when awaiting reconciliation. Healthy waiting
additionally requires current request prerequisites, policy, capability support, evidence, and bindings. Historical
bindings can be retained for reconciliation but cannot qualify as waiting.
[#106](https://github.com/nnennandukwe/threadloop/issues/106) owns acquisition, renewal, replacement, cancellation,
retry safety, receipt admission, and durable conflicts. This projection does not promise exactly-once execution.

Execution Claim and Attempt projections accept only executor requests, as defined in #106. Human handoffs retain the
shared Action Request envelope but never enter these executor claim states. Pending human work remains
`human_action_required` until accepted human evidence changes the decision; stable request identity supports later
handoff deduplication. Human notification, acknowledgement, and persistence are outside this projection.

## Action Request and human handoffs

The envelope is `{ request, request_digest }`. Requests bind the run snapshot, catalog, graph action and actor, selected
transition and remedied guards, artifact inputs, supporting receipt IDs, policy and authorities, evidence requirements,
validity constraints, and logical idempotency identity.

`actor` discriminates strict human and executor variants. `approve_change`, `merge_change`, `block_run`, and
`recover_run` are always human actions, inherited from the shared graph catalog. Other capabilities retain their
graph-declared actor. Available capability support cannot override that declaration. A human request cannot validate as
the executor variant, even after recomputing its digest.

The #104 catalog permits either `human` or `executor` for ordinary capabilities, including `run_local_gates` and
`correct_gate_setup`. Only the four capabilities listed above are globally human-only. The generic offline schemas
therefore permit either actor for ordinary capabilities; exact actor assignment is checked against the supplied Compiled
Graph during semantic validation. For example, the governed-PR graph assigns `correct_gate_setup` to a human and
`run_local_gates` to an executor. Another valid graph may assign local gates to a human. Schema validity alone does not
establish graph-specific authorization.

After current proof/review permits entry to `ready_for_human`:

```text
human_action_required: approve_change(subject B, actor human)
  -> accepted approval evidence for B
human_action_required: merge_change(subject B, actor human)
  -> accepted merge observation for B
transition_available: ready_for_human -> completed
  -> separate ThreadLoop transition application
terminal: completed
```

The human designation is explicit in both outcome and actor. #105 does not persist a handoff, notify a person, collect
approval, or record execution. The later runtime must retain these identities and evidence. An executor interface must
reject every human request. Approval of B cannot approve a later subject C.

Requests are authorization candidates: `lifecycle_mutation` is fixed to `false` and `require_current_subject` to `true`.
Declaring a possible guard remedy does not establish its appropriateness now. Construction checks necessary
prerequisites, including local proof before independent proof, both before review, and approval before
merge/publication. The future selector must still enforce the full [decision rules](selection.md).

## Canonical identity and validity

Reuse #104's canonical JSON algorithm: UTF-16 object-key ordering, safe integers, preserved strings, UTF-8 bytes, and
SHA-256. This is ThreadLoop's algorithm, not a claim of RFC 8785 conformance. Canonical files contain no whitespace or
trailing newline. Unknown fields are rejected, never dropped before hashing.

Snapshot arrays retain their supplied order, which forms part of input identity. Graph declarations must already be
normalized. The builder sorts request `guard_ids` and `evidence_ids` lexicographically, `inputs` by role, and
`evidence_requirements` by canonical JSON. These arrays reject duplicates and noncanonical request order. Authority
order is copied exactly from policy. No order is inferred from environment or provider state.

```text
input_digest    = SHA256(canonical complete Controller Input)
request_digest  = SHA256(canonical request payload)
decision_digest = SHA256(canonical decision payload)

idempotency_key = SHA256(canonical {
  schema_version: "0.1",
  binding: <full request binding>,
  action_id: <graph Required Action id>
})
```

Exact duplicate construction produces the same bytes and digest. Changed inputs, constraints, policies, or evidence
under the same logical slot produce a different request digest and conflict with a known existing request. The helper
checks only the supplied registry; durable uniqueness belongs to #106. New subjects/state versions create new slots.
Changing delivery, claim, Attempt, or timestamp does not mint a fresh action identity. Retries use Attempt semantics and
must not evade conflicts with random request identities.

Time is an explicit UTC string with exactly three fractional digits, or `null`. No default TTL or implicit clock exists.
Any input deadline requires `evaluation_time`; expiry is inclusive at `evaluation_time >= valid_until`. The builder caps
request validity at the earliest intent, observation, or supporting-receipt deadline. An observation without a deadline
still binds its subject and state version. Later execution must recheck subject, policy, claim, and state: pure
decisions cannot prove the repository has not changed since capture.

Old receipts may explain a missing guard. A current observation can support bounded evidence collection, but old results
cannot be cited as repair, publication, approval, or transition authority. Refresh stale observations before requesting
work.

## Verification and compatibility

From the repository root:

```bash
npm test -- tests/unit/controller-contract.test.ts tests/unit/workflow-graph-contract.test.ts
npm run check
npm run security:dependencies
```

Examples reference an existing #104 graph fixture by a closed name. The test assembler supplies that exact graph,
verifies its binding, and checks the resulting complete input schema and golden input digest. Metadata, expected
outcomes, and mutation recipes are not Controller Input fields. #108 will define the external subject protocol and
prevent expected-output leakage.

Positive examples retain expected decisions and exact canonical decision/request bytes. ASCII golden digests were
authored independently using Python JSON and SHA-256, then checked against TypeScript. Tests never regenerate
expectations. Negative examples distinguish schema errors from semantic failures and include rehashed tampering.

Only controller version `"0.1"`, graph version `"0.1"`, catalog `threadloop.sdlc/0.1`, and selector
`threadloop.remedies/0.1` are supported. Unknown additive and breaking versions both fail closed. Future versions
require explicit negotiation, reviewed schema/canonicalization changes, and compatibility fixtures. Existing identifiers
cannot silently acquire new meanings.

SQLite remains v8, existing CLI output is unchanged, and sessions are not retroactively converted to graph runs.
[#85](https://github.com/nnennandukwe/threadloop/issues/85) owns storage evolution;
[#86](https://github.com/nnennandukwe/threadloop/issues/86) owns durable run/configuration identity. No new runtime
dependencies, environment settings, or shipped entrypoints are introduced.

The corpus proves specification consistency and request determinism, not signature verification, concurrent execution,
crash recovery, durable handoffs, complete selector conformance, or production interoperability. Those remain
obligations under #106-#108 and the later runtime milestone in
[#110](https://github.com/nnennandukwe/threadloop/issues/110).
