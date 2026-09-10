# Executor interface and GAAP mapping v0.1

Status: specification and offline development tooling for [#107](https://github.com/nnennandukwe/threadloop/issues/107),
within [Controller Contract tracker #110](https://github.com/nnennandukwe/threadloop/issues/110). This contract extends
the accepted [Action Request](../controller-v0.1/README.md) and
[Execution Claim and Attempt](../execution-v0.1/README.md) contracts. It does not execute actions, fetch artifacts,
authenticate receipts, persist admissions, or advance a live Workflow Run.

## Published interface

Strict Zod definitions publish offline Draft 2020-12 schemas for the
[executor request](schemas/executor-request.schema.json), [executor result](schemas/executor-result.schema.json),
[GAAP mapping policy](schemas/gaap-mapping-policy.schema.json), and
[result observation](schemas/result-observation.schema.json). Unknown fields, versions, capability kinds, evidence
types, receipt descriptor types, and digest formats fail closed. A future version requires explicit implementation
support.

Development interfaces live in `scripts/executor-contract/`:

```typescript
parseExecutorMessage(bytes: Uint8Array): ValidationResult<unknown>
canonicalExecutorJson(value: unknown): ValidationResult<string>
validateExecutorRequest(value: unknown): ValidationResult<ExecutorRequest>
validateExecutorResult(value: unknown, request: unknown): ValidationResult<ExecutorResult>
validateExecutorContext(request: unknown, journal: unknown, snapshot: unknown, authority: ExecutionAuthority)
buildGaapRequest(request: unknown, mappingPolicy: unknown): ValidationResult<GaapRequest>
mapGaapResult(request: unknown, mappingPolicy: unknown, bytes: Uint8Array, observation: unknown)
```

The last mapping returns `ValidationResult<ExecutorResult>`; context validation returns
`ValidationResult<ExecutorRequest>`. All successful results are detached candidates. None constitutes authenticated
evidence or dispatch authorization. Invalid input returns existing structured diagnostics with code, path, message, and
recovery guidance, without mutation.

`validateGaapRequest` and `validateGaapReceipt` additionally expose the pinned upstream shape and ledger-consistency
checks for offline corpus verification. They do not evaluate GAAP policies or authenticate actors. The mapping-policy
check in `buildGaapRequest` supplies the exact policy/capability allowlist; direct upstream shape validation does not
supply it.

## One-shot process protocol

Protocol identity: `threadloop.executor/0.1`. One process invocation receives one canonical UTF-8 executor request on
stdin followed by EOF and returns one canonical executor result on stdout followed by EOF. One final LF is permitted and
excluded from content digests. No BOM, CRLF, extra whitespace, duplicate keys, extra messages, or log text is allowed.
Diagnostics belong on stderr. The JSON APIs and byte parser are separate: callers must parse bytes and then validate the
appropriate request/result schema. Passing a byte parser alone proves no contract shape or authority.

For a selected GAAP adapter, this outer process receives ThreadLoop bindings; the inner Agent Run receives only the
mapped `gaap.agent-run-request/0.1.0`. The adapter retains the exact outer request and correlates the terminal GAAP
receipt before producing the outer result. GAAP's core vocabulary has no ThreadLoop graph, state, claim, or transition
fields.

The future host must launch the executable directly without a shell, deliver the request once, bound stdout/stderr,
enforce resource and authority deadlines, collect complete output, and require a successful transport outcome in
addition to a valid result. Exit zero alone is not evidence. Missing output, nonzero exit, timeout, cancellation,
malformed UTF-8, incomplete JSON, or multiple results produces a transport diagnostic, never a fabricated successful
receipt. A valid report arriving with failed transport may be retained for reconciliation but is not automatically
admitted.

The future host rechecks live authority before work and protected effects. A preflight check is a point-in-time check,
not a guarantee that the claim remains current during execution. There is no launch, cancellation handler, heartbeat,
retry timer, authority exchange, or process continuation implemented here.

## Immutable executor request

The envelope is `{ request, request_digest }`. Its request carries the protocol version and `kind: execute`, the entire
accepted Action Request, execution-policy identity, claim identity/generation, Attempt identity, executor identity and
incarnation, mapping-policy identity, and explicit execution parameters. The nested Action Request retains Workflow Run,
graph, lifecycle state/version, subject, authorities, constraints, inputs, and evidence requirements unchanged.

Parameters contain an exact subject locator, named/versioned/digested capability, task instructions and ordered
constraints, exact supported policies, explicit resource budget, approval evidence, and independent-verification types.
Each evidence family has at most one mapping, enforced in both the published mapping schema and the mapper. No policy,
capability, budget, locator, approval, or evidence mapping is guessed. Array order is significant. Duplicate policies,
approval IDs, or required evidence types are invalid. Empty approval context is explicit and grants nothing. Every
approval binds the initial subject and uses approval evidence.

Published schemas express structural rules and full-value array uniqueness; cross-field hashes, approval identity
uniqueness, and authoritative context still require the corresponding validation functions.

`validateExecutorRequest` checks immutable shape, hashes, action identity, executor actor, and parameter consistency.
`validateExecutorContext` additionally uses #106's independently admitted journal replay and controller projection to
require an exact, current, started Attempt. Pending work cannot pass preflight. It rejects subject/state/policy drift,
expired/replaced claims, conflicts, cancellation, wrong executor/incarnation, and untrusted context.

The same host-supplied `ExecutionAuthority` must separately recognize:

```text
SHA-256(ThreadLoopCanonicalJSON({
  domain: "threadloop.executor-request-admission/0.1",
  request: complete_executor_request_envelope
}))
```

`executorRequestAdmissionDigest` computes this identity only. The host must approve task material, locator resolution,
constraints, budgets, capability support, mapping-policy identity, and any approval evidence before admitting it. The
host must retain at most one immutable executor request per Attempt; altered parameters require a new permitted Attempt,
not another approval for the same Attempt. This is a host admission/persistence obligation, not implemented storage. Do
not populate an admission allowlist from received JSON or treat a hash as authentication.

Lease deadlines are excluded from the immutable envelope. Renewal preserves request and Agent Run identity; the current
deadline is checked against the independent snapshot. An exact duplicate preflight or mapping call launches nothing,
does not renew a lease, and does not authorize duplicate work. These contracts make no exactly-once execution promise.

## GAAP mapping policy and request

Mapping identity: `threadloop.gaap-mapping/0.1`. Its content-addressed policy selects one existing executor capability,
one exact target capability identity, exact ordered GAAP policy identities, and an explicit evidence-family/type
mapping. Each requested family must have one mapping; the selected union must exactly match requested verification
types. There are no wildcard policy identities or fallback capabilities. Human Action Requests cannot map to GAAP
execution.

| ThreadLoop input                                          | GAAP output                                                                                  |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Executor request digest                                   | `request_id = threadloop_request_` plus that digest                                          |
| Exact request/Workflow Run/claim/Attempt/executor binding | Deterministic `run_id = threadloop_attempt_` plus binding digest                             |
| Subject kind, explicit locator, content digest            | Subject with the same kind/locator and `sha256:` digest                                      |
| Explicit capability and policies                          | Same names/versions and prefixed digests                                                     |
| Task, ordered constraints, budget                         | Exact supplied values                                                                        |
| Existing approval evidence                                | Explicit actor/scope/subject/evidence; no authority is inferred from ThreadLoop actor labels |
| Independent-verification types                            | Exact supported types with `different_actor` independence                                    |

The run-identity preimage is
`{ domain: "threadloop.gaap-agent-run/0.1", request, workflow_run_id, claim, attempt_id, executor }`, where `request` is
the execution contract's `{ idempotency_key, request_digest }` reference. It excludes lease-renewal data. A replacement
Attempt changes the run identity. The complete executor request digest also binds the mapping policy and parameters, so
they cannot be changed while preserving its request identity.

Opaque repository IDs are not assumed to be URLs. The host resolves and verifies `subject_locator` against the exact
repository revision/artifact before request admission. GAAP's core subject does not carry ThreadLoop revision metadata;
the retained outer request preserves it. Text constraints remain task data, not a substitute for GAAP effect policy.

## Results and one-shot authority handling

The executor envelope is `{ result, result_digest }`. It contains the exact executor request digest, an unchanged #106
Attempt receipt envelope, original receipt descriptor/digest, ordered observed mutations, verification records,
supporting evidence references, resource usage, and a structured reason. The original GAAP bytes must remain available
under their digest: summaries never replace the source ledger's decisions, plans, approvals, tool execution, or
chronology. Omitted optional upstream evidence locators become explicit `null` in the executor result; supplied locators
are preserved.

GAAP receipt types are checked against the pinned schema. Those immutable upstream schemas describe structural shapes;
they deliberately retain broader enums and generic evidence references. The semantic validators additionally require
terminal outcomes, approval evidence in approvals, and event-specific evidence categories. Schema-only validation is
insufficient for a candidate, and no pinned upstream file is rewritten to incorporate these checks. The mapping verifies
request/run/initial-subject digests, contiguous valid lifecycle transitions, matching terminal status/reason, effects in
`executing`, verification in `verifying`, ordered allow/effect bindings, mutation chaining, current-subject completion
verification, cumulative usage, and completion budget consistency. This checks reported consistency only. It does not
verify artifacts, signatures, policy contents, actual tool execution, or independent actor identity. Recorded approvals
must target the subject current at their event; a later failed verification of the current subject invalidates its
earlier pass.

| GAAP terminal outcome                    | Attempt candidate | Reason               |
| ---------------------------------------- | ----------------- | -------------------- |
| `completed`                              | `succeeded`       | `completed`          |
| `blocked` after an unresolved ask        | `blocked`         | `authority_required` |
| `blocked` after a matching denied effect | `blocked`         | `effect_denied`      |
| `blocked` with `runtime.hard_stop`       | `blocked`         | `budget_exhausted`   |
| Other `blocked`                          | `blocked`         | `blocked`            |
| `failed`                                 | `failed`          | `failed`             |
| `interrupted`                            | `interrupted`     | `interrupted`        |

The exact upstream terminal reason is retained as the reason message. Denial classification uses the matching causal
decision, even if an unrelated allow appears later. GAAP's native contract permits resumable `awaiting_authority`, but
it is not terminal and cannot be returned alone. The native receipt consistency validator preserves that contract. The
one-shot mapper rejects resumed asks: after an ask only usage accounting and transitions to `awaiting_authority` or
terminal `blocked` are permitted, with an authority-required reason matching that ask. Obtaining authority does not
resume this Attempt; ThreadLoop must determine permitted recovery and a new Attempt. No interactive protocol is added.
GAAP v0.1.0 has no terminal `cancelled`; the neutral executor contract preserves it for compatible producers, and the
mapping never invents a GAAP cancellation receipt.

A direct successful executor candidate also requires a latest-subject passing verification record with every requested
evidence type and an actor ID different from the executor ID. The source receipt ID/digest must appear in the retained
Attempt evidence. These are correlation checks, not authentication of identities or evidence.

Usage consists of non-negative safe integers: cost in micros, elapsed milliseconds, model tokens, and tool calls. An
`effect: occurred` report requires a mutation summary. An `effect: none` report permits no mutations and must retain the
complete original subject if a resulting subject is supplied. Completed candidates report the mutations in their ledger,
or `effect: none` when none are reported. All non-completed GAAP candidates conservatively report `effect: unknown`,
retaining any observed partial mutations. Stopping the process or failing before an observed mutation is not independent
proof of no effect. A neutral producer with `effect: unknown` may retain an observed changed subject even when it could
not observe attributable mutations. That incomplete report remains `unknown_outcome` under #106 and requires independent
recovery; the validator does not invent a mutation summary.

`mapGaapResult` requires an explicit completion-time/result-subject observation because those complete ThreadLoop fields
do not exist in GAAP's terminal body. The observed digest must match the receipt; repository/artifact identity must be
preserved. If content is unchanged, the entire subject must remain unchanged. The observation is still untrusted input
until the future host verifies it. Retimestamping or changing a result under the same native receipt identity produces
changed canonical Attempt content and must follow #106's conflict rules, not overwrite prior evidence.

## Canonical bytes, limits, and compatibility

ThreadLoop payload hashes retain their existing sorted-object canonical JSON and unprefixed SHA-256 conventions. GAAP
request and receipt-body hashes use RFC 8785 canonical bytes and `sha256:` prefixes. Envelopes exclude their own digest
from its preimage. No fields are dropped before hashing. The process parser requires exact canonical bytes;
pretty-printed fixture inputs must be canonicalized explicitly before simulating transport.

The new byte codec supports well-formed Unicode and non-negative safe integers through `9_007_199_254_740_991`,
rejecting floats, negative zero, unsafe numbers, lone surrogates, accessors, sparse arrays, non-JSON objects, and
cyclic/shared object references in object inputs. It sorts UTF-16 keys directly. Existing `canonicalJson` uses
JavaScript object enumeration, which reorders integer-looking keys; the new codec avoids that issue without altering
historical contract hashes. The closed executor and GAAP schemas have fixed nonnumeric keys; golden tests prove
agreement on that accepted domain.

Messages are limited to 16 MiB plus one framing LF, 64 nesting levels, and 1,000,000 JSON values using #106's
development bounds. Arrays must use the ordinary array prototype; proxies and custom, subclass, or null array prototypes
are refused before inherited methods can run. Values are checked before recursive schema cloning and canonicalization.
These are development input limits, not runtime scheduling or retention policies. Raw artifacts/tool output remain
outside the receipt as digest references.

## Admission, failure, and recovery

The future trusted verifier must authenticate provenance and signer policy, verify actual referenced artifact bytes,
exact subject/effect scope, approvals, independent verification, capability/policy identities, and outcome/effect
claims. It must then recheck current Workflow Run, graph, state, Action Request, claim generation/expiry, Attempt,
executor, subject freshness, and authority before creating #106's bound `ReceiptAdmission`. Every received report is
untrusted, including a failed report claiming no effect. Hash consistency cannot issue an admission.

After admission, #106 applies its existing receipt identity/conflict/fencing rules. Separately normalized accepted guard
evidence and #105 controller evaluation remain necessary before any lifecycle transition. No mapper returns a controller
decision, accepted guard receipt, admission record, next action, or Workflow Run completion.

| Failure                                            | What remains unchanged                        | Caller or operator recovery                                                                 |
| -------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Malformed/unknown protocol, receipt, type, or hash | Journal, claims, Attempts, accepted evidence  | Correct producer/input; retain diagnostic and original bounded bytes.                       |
| Missing or mismatched mapping                      | Request and authority                         | Supply exact approved mappings; do not weaken requested evidence.                           |
| Ask or denied effect                               | Lifecycle and outer authority                 | Obtain authority or reconcile; no automatic retry.                                          |
| Failure, interruption, timeout, missing output     | No new trusted effect knowledge               | Follow #106 independent recovery before retrying effects.                                   |
| Missing admission or forged acceptance data        | Running Attempt remains unadmitted            | Verify evidence; preserve rejected identity; use #106 fresh-report recovery when permitted. |
| Expired/replaced claim or stale subject            | No lifecycle advancement or authority renewal | Refresh trustworthy observations or reconcile against current authority.                    |
| Same receipt identity with changed content         | No overwrite                                  | Preserve both digests and follow #106 conflict resolution.                                  |

These functions return diagnostics without writing evidence. The future runtime must retain original bytes/digests,
verification results, and transport diagnostics before deciding recovery; logging or process exit must not substitute
for durable admission. Receipt verification and import belong to
[#111](https://github.com/nnennandukwe/threadloop/issues/111). The DSSE/in-toto predicate belongs to
[GAAP #15](https://github.com/nnennandukwe/governed-agent-autonomy-patterns/issues/15). No placeholder signing predicate
or trust bypass is introduced while those contracts remain unfinished.

## Examples, verification, and proof limits

[The shared local-gates fixture](fixtures/local-gates.json) carries an exact request, mapping policy, started journal,
and independent snapshot. [Golden digests](fixtures/golden-digests.json) and `.canonical` request files were
independently authored using Python sorted-key JSON and SHA-256 over the fixed-key schema domain; tests do not rewrite
them. Receipt inputs were adapted from the pinned GAAP examples with matching request/run/subject bindings. The
successful local-gates example is read-only; its derived ledger removes mutation events. All artifacts and actors are
synthetic.

| Example                                                                                     | Expected behavior                                                                                                |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [Completed](fixtures/completed.json)                                                        | Consistent read-only success candidate, no admission                                                             |
| [Authority required](fixtures/blocked.json)                                                 | Ask evidence retained; blocked one-shot result                                                                   |
| [Denied effect](fixtures/denied-effect.json)                                                | Block remains distinct from failure                                                                              |
| [Interrupted](fixtures/interrupted.json)                                                    | Interruption evidence retained; effect remains unknown                                                           |
| [Failed](fixtures/failed.json)                                                              | Failure remains distinct from malformed output                                                                   |
| [Budget exhausted](fixtures/budget-exhausted.json)                                          | Blocked with explicit resource reason                                                                            |
| [Stale verification](fixtures/stale-verification.json)                                      | Retained blocked evidence cannot become successful verification                                                  |
| [Stale subject](fixtures/stale-subject.json) / [expired claim](fixtures/expired-claim.json) | Corpus tests reuse each result with changed current subject or expiry time; preflight/admission refuses progress |

`executor-admission.test.ts` also changes every binding with recomputed hashes and verifies lease renewal, independent
parameter approval, and untrusted history rejection. `executor-corpus.test.ts` proves mapped reports alone fail receipt
admission and only separately supplied synthetic trusted admissions can close an Attempt. It checks exact upstream
checksums, published schema parity, Unicode key order, and resealed semantic failures. Existing #106 tests continue to
own replacement, duplicate receipt, changed identity, cancellation, and recovery behavior.
`executor-review-regressions.test.ts` covers optional evidence locators, schema uniqueness and executor-only actors,
terminal cause consistency, event ordering, one-shot resume refusal, and no-effect/occurred-effect summaries.

```bash
npm run spec:executor:schemas
npm test -- tests/unit/executor-codec.test.ts tests/unit/executor-contract.test.ts tests/unit/executor-admission.test.ts tests/unit/executor-corpus.test.ts tests/unit/gaap-mapping.test.ts tests/unit/executor-review-regressions.test.ts
npm run check
npm run security:dependencies
```

The generator updates only published executor schemas. Tests validate pinned schemas offline and never regenerate
expectations. [Upstream provenance](upstream/gaap/provenance.json) records exact files and commit
`712875cbf4be6dd02093f50f93ae826f20cb4890`. At that source revision GAAP has an accepted Agent Run contract and a
Rust-only bounded engine; it does not implement this complete process interface, signing, or ThreadLoop integration. The
current GAAP release must not be described as a working runtime side of this interface.

These checks prove specification consistency and refusal behavior in development tooling. They do not prove process
isolation, live provider behavior, authenticated observations, crash durability, cross-process interoperability, or
exactly-once execution. #108 owns external conformance; #111 owns the later current-TypeScript runtime integration.
Existing CLI, SQLite v8, packaged runtime, runner, and graph/controller/execution golden artifacts remain unchanged.

## Issue #107 acceptance coverage

| Acceptance criterion                                                   | Contract section                                                                    | Evidence                                                                                      |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Versioned canonical JSON process boundary                              | [Process exchange](#one-shot-process-protocol)                                      | `executor-codec.test.ts`, request golden bytes                                                |
| Provider-neutral ThreadLoop interface                                  | [Published interface](#published-interface)                                         | Strict executor schemas and `executor-contract.test.ts`                                       |
| No ThreadLoop lifecycle vocabulary in GAAP core                        | [GAAP request mapping](#gaap-mapping-policy-and-request)                            | `gaap-mapping.test.ts` checks explicit mapped fields against the pinned schema                |
| One Attempt maps to one Agent Run                                      | [GAAP request mapping](#gaap-mapping-policy-and-request)                            | Stable redelivery and replacement identity tests                                              |
| Completion remains evidence subject to independent admission           | [Trust and admission](#admission-failure-and-recovery)                              | `executor-admission.test.ts` and synthetic admission composition in `executor-corpus.test.ts` |
| Blocked, failed, interrupted, and malformed stay distinct              | [Results and one-shot authority handling](#results-and-one-shot-authority-handling) | Outcome corpus and malformed-frame tests                                                      |
| Unknown versions, capabilities, receipt types, and digests fail closed | [Published interface](#published-interface)                                         | Strict-shape, unsupported-mapping, and digest-tampering tests                                 |
| Independent release lifecycles without a shared Rust crate             | [Examples and proof limits](#examples-verification-and-proof-limits)                | Checksummed offline JSON snapshots; unchanged dependencies and runtime source                 |
| All six required examples                                              | [Examples and proof limits](#examples-verification-and-proof-limits)                | Completed, authority, denied-effect, interruption, stale-subject, and expired-claim fixtures  |
| Complete GAAP runtime integration remains unimplemented                | [Examples and proof limits](#examples-verification-and-proof-limits)                | Explicit pinned-release and #111 boundary statement; no live interoperability claim           |
