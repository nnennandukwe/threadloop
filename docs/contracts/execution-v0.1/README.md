# Execution Claim and Attempt v0.1

Status: specification and development tooling for [#106](https://github.com/nnennandukwe/threadloop/issues/106). This
extends the accepted [controller contract](../controller-v0.1/README.md), within
[tracker #110](https://github.com/nnennandukwe/threadloop/issues/110). It does not execute actions, persist claims,
verify external effects, or implement distributed exclusion.

## Published contract and development interfaces

Strict Zod definitions generate offline Draft 2020-12 schemas for the
[Execution Claim](schemas/execution-claim.schema.json), [Attempt](schemas/attempt.schema.json),
[execution policy](schemas/execution-policy.schema.json), [operation](schemas/execution-operation.schema.json),
[Attempt receipt](schemas/attempt-receipt.schema.json), [receipt admission](schemas/receipt-admission.schema.json),
[recovery evidence](schemas/recovery-evidence.schema.json), and [journal](schemas/execution-journal.schema.json).

The public development functions in `scripts/execution-contract/model.ts` are:

```typescript
createExecutionJournal(context: unknown, request: unknown, policy: unknown, authority: ExecutionAuthority)
replayExecutionJournal(journal: unknown, authority: ExecutionAuthority)
applyExecutionOperation(journal: unknown, context: unknown, operation: unknown, authority: ExecutionAuthority)
projectControllerExecution(journal: unknown, snapshot: unknown, authority: ExecutionAuthority)
```

All return #104's `ValidationResult<T>`. Invalid shapes, journal digests, admission contexts, and reversed authority
time return diagnostics with no append proposal. A well-formed attempted operation returns a proposal containing:

```text
expected_execution_digest: digest of the supplied journal before the operation
journal: complete proposed journal, including the operation and its explicit context
projection: claims, Attempts, receipts, conflicts, invalidations, and operation results derived from history
result: { disposition, code, revision, claim, attempt_id, recovery }
replayed: whether this exact operation/conflicting delivery already has a recorded result
```

`disposition` is `applied`, `rejected`, or `conflict`. These describe the operation, not Workflow Run progress. A
rejected operation may append a diagnostic record while leaving claims, Attempts, and accepted receipts unchanged. An
exact operation replay returns the recorded result and unchanged journal. Another operation identity carrying the same
receipt or acquisition intent may append its own delivery record but returns the original result and never creates
another receipt, claim, or Attempt. Its `replayed` flag is false because the operation identity is new;
`result.revision` continues to identify the historical result. Neither form renews authority.

The journal is the canonical development input. Projections are rebuilt from its ordered operation/context entries;
callers cannot supply a mutable status as authority. The complete journal payload is hashed outside its envelope using
ThreadLoop's existing canonical JSON and SHA-256 conventions. Unknown fields and versions fail closed. This format is a
bounded development model, not a prescribed runtime storage layout, event store, process protocol, or signature format.

The offline validator accepts at most 256 retained entries, 16 MiB of JSON per input/proposed journal, one million JSON
values, and 64 nesting levels. It checks resource bounds before schema cloning, canonicalization, authority calls, and
replay. Exceeding a limit returns `EXECUTION_INPUT_LIMIT` without a proposal. A full journal still supports exact
operation redelivery without appending. Preserve the complete history and use a conforming implementation with enough
capacity; truncating history or resetting the same logical request would discard identity and fencing obligations. These
are development-tool limits, not production retention policy. Object traversal stops at the first exceeded budget
without materializing every property/value pair.

Replay builds private indexes for operation, grant, and observation identities in one pass. Prefix hashes extend the
canonical entries array incrementally, preserving the full-payload SHA-256 contract without repeatedly serializing
history. Each public call validates the supplied history; no persistent cache or mutable caller-supplied projection is
trusted. Incremental SHA-256 uses the existing crypto adapter boundary in `src/adapters/crypto/sha256.ts`; execution
replay does not construct a platform hasher directly.

## Identity and authority

Every operation, claim, Attempt, receipt, receipt admission, and recovery observation retains:

- the exact Action Request idempotency key and request digest;
- Workflow Run identity, graph schema version/digest, source Lifecycle State and state version;
- the exact original repository revision/content digest or artifact identity/content digest;
- the admitted execution policy identity/digest, which also binds the original Workflow policy;
- claim identity and fencing generation, Attempt identity, and executor identity/incarnation where applicable.

The original Action Request retains its action, capability, actor, transition, guards, inputs, constraints, required
evidence, Workflow policy, and authority identities. Human Action Requests cannot enter this model. A resulting subject
is additional evidence: it cannot overwrite the original binding or make an earlier approval current for new content. A
non-null resulting subject is a successor of that bound subject: its kind and repository/artifact identity must match.
Changed content or repository revision is permitted for an occurred effect. If supplied, a no-effect resulting subject
must equal the complete original subject. A null result makes no separate successor claim; the required
`binding.subject` remains intact in the receipt and Attempt. Other output artifacts belong in evidence references and
the output protocol in #107.

An executor incarnation identifies one bounded process/run identity. A restarted process does not silently inherit the
old incarnation's permission to repeat work. Delivery identities confer no authority. ThreadLoop admits the request and
immutable execution policy; the executor can acquire its own claim, start, renew, release, and submit evidence. Only a
current ThreadLoop or human authority can cancel/invalidate. Expiry recording belongs to ThreadLoop. Reconciliation and
conflict disposition require a current human authority identified by the explicit snapshot policy.

Every public development function requires a host-supplied `ExecutionAuthority` with
`isAdmitted(digest: string): boolean`. This independent lookup is supplied through application wiring, never decoded
from an executor message, journal, or snapshot. Before evaluating an operation the validator requires an affirmative
lookup for the exact admission digest. Missing approval, a non-boolean result, or an unavailable authority returns
`UNTRUSTED_EXECUTION_INPUT` without an append. There is no permissive default.

`executionAdmissionDigest` in `scripts/execution-contract/authority.ts` hashes the canonical envelope
`{ domain: "threadloop.execution-admission.v0.1", admission }`. Its three admission variants bind:

- `create`: the complete initial context, request, and execution policy;
- `operation`: the current journal digest, complete context, and complete operation;
- `projection`: the journal digest and complete current controller snapshot.

The authority must admit authenticated actor identity and intent, current policy/registry state, verified graph/run/
history and observations, and exact independently verified receipt/recovery acceptance records. Computing this digest is
not proof of admission: the authority lookup must resolve it in a separately controlled source. In particular, it must
never populate its allowlist from the same incoming JSON. Replay checks the initial admission and each historical
operation admission against its exact prefix; it cannot legitimize a fabricated history merely by rehashing it.
Historical admissions remain auditable after authority rotation; fresh admissions must use the current authority and
reject rollback. The authority must distinguish an admitted historical prefix from the current committed head for a new
operation/projection. Commit still requires the atomic comparison below.

Cancellation, invalidation, expiry, and human recovery/conflict disposition may use an admitted snapshot from a newer
run or graph while targeting the exact original operation binding. The authority must explicitly admit that old-bound
operation and the current context together. These paths preserve the original request, claim and Attempt bindings and
record unknown effects; they confer no authority to execute in the new context. Acquisition, renewal, start, release,
receipt submission, registration, and controller projection still reject a different run or graph.

An admitted new policy can revoke old actors and authorize current actors to cancel or invalidate an old-bound request.
An executor-added authority, admission record, acceptance identity, or modified command changes the admission digest and
cannot inherit a prior approval. This defines and enforces the development trust seam; the production
identity/provenance provider and underlying artifact verification are specified by #107 and remain future runtime work
in #111.

Request identities are globally unique logical slots under #105. Within a slot, operation, receipt, receipt-admission,
claim, Attempt, and recovery-evidence identities cannot be reassigned. Runtime claim identities must also be unique
across a Workflow Run, so #105's claim-reference invalidation cannot fence an unrelated request. Cross-journal registry
uniqueness is a runtime admission obligation; evaluating two independent copies in memory cannot enforce it.

Recovery observations and receipt admissions in every operation context are checked for identity collisions before
returning an earlier result, even when that operation does not use the observations. All collisions in a context are
retained together; the operation returns the first conflict result and the projection lists every conflict. Replaying an
unchanged operation cannot conceal changed observation content under a reused identity. A contradictory initial context
fails with `INITIAL_EVIDENCE_CONFLICT` before a journal exists; replay applies the same initial validation. Exact
duplicate observation copies are idempotent.

Every first retained schema-valid receipt submission reserves its receipt identity, including rejected executor
mismatches. This preserves rejection history; it does not admit the report or authorize its submitter. An operation-ID
collision does not admit the alternate operation's receipt identity, just as it does not admit alternate grant
identities.

Rejected grant proposals also reserve their proposed claim and Attempt identities. Exact redelivery returns the original
rejection; changing a deadline, executor, or recovery evidence under those identities produces a conflict. After
refreshing a stale execution precondition or adding missing evidence, submit a new operation with fresh proposed claim
and Attempt identities. This does not consume Attempt capacity until acquisition is accepted. Conflicting reuse of an
operation identity is retained as an operation conflict, without admitting its alternate grant identities.

`register_request` tests request-registry reuse against an existing journal. It requires a complete valid candidate,
never just an alleged digest. Exact content reports `REQUEST_ALREADY_REGISTERED`; different valid content under the same
logical slot appends `IDENTITY_CONFLICT`. Malformed candidates and different slots are rejected. This does not register
new actions or choose work. Initial admission must atomically create a slot only if absent; an existing slot must use
its retained journal instead of calling `createExecutionJournal` again.

## State and acceptance boundary

| Current state                  | Operation          | Result                                                                                              |
| ------------------------------ | ------------------ | --------------------------------------------------------------------------------------------------- |
| Open request, no claims        | `acquire`          | One active generation and one pending Attempt.                                                      |
| Active claim, pending Attempt  | `start`            | Running Attempt; effects become unknown until evidence establishes otherwise.                       |
| Active, unexpired claim        | `renew`            | Later deadline, same claim generation and Attempt.                                                  |
| Active claim                   | `release`          | Authority ends; pending work is interrupted without starting, running work requires reconciliation. |
| Active claim at/past deadline  | `expire`           | Expired claim; preserves unknown effects for started work.                                          |
| Closed claim, retry admissible | `replace`          | New claim identity, next generation, new pending Attempt; predecessor is retained as replaced.      |
| Open request                   | `cancel`           | No further acquisition/start; running effects remain unresolved.                                    |
| Authorized invalidation        | `invalidate`       | Request cannot execute; history and uncertainty remain.                                             |
| Running Attempt, current claim | `submit_receipt`   | Retain terminal report and its acceptance/rejection; successful accepted work closes the request.   |
| Closed unreconciled Attempt    | `reconcile`        | Append human disposition and independent evidence; preserve the original report/status.             |
| Retained identity conflict     | `resolve_conflict` | Human selects the original digest; both conflicting contents remain.                                |

One claim generation has exactly one Attempt. `pending` means the start operation has not been accepted. `running` means
start was accepted, not that a process is known alive. Attempt terminal statuses are `succeeded`, `failed`, `blocked`,
`interrupted`, `cancelled`, and `unknown_outcome`. Effect knowledge is separately `not_started`, `none`, `occurred`, or
`unknown`. An interrupted process does not imply `none`. An admitted terminal receipt with `effect: unknown` stays
intact while the Attempt projects `unknown_outcome`; a successful receipt cannot claim an unknown effect or omit all
supporting evidence references. One accepted terminal receipt closes the Attempt; another identity cannot reopen it.
Successful read-only work may correctly report `effect: none`; the request is satisfied because the bounded action
succeeded. Effect knowledge describes external effects, independently of action success. A failed or interrupted
no-effect outcome can instead leave an open request eligible for replacement.

## Trusted receipt admission

Every new terminal receipt acceptance requires exactly one distinct trusted ThreadLoop receipt-admission record in
`context.receipt_admissions`. An executor report alone cannot establish success, known no effect, or a known effect. The
admission contains the exact receipt identity/digest, all request/run/graph/state/subject/policy/claim/Attempt/executor
bindings, an accepted verification-policy identity/digest, an acceptance identity/digest, admission time, and optional
expiry. Its own digest covers the entire admission. Admission must occur at/after reported completion and no later than
evaluation time; expiry is inclusive. The receipt digest also binds its outcome, effect knowledge, resulting subject,
and every evidence reference, so substituting an artifact or changing a report requires another admission.

The trusted admission boundary must verify the referenced artifacts, their actual digests, applicable policy, exact
subject/effect scope, and the asserted outcome/effect knowledge before issuing this record. A failure report claiming
`effect: none` requires that verification too: absence of a receipt or an executor assertion cannot authorize retry. The
validator checks the bound record only inside an independently admitted operation context. A fabricated record changes
that context's admission digest and fails the authority lookup, even when all record hashes are valid. Hashes and
acceptance identities alone are not authentication. [#107](../executor-v0.1/README.md) specifies the underlying
artifact/provenance verification obligations; #111 will implement runtime verification before the authority approves an
admission digest. The test fixture helper populates a synthetic admission store; separate trust-boundary tests use the
raw public API and a protected test allowlist to reject executor modifications.

A missing, stale, mismatched, or bad-digest admission retains the raw report with `RECEIPT_ADMISSION_MISMATCH` and
leaves the running Attempt, unknown effect knowledge, and open request unchanged. Exact redelivery preserves that
rejection; it cannot retroactively turn the same receipt identity into accepted evidence. After verification, a fresh
report and admission identity may describe the same completed work while the original claim remains current, without
repeating the effect. If authority has expired, use independent recovery instead. A changed reused admission identity is
a durable conflict. Admission never bypasses fencing, creates a #105 normalized guard receipt, or advances a Workflow
Run.

Every operation carries `expected_revision` and `expected_execution_digest`. Fresh execution and lifecycle mutations
enforce them. Identity observations are intentionally evaluated first: request registration, historical redelivery, and
changed identity reuse can retain their result despite stale operation preconditions. They cannot create new claim
authority, admit another receipt, or replace the original request; a collision intentionally blocks fresh work until
human disposition. The resulting append proposal still requires an atomic comparison against its returned
`expected_execution_digest`, which identifies the current supplied journal. Stale operation preconditions never
authorize committing against stale storage. Revision counts retained journal entries, including rejections/conflicts; it
does not change Workflow Run state version or repair budgets. Claim `version` is the fencing generation, increasing
across replacement/retry and never reset by executor restart. Renewal changes journal revision and timestamps but
preserves that generation. Closed generations never become active again, even for the same executor.

The future atomic acceptance operation is **compare the committed journal digest and append the complete operation,
context, resulting disposition, and any admission/conflict records as one transaction**. Only after that acceptance may
an acknowledgment be sent. A failed comparison must reread committed history and evaluate the same operation identity;
it must never publish a second grant from a stale proposal. The test model's journal append represents this boundary,
without selecting database tables or implementing transactions.

Accept `start` before any action work. The executor must recheck current authority before work and protected effects;
replaying an earlier start acknowledgment is not a command to start a second execution. A future executor must also
track its own dispatch/restart boundary. Fencing at ThreadLoop can reject evidence but cannot stop an already issued
external call. A cooperating effect boundary may additionally enforce fencing/idempotency; no such adapter is
implemented here. There is no exactly-once execution promise and no exclusion guarantee for unrelated requests sharing
an external resource.

## Time, renewal, and invalidation

Use explicit, real UTC timestamps with exactly three fractional digits. No machine clock, implicit deadline, retry
interval, scheduler, or environment setting is read. Authority time is nondecreasing. Exact historical operation replay
is resolved before current freshness checks, because it creates no new authority; a new operation at an earlier time is
invalid. Executors' `finished_at` timestamps cannot override the authority's admission time.

Expiry is inclusive: `now >= valid_until`. Start, renewal, and new receipt acceptance fail at that boundary even if no
`expire` event has been appended. An explicit expiry operation records closure and recovery obligations; the read-only
projection independently reports expired work as requiring reconciliation. Renewal must strictly extend the current
deadline and cannot exceed immutable request validity. A deadline cannot resurrect a closed generation.

Fresh execution authority rechecks request bindings, prerequisites, policy, capability support, subject freshness, and
claim invalidation. Drift produces a rejected operation or a reconciliation projection; it never rebinds the request. An
expired request cannot be extended under its old idempotency identity. A permanently invalidated/expired request may
require a separately authorized new Workflow Run; do not invent a state version, alter a subject, or randomize an action
identity to evade the old slot. The journal does not implement Workflow Run creation/recovery.

Closure and recovery deliberately retain the original request binding even when the current lifecycle has drifted.
Expiry requires the exact existing claim/Attempt, current ThreadLoop authority, current journal preconditions, and
authority time at/past the recorded deadline. It does not require obsolete request prerequisites to become true again.
The admitted current policy must still authorize that actor; a revoked actor cannot close the claim. Snapshot freshness
and anti-rollback admission remain mandatory for every operation, including closure.

`binding_changed` and `request_expired` invalidations require the corresponding explicit facts. `authority_revoked` is
an authorized revocation command. `integrity_failure` is an explicit retrospective invalidation: it adds claim
references to `invalidated_claims`, including closed claims, so previously accepted evidence can no longer satisfy #105
guards. Ordinary renewal, successful completion, or elapsed time after acceptance does not retrospectively invalidate
accepted proof. Its independent subject, policy, validity, and supersession rules still apply.

## Retry safety and independent recovery

Execution policy is immutable, digest-bound to this exact Action Request and Workflow policy, and includes a positive
`max_attempts`. Accepted acquisition consumes one Attempt; rejected operations and duplicates consume none. Defaults
must be explicit in admitted input: use `reconciliation_required` unless the action's entire effect boundary justifies
more. There is no inference that a test command, capability name, or HTTP method is repeatable.

| Policy                    | Replacement after a started Attempt lacks a definitive no-effect outcome       |
| ------------------------- | ------------------------------------------------------------------------------ |
| `reconciliation_required` | Human disposition plus independent evidence is required.                       |
| `repeatable_after_stop`   | Independent evidence that the exact prior executor stopped is required.        |
| `repeatable_with_overlap` | Explicit policy permits repetition even if the prior executor might still run. |

All cases still require closure/fencing of the old claim, current request authority, new identities/generation, and
remaining Attempt capacity. Only policy explicitly safe under overlapping execution permits overlap. Before admitted
start, replacement needs no external no-effect observation because compliant executors cannot act before start. An
accepted unsuccessful terminal no-effect receipt or human-confirmed no-effect outcome also permits retry; it cannot
override request satisfaction, cancellation, invalidation, or exhaustion. Successful no-effect work is not retried.

Recovery observations are separate, already-admitted records for `executor_stopped`, `effect_occurred`, or `no_effect`.
Identities retained in the initial context participate in the same collision checks as later entries. Observations bind
the original request, claim, Attempt, executor incarnation, and subject; include their own digest, accepted
verification-policy identity, and acceptance identity; and must be observed at/after recorded claim closure and no later
than evaluation time. A late executor receipt cannot be relabeled as one of these independent observations. The
acceptance adapter must verify actual provenance, artifacts, effect identity/destination, and the observer's authority
before use. The core does not define provider-specific queries or #107's receipt normalization.

Human reconciliation requires `executor_stopped`. `effect_confirmed` additionally requires `effect_occurred`, and
`no_effect_confirmed` additionally requires `no_effect`; `abandon` needs stop evidence alone. Contradictory
observations, missing stop proof, changed bindings, or bad hashes do not clear uncertainty. `effect_confirmed` for any
generation closes an open request against repetition and cancels any active replacement; it does not manufacture a
successful executor receipt or satisfy lifecycle guards. A cancelled replacement that already started retains its own
unknown outcome for separate reconciliation. This current human disposition is distinct from a fenced executor's late
report, which cannot close another generation. `no_effect_confirmed` allows a separately acquired replacement if all
other conditions hold. `abandon` requires stopped execution, cancels any active replacement, prevents another Attempt,
and preserves the unresolved historical effect report. Abandonment is a human acceptance of an unresolved historical
outcome, not proof of no effect. It cannot satisfy a proof or completion guard. After abandonment, the execution slot
may become `idle` only when there is no other active or unresolved Attempt; the cancelled request remains closed and the
original `unknown` report plus explicit human abandonment remain in history. This ends the execution obligation, not the
Workflow Run. Replaced Attempts retain their unresolved effects. Once active work closes, all unresolved generations
remain visible until individually reconciled, including after cancellation of a replacement. Conflict resolution does
not resolve unknown effects. There is no repeat-despite-unknown override for a non-repeatable action in v0.1.

Recovery checks all valid current and retained observations for the exact Attempt, including observations omitted from
`evidence_ids`. An admitted `effect_occurred` and `no_effect` disagreement returns `RECOVERY_EVIDENCE_CONTRADICTORY`;
receipt effect knowledge and prior reconciliation also participate. Selecting only favorable references cannot establish
no effect or permit replacement. Evidence for a different binding or observation that failed its original policy/time
validation is not silently promoted. Contradictory evidence leaves the Attempt and request unchanged and requires
independent investigation; no automatic retry or evidence deletion resolves it.

## Failure and recovery matrix

For every row, Workflow Run lifecycle state/version, graph, original subject/request, proof-plan binding, human
approval, and repair-budget history remain unchanged. Records listed below are proposed append-only history, not actual
persistence performed by this package.

| Failure or interruption                   | Forbidden change                            | Retained result/evidence                               | Caller/operator recovery                                                   |
| ----------------------------------------- | ------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| Duplicate acquisition, same content       | No second claim/Attempt; no extended time   | Original grant/result                                  | Read current claim; never infer freshness from replay.                     |
| Different executor competes               | No second current grant                     | `EXECUTION_VERSION_CONFLICT` or `CLAIM_HELD`           | Reread committed claim; wait or use permitted recovery.                    |
| Reused identity, changed content          | No overwrite or reinterpretation            | `IDENTITY_CONFLICT`, both canonical inputs and digests | Human resolves against original digest; new effects remain blocked.        |
| Crash before proposed append commits      | No acknowledged grant or start              | Prior committed journal                                | Replay the same operation against that journal.                            |
| Crash after append, before acknowledgment | No second execution record                  | Committed operation and deterministic result           | Reconstruct and return the original result.                                |
| Death before admitted start               | No action work                              | Closed pending Attempt, `not_started`                  | Fence/close, then acquire a new generation.                                |
| Death during execution                    | No inference of failure/no effect           | `unknown_outcome` and original bindings                | Apply retry policy or human reconciliation.                                |
| Effect completes, receipt absent          | No blind repetition                         | Started Attempt and uncertainty                        | Independently inspect the exact effect, then human disposition.            |
| Terminal report lacks trusted admission   | No success or known no-effect acceptance    | Raw report and admission rejection                     | Verify evidence; submit new report identities while current, or reconcile. |
| Expiry/replacement, late receipt          | No new acceptance or replacement completion | Receipt plus `CLAIM_FENCED`                            | Keep diagnostic evidence; independently reconcile if needed.               |
| Exact receipt replay after acceptance     | No new receipt/admission                    | Original acceptance result                             | Return acknowledgment; do not repeat effects.                              |
| Cancel before acquisition                 | No grant                                    | Cancelled request                                      | Outer lifecycle handling remains separate.                                 |
| Cancel while pending                      | No start                                    | Cancelled Attempt, `not_started`                       | Preserve cancellation; no replacement.                                     |
| Cancel while running                      | No claim authority; no asserted rollback    | Cancelled claim, unknown effect                        | Prove stop and reconcile; cancellation remains binding.                    |
| Claim/request/subject/policy drift        | No renewal or authoritative receipt         | Rejected operation and reconciliation context          | Restore verified context or resolve the old execution.                     |
| Malformed input or damaged journal        | No append proposal                          | Original input remains with caller; diagnostics        | Restore verified history; never silently reset it.                         |
| Attempt capacity exhausted                | No additional grant                         | `ATTEMPT_LIMIT_REACHED`                                | Human review; no counter reset or policy rewrite.                          |
| Schema generator interrupted              | No claim about coherent generated artifacts | Edited working files; prior Git revision retained      | Rerun generator, then parity tests; commit only coherent artifacts.        |

## Three concrete sequences

Two executors receive the same local-proof request for commit B at state version 5. A's acquisition commits at execution
revision 1. B's proposal against revision 0 is rejected. A's lost acknowledgment replays the same claim and Attempt. The
model checks both admission orderings; the runtime must provide the atomic compare/append that makes one ordering real.

A receives a publication request for artifact B and the bound destination, admits start, completes publication, then
crashes before its terminal receipt. Expiry leaves an unknown outcome. An operator supplies independently admitted stop
and effect observations and records `effect_confirmed`. The original Attempt remains historically unknown, the request
cannot publish again, and ThreadLoop still requires appropriate accepted lifecycle evidence.

After a permitted replacement, A's generation 1 receipt arrives while B owns generation 2. A's receipt is retained as
fenced. B's Attempt and claim remain untouched. If A's identical receipt had already been accepted before expiry, a
repeat would instead replay that historical acceptance; closure is not retrospective revocation.

## Controller projection and compatibility

Projection supplies only #105's existing `execution`, `invalidated_claims`, and `existing_requests` fields. It never
produces accepted normalized receipts or Controller Decisions. Healthy pending/running work becomes `in_flight`. For an
explicitly permitted replacement, this single #105 slot describes the current claim while older unknown outcomes remain
visible in the full execution journal/projection. Waiting cannot advance the lifecycle. Once active work closes,
unresolved older effects require reconciliation before any lifecycle progress. Expired/fenced current work, identity
conflicts, or invalidation also become `reconciliation_required`; conflict/invalidation projections prefer an unresolved
Attempt over a newer resolved replacement when one exists. Detailed causes remain in this journal while #105's coarser
reason vocabulary is preserved. Resolved execution may become `idle`; that does not cancel, recover, advance, approve,
merge, or complete a Workflow Run.

Inactive journals also validate their exact original request against the current snapshot. State, subject, policy,
authority, capability, observation/evidence freshness, or request expiry drift projects reconciliation instead of idle.
This does not rewrite accepted receipts or invalidate a completed claim merely because its request is now historical.

The projection refuses another run/graph or a different outstanding Action Request rather than overwriting it. A future
authority must serialize execution obligations across a Workflow Run as required by #105, even though this bounded
journal models one request. Exact normalized receipt IDs/sequences remain unique in #105; transport deduplication
happens before normalization. Ordinary completed claims are not added to the evidence-invalidation list.

[#107](https://github.com/nnennandukwe/threadloop/issues/107) owns process messages, observed-effect details, resource
usage, provider trust/normalization contracts, and the [GAAP mapping](../executor-v0.1/README.md). One ThreadLoop
Attempt can map to one GAAP Agent Run, but this build imports no GAAP types and implements no adapter.
[#108](https://github.com/nnennandukwe/threadloop/issues/108) owns the external implementation-independent subject
protocol and expected-output isolation. The fixture corpus here is specification development evidence, not external
conformance or runtime interoperability proof.

Controller/graph versions and golden artifacts retain their original meaning and bytes. No current CLI, SQLite v8
storage, session, runner, daemon, or packaged runtime behavior changes. Unknown future execution versions must negotiate
explicit support; no fields are dropped before hashing.

## Verification and proof limits

```bash
npm test -- tests/unit/execution-contract.test.ts tests/unit/execution-authority.test.ts tests/unit/execution-limits.test.ts
npm test -- tests/unit/controller-contract.test.ts tests/unit/workflow-graph-contract.test.ts
npm run check
npm run security:dependencies
```

`npm run spec:execution:schemas` is an explicit developer command that rewrites only published execution schemas. Tests
never regenerate expectations. [Scenario fixtures](fixtures/scenarios.json) declare expected operation codes,
claim/Attempt states, receipt counts, and controller projections. The fixture assembler reuses the accepted governed-PR
and release-publication inputs, and passes no expected outcomes to the model. [Rejections](fixtures/rejections.json)
include structurally invalid operations and semantically invalid receipts with recomputed hashes. Admission tests also
alter every binding and reseal its digest, check policy/time validity, and reject raw reports with invented evidence
references. Accepted report fixtures explicitly model trusted ThreadLoop admission; they do not verify the synthetic
artifacts.

[Golden digests](fixtures/golden-digests.json) were independently authored using Python sorted-key JSON and SHA-256,
from the accepted #105 action-required request and explicit acquisition fields. They do not call the TypeScript
producer. Existing #104/#105 canonical-byte tests continue to govern the shared canonicalization algorithm. Ajv
validates the published schema documents and generated example shapes offline; Zod and semantic checks enforce the full
contract.

Tests prove deterministic proposal/replay behavior, rejection rules, and consistency with the real controller candidate
validator. They do not prove filesystem durability, transaction isolation, executor death, authenticated observations,
external effect fencing, or exactly-once effects. #107 specifies the executor seam, #108 owns external conformance, and
issue #111 owns runtime adapter acceptance. No scheduler, queue, database, daemon, retry timer, or distributed test
infrastructure is introduced.
