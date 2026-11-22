# Execute Selected Engineering Actions Through GAAP Build Plan

## Summary

ThreadLoop needs to execute one engineering action from a stored Workflow Run and decide what the run can do after the
executor returns. This Software Build Plan connects the production selector and run store to the existing GAAP bridge.
ThreadLoop will own the outer state and transition. The bridge will own each claim, Attempt, process observation and
authenticated admission. This is one PR for delivery 4.
[Issue #171](https://github.com/nnennandukwe/threadloop/issues/171) ·
[Runtime tracker #168](https://github.com/nnennandukwe/threadloop/issues/168) ·
[Authority ADR](https://github.com/nnennandukwe/threadloop/blob/7c54c2bb8055f00736e3b5f6631e9aecbe0fd212/docs/adr/0001-sdlc-graph-authority-model.md)

The pushed base for this unit is `bdf68cc2d3ad915d085aecff47c9181f65fb5205`, the merge of #176. Its tree
`17124dd8949059d40c25807e297659817f2c5b11` matches reviewed head `31388a07566350dfeddc30578d43b8926d5b4e22`. Main CI and
Security both passed on this merge. The bridge service and child store have Git blob IDs
`74d12006fc7263bb34c1107aad3600d079ba61e1` and `8b5041dab6fde46c256e98cfe356e13ba68b9529`.
[Unit 3 delivery](https://github.com/nnennandukwe/threadloop/pull/176) ·
[Main CI](https://github.com/nnennandukwe/threadloop/actions/runs/44961637392) ·
[Main security](https://github.com/nnennandukwe/threadloop/actions/runs/44961637374)

On the actual predecessor CLI, the governed profile moved from queued through framed/v1 and proof_ready/v2 to
implementing/v3. Its decision was blocked with `UNSUPPORTED_CAPABILITY`. The proposed execute operation returned an
unknown-command error, and creating a setup/2 run returned `WORKFLOW_RUNTIME_UNSUPPORTED`. An independent SQLite reader
observed four unchanged events and data version 2. No child database existed. The older standalone native proof uses a
synthesized implementing/v2 input. Keep both controls in the verification record.

## Skills To Use

| Stage                 | Skills                                                               | Responsibility and evidence                                                                                                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts             | qodo-get-rules, qodo-codebase-wisdom                                 | Apply the program’s retrieved rules for changes to shared schemas, enum consumers, configuration and named parameters. Trace the selector, run store, signed imports and executor entry points at the unit base. Refresh evidence when the base changes their behavior. |
| Storage and authority | transaction-proof, sqlite-concurrency-hardening, workflow-invariants | Check ownership and lock order at each commit below. Exercise stale and concurrent callers through independent connections and record what both inspectors see after restart.                                                                                           |
| Implementation        | tdd, failure-path-testing                                            | Drive each slice with a failing public behavior. Exercise the actual subprocess boundary and assert the blocked state, retained evidence and recovery guidance.                                                                                                         |
| Operator interface    | cli-interactive-parity, voice-canon                                  | Check parser, help, text, JSON, negotiated protocol, package smoke and guides for each new operation. Run the language verifier on authored copy.                                                                                                                       |
| Review and delivery   | qodo-review, qodo-review-resolver                                    | Run a fast asynchronous checkpoint, full final local review and a completed structured hosted review on the actual PR head. Retain finding-level evidence and post-merge results.                                                                                       |

Qodo Local Review is eligible. The rules lookup returned 14 cross-cutting standards and 20 results for the broader
producer/consumer query. Rules 1060877 and 1060865 govern corresponding validation and exhaustive enum consumers. Rules
1060879, 1060863, 1060853, 1060851, 1060843 and 1060888 apply to changed parameters, public fields, event compatibility
and configuration. Keep existing pins under rule 1, use the existing npm scripts under 159439, and use descriptive
English under 613754, 699152, 7205 and 8184. Qodo's repository read and the checked-out source both located registration
and the existing admission ownership in `src/services/gaap-executor.ts`. The initial reliability query returned no
results. The TypeScript, Node and SQLite tests cover this stack.

## Scope

**In scope.** Adopt an explicit host configuration and capability mapping for a currently selected engineering action.
Reserve the request, bind it to one bridge, invoke the existing process path and reconcile verified child evidence with
fresh outer facts. Prove successful guarded application and refused application after real execution. Supply useful
non-launching recovery.

**Out of scope.** GAAP source changes, provider trials, changes to the frozen contract families, automatic replacement
of an uncertain Attempt, publication automation and the Rust implementation. Unit 5 owns the external controller suite,
governed completion and final parity report.
[Verification issue #172](https://github.com/nnennandukwe/threadloop/issues/172)

## Package Layout / File-to-Task Mapping

- Extend `src/services/workflow-genesis.ts` and `src/domain/workflow-run.ts` for immutable setup v2 and a run's
  execution history. Extend `src/services/workflow-evaluation.ts` to share the exact input constructor behind
  `decideWorkflow(snapshot, observed, at)`. It currently advertises human capabilities and supplies idle execution,
  empty existing requests and empty invalidated claims. Use the same input constructor for decide, execute and apply.
- Extend `src/adapters/fs/workflow-store.ts` with synchronous reserve, enroll, ownership-check and import operations.
  Its writers use `withExistingStateWrite(root, action)` and its readers use `withReadSnapshot(root, action)`. Keep the
  four event families in `workflow-schema.ts` and `workflow-journal.ts`. Add an optional execution event table and head
  for v2 runs. Reuse the existing digest, exact-replay, transaction and compare-and-swap patterns.
- Extend `src/services/workflow-runtime.ts`, `src/commands/workflow.ts`, `src/cli-program.ts` and
  `src/contracts/protocol.ts` for selected execution, non-launching recovery and capability negotiation. Keep the same
  public envelope and the default v4 protocol bytes.
- Reuse `registerGaapExecutor(store, bindingValue, hostValue, now?)`, `runGaapExecutor(store, abortSignal?)`,
  `admitGaapOutput(store, observationId)` and `inspectGaapExecutor(store)` from `src/services/gaap-executor.ts`. Extract
  the synchronous start and final admission mutations so the owning workflow can fence them. Share one authenticated
  child snapshot with the public inspector. Preserve standalone candidate evaluation and its `lifecycle_mutated: false`
  result.
- Extend `src/adapters/fs/gaap-state.ts` for new managed child state. Keep the standalone generation-1 path and existing
  exclusive file creation, root revision, transaction marker and independent commit readback.

- Reuse `src/domain/gaap-binding.ts`, `src/domain/gaap-statement.ts`, `src/adapters/fs/gaap-files.ts` and
  `src/adapters/process/gaap-runner.ts` for host validation, signed facts, subject observation and invocation. Keep
  profile text out of executable, argument and path selection.
- Extend `docs/gaap-executor.md`, `docs/cli.md`, `scripts/smoke-pack.mjs` and integration coverage. Reuse
  `src/adapters/process/gate-runner.ts` and `src/domain/proof.ts` when connecting the trusted local-proof producer
  needed by the governed slice. Use the existing `tests/fixtures/gaap-producer.ts` process and
  `tests/fixtures/gaap-native-producer.ts` behind the real bridge. A proposed
  `tests/integration/workflow-execution.test.ts` will test the composed workflow. Fixture builders and expected values
  stay out of production.

## Dependencies And Settings

Keep the existing lockfile, host-native Node engines and `threadloop-contracts` pin
`4ed9a94a2a089b9ae950d93297f7a6b9b939d3a6`. Keep outer storage generation 8 and standalone executor SQLite generation 1.
Use executor SQLite generation 2 only for newly managed children. Preserve frozen Action Request, Claim, Attempt, Result
and ReceiptAdmission identities and the standalone bridge protocol. No new dependency, service, environment variable or
signer trust default is needed.

The initialized control repository owns the outer database. The run setup explicitly adopts a separate subject Git
worktree. The bridge snapshots the entire subject except its root `.git`, with at most 64 descendants, eight levels and
8,192 bytes per file. Its process requires an existing Git commit and supports POSIX process groups. Store executor
state and evidence in a real, host-owned directory outside the subject. Validate the canonical paths, ownership and
workspace binding on restart. The control database, fixtures and generated reports stay outside that worktree.
[Bridge requirements](https://github.com/nnennandukwe/threadloop/blob/7c54c2bb8055f00736e3b5f6631e9aecbe0fd212/docs/gaap-executor.md)

## Canonical Contracts

The integrated Unit 3 CLI provides `workflow create <run-id> --profile <yaml> --setup <json>`,
`workflow inspect <run-id>`, `workflow decide <run-id>`, `workflow evidence prepare <kind>`,
`workflow evidence import <kind>`, and `workflow apply <run-id> --decision <file> --idempotency-key <key>`. Add the two
selected-execution operations below and the bounded evidence collection documented under Component Design.

```text
threadloop workflow execute <run-id> --decision <file> [--json]
threadloop workflow evidence import gaap --run <run-id> --source <correlation-file> --expected-state-version <n> [--json]
```

The earlier draft accepted `--adapter`, `--config` and `--state` at execute time. Adopt the adapter and configuration at
create instead. The control store allocates the private child location. This gives the run an immutable executable and
mapping enrollment before selection can advertise the capability.

The first command accepts a saved `workflow decide --json` response as an expectation. The service will reconstruct the
decision from authoritative run facts and an explicit current evaluation time. Use #170’s freshness comparison so clock
movement alone doesn’t create a new request. Match the selected request envelope, eligible capability, run, state
version, subject, evidence and authority. Only `engineering_action_required` with an explicitly available capability may
dispatch. For `human_action_required`, return the existing human handoff. A transition, terminal, waiting or blocked
outcome can’t enter the bridge.

Add `threadloop.workflow-setup/2` for new runs that opt into execution. Retain the setup/1 fields and add a required
`gaap` object with an `adapter` path and a `host` path. For example, use
`"gaap": {"adapter": "./adapter.json", "host": "./host.json"}`. Resolve both paths against the setup file and read
bounded files during creation. Store validated canonical bytes and their digests in the adopted genesis and original
create request. Keep the working subject, private control data and host binaries in separate locations. Validate the
exact executable, arguments, environment, workspace, limits, executor incarnation, mapping and producer identity. Keep
executable arguments and environment values out of public views.

The strict adapter document declares an execution policy ID, retry safety, maximum Attempts, exact mapping policy,
executor parameters, executor ID/incarnation and claim duration. It accepts no controller snapshot, selected action,
claim, Attempt or admitted receipts. Derive the execution policy's request and Workflow policy references from the
freshly selected envelope. Compute the canonical rule digest and call the frozen validators. Enroll the exact
`gaapVerificationPolicy(host)` in the run's evidence policies. That function covers verification keys and the
implementation identity. Bind the full host configuration separately. Validate the workspace locator, mapped scope,
resource limits and approval context before registration. A later edit to a referenced file can't change an existing
run's enrollment.

The closed adapter file uses `schema_version: threadloop.workflow-gaap-adapter/1`. It supplies `mapping_policy`,
`parameters`, `executor` and `lease_ms` from the existing bridge binding plus an `execution_policy` template with `id`,
`retry_safety` and `max_attempts`. It can't provide a snapshot, preselected request, claim or Attempt. At execution,
derive the original request reference and workflow policy from the selected envelope and hash the resulting execution
rules. Check the mapping digest, capability, policies, subject locator and parameter types before advertising the
adapter. Bind a stable executable identity and check its bytes at dispatch. Keep host environment values out of public
replies. Optional independent review collection uses the setup/2 field `review_reader`, with provider `qodo`, an
absolute executable, immutable base commit and reviewer ID. Adopt its executable digest. Bind the content of executable
and script arguments whose absolute paths select files, and verify them before dispatch. Omit that source when
unavailable.

The selector from #169 binds the selected intent with the public `buildActionRequest` function. Follow its validated
`action_request` from the decision and revalidate it in the current snapshot. The bridge’s envelope uses that exact
action request, the new host-adopted claim and Attempt, executor identity, mapping and explicit parameters. The logical
idempotency key and the full request digest have different roles. A changed payload under the same logical key
conflicts. The executor envelope’s digest includes its claim and Attempt and remains separate from the controller
request digest.
[Controller API](https://github.com/nnennandukwe/threadloop-contracts/blob/4ed9a94a2a089b9ae950d93297f7a6b9b939d3a6/src/public/controller.ts)
·
[Executor mapping and admission](https://github.com/nnennandukwe/threadloop-contracts/blob/v0.1.0/docs/contracts/executor-v0.1/README.md)

The import takes a bounded correlation document from the execute result or outer inspector. Its fields are the run ID,
request key and digest, expected enrolled executor request and Attempt IDs, and, when present, the observation ID. All
fields serve as expectations. It locates the child through the existing reservation. It can retry admission of the exact
retained successful transport after checking current authority, independently verify an existing admission, or report
uncertainty. Reject an alternative directory, replacement request, mismatched observation or caller-supplied executor
output. It never starts a process. Both operations return the repository’s normal text or JSON envelopes. Success
identifies the outer run/state/version, logical request key/digest, executor request digest, claim generation and
Attempt where available, observation/source/admission identities where present, execution disposition and next permitted
operation. A refusal identifies its phase, reason, retained identities and safe recovery command. Keep command arguments
containing authority or private environment data out of public evidence. Add these capabilities only in the negotiated
v5 workflow view, advertised by `workflow_gaap_execution_v1`. Preserve the default v4 command inventory and its reviewed
runner.

## TDD And BDD Implementation Strategy

1. Create a governed run through the actual CLI. Apply `frame`, `bind_plan` and `begin_implementation`. At
   implementing/v3, save the production engineering decision. Interrupt the first slice just after enrollment, reopen
   both inspectors, and expect one pending child with the exact selected request and zero launches. Record the
   predecessor's actual refusal before implementing this slice. Also check human or unmapped work leaves zero launches.
2. Drive concurrent reserve and enroll requests from separate CLI processes. Prove one reservation and pending Attempt.
   Reject a changed saved request under the existing identity. Show a v1 run stays usable alongside the v2 run. Run the
   built #170 executable against the v2 run and the prior standalone executable against its pending child.
3. Run the bounded process fixture. Verify the original signed evidence and resulting physical subject through the child
   inspector. Import the execution fact through the outer command, reopen both stores and verify the unchanged lifecycle
   version. Exercise interruption and expiry around each commit in the matrix below.
4. Record an explicit eligible transition after current guard evidence arrives. Refuse stale, missing or unrelated
   evidence and demonstrate the same-head human handoff. Run native allow and bad-patch cases using the selected
   request. A changed workspace still needs its same-subject proof and scoped commit. Unknown effects still require
   reconciliation.
5. Exercise help, text/JSON envelopes and the packaged CLI for success, conflict, lost reporting and refusal. Retain
   exact request, claim, Attempt, source/admission, execution head and lifecycle event identities with the reviewed SHA.

## Component Design

### Run ownership and journal replay

Create a separate execution journal and head for a v2 run under outer storage generation 8. Every execution event binds
its previous execution digest and current lifecycle ordinal/digest. Every v2 lifecycle apply retains the exact execution
head used in its decision and CAS. Reconstruct historical decisions at that prefix as part of ordinary journal
verification. Validate that both chains belong to this run, order their references and reject missing, rewound or
conflicting prefixes. Keep lifecycle version, evidence revision and execution revision separately visible. The legacy
lifecycle table's four semantic kinds remain `create`, `prepare`, `admit` and `apply`.

Attach any new indexes, immutability triggers and one-outstanding-reservation constraint to the new execution tables. A
unique run and request key binds the original request bytes, graph/schema/state/version, subject, policy, authority,
evidence revision, enrolled host/adapter and the host-generated child location. The reservation holds progression until
its outstanding effect is accounted for. Exact redelivery looks up its existing reservation before checking whether an
old decision is still fresh. A fresh operation must match the current run and execution heads.

A reservation with no child has no claim or Attempt to report. Its inspector identifies the unlaunched reservation and
the exact execute request that can resume registration. Refuse a lifecycle application while that reservation holds the
run. After enrollment use the verified claim and Attempt for the frozen waiting or reconciliation projections. Keep
completed request references after verified child admission and outer import, even when the admitted effect changed the
physical subject. The historical journal keeps the original subject. A new decision observes the successor.

Require a v2 setup before any reservation. The #170 loader reports `WORKFLOW_RUNTIME_UNSUPPORTED` when it reaches a
later stored setup version. Its argument parser can refuse a v2 decision envelope earlier with
`INVALID_ARGUMENT/invalid_decision`. Its reader can still inspect and apply v1 runs in the same database. A side table
on a v1 run wouldn't fence the old reader. Keep the protocol capability as discovery and use the persisted run version
to enforce this boundary.

### Child enrollment and writes

The child registry grants the claim and Attempt IDs. Persist their identities and executor envelope digest in an outer
enrollment record before a process can start. Child registration must persist its immutable managed owner/reservation in
the same child commit. Each authorization-changing write goes through a short synchronous check guarded by the outer
run’s current reservation and evidence/authority fence. Follow one lock order when both databases participate, outer
first and child second, with short transactions and independent commits. Release locks before executing a process or
awaiting signature, file or network work. Split the existing bridge at its synchronous dispatch/admission mutation if
needed. All access paths, including standalone `executor run` and `executor admit` pointed at managed state, must either
check the same owner fence or direct the caller to its owning workflow. The old standalone path continues to work with
standalone state. Test that the old initialization and command entry points can’t detach an existing managed child.

New managed children use `PRAGMA user_version=2` and a managed root version with the exact immutable owner run,
reservation ID and request digest. Write these in the child registration commit. The prior standalone bridge's
`GaapState.open` accepts only version 1. An extra owner key in an otherwise state-1 root would allow that older binary
to dispatch. Current standalone writers must also refuse a managed root and identify its owning workflow.

`GaapState.mutate` increments the persisted revision after running its callback. Read back the committed child
generation for enrollment and import. The root clone made inside the existing dispatch callback carries the previous
revision. A managed child can begin only after outer enrollment verifies its exact request, claim and pending Attempt.

### Commit points

| Commit   | Owner and visible state                                                                                                                                                                                        | Restart rule                                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Reserve  | Outer `COMMIT` records the selected request, expected heads and generated child location. The lifecycle version stays fixed.                                                                                   | An exact execute retry can register a missing child only while the reservation has never been enrolled.                                  |
| Register | Child `GaapState.initialize` exclusively creates and commits version 2, owner, reservation, root, claim, pending Attempt and executor request.                                                                 | Read back and verify the existing child after a lost reply. Preserve a conflicting or unreadable file.                                   |
| Enroll   | Outer `COMMIT` adds the verified child owner, actual claim/Attempt, executor request digest and registration revision.                                                                                         | Resume the enrolled pending Attempt through explicit execute after a fresh authority check. A missing or replaced enrolled child blocks. |
| Start    | Under the outer writer fence, the child commits the started journal and unique launch row before the invocation. Both locks release before process work.                                                       | Every possible launch consumes that Attempt. Lost start acknowledgment, expired lease or an empty output directory requires inspection.  |
| Observe  | Child `COMMIT` adds transport status, raw output, original envelope and the host-owned launch locator.                                                                                                         | An observed successful transport can retry verification without starting a process. A committed start with no observation remains held.  |
| Admit    | Under the outer fence, the child commits the independently authenticated result, admission, original signed bytes, required blobs and journal receipt.                                                         | A caller uses the verified child readback after a lost admission or candidate-evaluation reply. No outer application has occurred.       |
| Import   | Outer `COMMIT` records the verified admission/source identities, claim, Attempt, request, effect status, resulting subject and child revision.                                                                 | Replay import by its retained identity. Reject a conflicting digest. An already imported receipt can't charge a second Attempt.          |
| Apply    | The ordinary outer apply transaction checks its submitted proposal against fresh graph, authority, both journal heads and physical subject. It commits an eligible edge, version, event and original response. | Reopen the outer inspector or retry the exact apply key and proposal to recover a lost reply.                                            |

A child root freezes registration-time facts. Its `nowSnapshot` updates only evaluation time. At launch, recheck the
selected request against current outer authority, subject and deadlines. At child submission, validate the original
claim and producer binding, current outer authority and independently measured resulting subject. Frozen
`currentObservation` requires the request binding and observation to identify the same subject. Preserve the original
pre-effect context used for the child and the live physical observation used for outer evaluation. A signed successful
result can have changed bytes at the same Git commit. Changing the Git commit during this Attempt fails the bridge's
current `physicalSubject` check.

Refactor the inspector's verification into one child snapshot. Check the journal, expected mapped request, original DSSE
payload and every referenced blob. Recompute the result. Compare verified resulting-subject digest, repository and
revision with its original binding. Verify the launch row's request digest/Attempt, retained observation's ID, metadata
and stdout/envelope, accepted admission and exact journal receipt from that same generation. Return those verified facts
internally and keep the concise public inspector. If admission already committed, this database readback works after the
output directory disappeared or the physical checkout advanced. The existing `admitGaapOutput` reads live output blobs
and current workspace before its duplicate check. Use it for a retained successful transport whose admission still needs
verification. The existing `evaluateGaapController` writes candidate-evaluation history. Only the fresh outer selector
can authorize a lifecycle apply.

The standalone registration function requires an idle snapshot with no retained requests or invalidated claims. For a
second selected request on a managed run, preserve the previous request identities and invalidations. Check the fresh
selection and uniqueness of the new request against those facts. Preserve the standalone registration precondition for
generation 1. Test a subsequent legitimate request, an exact redelivery and a conflict under the original identity. The
frozen execution projection already combines new entries with the input's retained lists.

The frozen execution projection contributes `execution`, `invalidated_claims` and `existing_requests`. It can’t issue an
independent proof, review, approval or merge receipt. A satisfied engineering action may produce a verified successor
subject. Keep its original subject and accepted receipt in history, and re-observe the physical subject before making
the next selection. An unresolved effect retains its original binding and exposes the separate current observation. Map
a guard receipt only through a #170 verifier explicitly authorized for that family and subject. Retain the verified
admission digest and its exact source even when no guard gains evidence. Account for a child Attempt once by its
claim/Attempt identity. The governed graph's `repair_entries` counts its listed lifecycle transitions through
`nextWorkflowHistory`. Executing or re-importing a request doesn't consume another repair entry.

Keep selected execution and independent evidence collection explicit. Every engineering dispatch from `workflow execute`
must use a mapped, enrolled GAAP adapter, the original claim and a bounded Attempt. The initial native adapter supplies
`implement_change`. A trusted source for a review or gate can attest to an observation independently of which
engineering capabilities are available. Enrolling a source alone doesn't make it an execution adapter. The command must
never route a selected request around its claim or admit a graph fact solely because a child returned success.

Expose a bounded producer operation when the operator needs local proof or pre-PR review:
`workflow evidence collect local-gate --run <run> --gate <id> --expected-state-version <n> --idempotency-key <key>`, or
`workflow evidence collect pre-pr-review --run <run> --operation <id> --expected-state-version <n> --idempotency-key <key>`.
Run only the immutable proof plan's declared gate/setup in the enrolled subject. Capture the actual before/after
subject, outcome, artifacts and output digests. Capture an attempt before starting any process and hold uncertain
effects for readback. For review, collect the retained result of an explicitly requested assessment through the enrolled
managed Qodo status reader. Never start a second review on collection or retry. Bind the configured repository, base,
exact head and tree to the service's result and physical checkout. Require the intended full pass and complete coverage.
Include new and previously open findings. Unavailable, unrelated, unsigned local JSON or incomplete evidence can't
satisfy the guard. Keep review credentials outside the subject and stored source. The live fixture's one fresh
assessment and its cost ceiling belong to #172's pending decision.

Route both observed results through Unit 3's `admitWorkflowHostSource(cwd, run, version, source)` and
`projectWorkflowHostSource(source, genesis)`. Keep the raw producer output and original observation with its enrolled
policy, subject, source ID and observation time. A digest supplied by the caller can't authenticate the producer.
Independent signed CI and PR review still use the existing prepared sensor/import operations. A fresh outer decision and
explicit apply are required after admission.
[Execution projection](https://github.com/nnennandukwe/threadloop-contracts/blob/v0.1.0/docs/contracts/execution-v0.1/README.md#controller-projection-and-compatibility)

## Failure And Recovery Rules

Use `workflow inspect` and the verified `executor inspect` from independent processes. Record the outer lifecycle
version, execution head, selected request digest, child Attempt status, launch count, observation/source/admission
identities and the reopened result or refusal reason. Run the fault with the prepared writer and verify after it exits.

| Fault or race                                                                                                                 | Observable result                                                                                                                                                                                                    | Safe next operation                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Newer setup beside a v1 run                                                                                                   | The built #170 CLI can use the v1 run. Old operations refuse the v2 run. Its closed argument parser can reject v2 decision fields before the stored setup check. Both database heads retain their prior values.      | Open the v2 run with the version advertising `workflow_gaap_execution_v1`.                                         |
| Prior standalone binary or an unowned new standalone writer targets a pending managed child                                   | The old binary rejects child SQLite version 2. The new standalone writer reports the owning run. Inspection finds zero launches and the original enrolled claim. Existing standalone generation-1 state still works. | Use the owning workflow command.                                                                                   |
| Stale decision, different request bytes, changed config, unmapped work, human handoff or expired authority before reservation | Both inspectors show no new reservation or child launch. The response identifies the stale binding or required human action.                                                                                         | Decide again or present the handoff.                                                                               |
| Race to reserve or enroll, crash before/after registration, child directory collision                                         | Exactly one original reservation and at most one matching pending child. Only committed enrollment authorizes a launch. A collision preserves unowned files.                                                         | Inspect, verify the owned child, then finish exact enrollment.                                                     |
| Child disappears, changes owner or changes revision between verified read and child mutation                                  | Current outer ownership and child CAS checks refuse the write. An enrolled child is never recreated.                                                                                                                 | Restore the bound child or report the missing state for reconciliation.                                            |
| Crash before/after start commit, including before the actual spawn                                                            | Before the child commit, inspectors show the enrolled pending Attempt and zero launches. After it, they show one committed start, with zero or one independently counted invocations.                                | Explicit execute may resume a still-pending Attempt. A started Attempt permits inspection and reconciliation only. |
| Timeout, signal, changed workspace, malformed output or failed observation commit                                             | The child retains its started Attempt, any committed transport, and the owned output directory. Compare the physically observed subject with the original.                                                           | Hold possible effects. A missing reply can't authorize another invocation.                                         |
| Authority, evidence, lease, budget or active reservation changes during verification                                          | Outer fence and child CAS prevent stale admission or dispatch. A prior effect and any retained observation remain visible.                                                                                           | Reevaluate current authority. Only an eligible observed transport can retry admission.                             |
| Wrong signer, changed signed bytes, missing blob or mismatched observation/launch/result                                      | Child verification or managed correlation fails. The last valid admission and outer state remain intact.                                                                                                             | Inspect the exact reservation and restore independently verified evidence.                                         |
| Kill after child admission, remove the original output directory, then lose the outer import reply                            | Child inspection authenticates its retained envelope and blobs. Exact outer import returns the recorded response on replay. Launch count remains one and lifecycle version stays fixed.                              | Retry the exact import or inspect both stores.                                                                     |
| Replace, truncate or rewind an execution prefix used by a v2 apply                                                            | Reopened journal verification rejects the inconsistent history. A proposal from the earlier execution head can't apply at a later head.                                                                              | Restore trusted retained events and regenerate the decision.                                                       |
| Allowed native edit with missing outer proof, or admitted bad-patch with an unknown effect                                    | Original selected action and signed child result remain inspectable. The current selector identifies the unmet guard or reconciliation requirement. Apply leaves the prior version.                                  | Supply eligible independent proof, a scoped commit or an authorized recovery disposition.                          |
| Kill after outer apply commit or race two applies                                                                             | Inspect shows one applied edge and one lifecycle version increase. The exact apply key returns the stored result. A changed proposal conflicts.                                                                      | Recover through the recorded key and head before deciding again.                                                   |

Use deterministic failpoints around short transactions and a process-level kill at the dispatch, evidence and reply
boundaries. Test fresh connections and simultaneous independent CLI processes. Verify cleanup of test-owned resources,
preservation of unowned paths and retention of committed or uncertain directories. Reopening a corrupted or missing
enrolled store must never initialize it in place. Add the exact observed commit points, failures, commands, revisions,
warnings and unproved guarantees to the unit evidence.

### Interrupted local gate collection

Hosted review 2090594 on PR #177 identified two failures at `202943c`. Killing the CLI after the intent committed left
zero gate invocations, yet the next delivery refused to collect. Killing it after result capture found that the CLI had
already published `execution.json`. The following commit points govern recovery for new local gate collections.

1. The workflow database writes the intent with `launch_protocol: 1` and its unclaimed launch row in one immediate
   transaction. The row binds the run, key, intent digest and attempt. A retry can take this reservation. A separate
   immediate transaction checks current version and subject authority and lets one owner change the claim from zero to
   one before setup or invocation. Database guards prevent replacement, deletion, rewind and a second claim. A preflight
   refusal can close an unclaimed attempt only while the same transaction still owns that check.
2. Inspection identifies the run, key, attempt and either the reservation or committed launch claim. A missing row for a
   marked intent is damaged storage. An older bare intent has unknown launch status. After a claim commits, either the
   original process or a retry can lose its response. Until a verified result commits, attempts on that run stay held
   for independent reconciliation. The original claim can cover zero or one physical invocation. A loose output file
   can't authorize a retry.
3. The owning producer commits the complete verified source to SQLite before publishing its execution report. Repeating
   the original collection after that commit admits the recorded result even if the output directory has disappeared.
   The outer receipt and terminal collection reply have separate idempotent writes. A stale subject or expired authority
   can close the captured attempt with a refusal. A reporting error after capture directs the operator to repeat the
   original collection.
4. Tests kill separate CLI processes after reservation, after a real counted effect and after result capture. Concurrent
   clients compete for one reservation. Independent readers check the persisted claim and count, old intent handling,
   damaged rows, and recovery with the output directory gone. Existing collection phases and ordinals retain their
   stored meaning.

The same review found that enrollment trusted file contents without verifying who could change them. Enrollment and
dispatch must validate the resolved host executable and each retained file against the existing host ownership and write
permission checks. Tests exercise permission changes between enrollment and dispatch and verify the native host still
runs with its original inputs.

### Restore the captured report and retry a pending review

Local review on `3e0e5a7` identified two operator-visible failures. An exact retry admitted a captured gate after a
report write error yet left its report missing. A successful status read reporting an unfinished Qodo operation
permanently failed its collection key.

SQLite owns the verified execution report and all referenced gate output. Both the first collection and a retry restore
the files before outer admission. Recreate missing directories beneath the owned control directory, validate every
existing file against captured bytes, and publish outputs before the execution report. Write a private temporary
sibling, finish its bytes and publish it without replacing an existing name. When another client publishes first, verify
its file. Partial recovery can leave complete files for the next retry. A conflicting file stays available for
investigation. Inspection must identify the run, attempt and key. A completed retry must never run the gate again to
rebuild the report.

Tests inject a report write or publication error, remove the loose directory, then recover the exact report and log
bytes using competing CLI processes. A conflicting file or link must retain the captured database source and the
original external count. The producer can complete a previously pending Qodo operation under the same key. Test the
working and partial status responses, a completed review with a skipped conversion pass when it had no eligible
findings, and a completed review of the wrong head. Only the completed, matching review can supply evidence.

### Expire an overdue managed claim

Local review at `3e0e5a7` identified a successful transport observation that arrived before admission but whose claim
had expired by the next import. The CLI recommended repeating an import that the authority check would always refuse.
The child retained one launch and zero admissions at outer version three. The frozen execution contract gives ThreadLoop
authority to record claim expiry.

Use `threadloop workflow expire-claim <run> --attempt <id> --expected-state-version <n> [--json]`. Inspect the retained
owner, child and current outer version under the existing outer writer. Check the exact Attempt, bound policy actor,
host clock and deadline. Apply the frozen `expire` operation against the child's current revision and digest. The child
commits the expired claim first. Then the outer observation records the verified projection in its own transaction. Keep
the original transport result, operation identity and physical invocation count. A retry after the child commit must
recover the same expiry without a new launch.

An admitted result can still be imported after its lease ends. A late, unadmitted successful process result can't
authorize progression. When an Attempt started, expiry retains its uncertain effect for independent reconciliation and
human disposition. If the Attempt never started, report the frozen interrupted state and applicable retry policy and
budget. Inspection identifies the actual recovery operation for the retained Attempt.

Test an early request, a wrong Attempt, a stale outer version, pending and started Attempts, an already admitted result,
exact replay and response loss between the two commits. Verify the actual child claim, its Attempt, the counted external
effects, outer state and absence of a late admission. Expose the command in the negotiated v5 CLI, protocol and
installed-package checks.

### Protect managed launch and preserve late process output

Hosted review 2091155 examined `529816159462538a3a869872ff154d338ed26cd6`. Its four findings concern managed launch
configuration, a child result that arrives during expiry, and publication of captured gate files.
[Reviewed PR](https://github.com/nnennandukwe/threadloop/pull/177)

A separate CLI process expired the claim immediately before the observation transaction on the reviewed package. A fresh
reader found one launch, the expired claim, zero observation rows and zero admissions at implementing/v3. The test
producer had returned a 6,642-byte envelope. The control run recorded eight syncs of staging files and zero syncs of
published files or directories. Its original collector admitted the gate when the test armed a sync failure for the
existing stdout log.

**Launch authority.** At adoption and before dispatch, require a measured native executable for the supported host OS.
An operator can run a script by enrolling its native interpreter and giving it an absolute measured script argument.
Accept uppercase producer inputs in the `GAAP_`, `PRODUCER_` and existing fixture `TEST_GAAP_` namespaces, or an empty
environment. The producer receives scalar and structured data literally. Measure explicitly named absolute files and
recheck their identity before launch. A producer directory input ending in `_DIRECTORY` must identify an existing
protected directory outside the subject. Keep loader and interpreter startup settings and process search paths outside
that input set. Validate using inert configuration examples. Reject an unsupported configuration before a physical
launch and identify the configuration the operator can use. Exercise the supported native producer, the signed test
producer, an unsupported script entry and a stored configuration that no longer qualifies for launch. Historical
inspection reads the original binding. The standalone GAAP bridge and the separately enrolled Qodo status reader keep
their existing contracts. The enrolled producer owns the dependencies it loads internally.

**Ownership and commit.** A committed child launch owns the diagnostic bytes returned by that invocation. The child
writer acquires its immediate SQLite transaction before loading the current root. Verify the managed owner, original
launch, Action Request, Attempt, output directory and available observation slot. Commit the bounded response,
observation digest, current root revision increment and generation token together. Preserve the execution journal and
authority facts already committed by expiry. Claim, start, expiry, admission and outer application each keep their own
freshness checks. A late diagnostic observation supplies no authority to admit a receipt or run the producer again.

| Fault or ordering                                                                            | Evidence from an independent reader                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expiry commits between the producer's return and observation persistence                     | The reopened child retains the expiry and the original stdout, stderr and available envelope. A late admission refuses. The outer run stays held and the invocation count stays at one.                          |
| Observation commits first, or observation reporting fails after commit                       | The original observation stays bound to the one launch. Reopening identifies the committed result. Admission still checks the current claim and subject.                                                         |
| An observation write fails before commit, or has a mismatched owner, launch or occupied slot | The retained root and any existing observation stay intact. A process that stops before the commit can lose its volatile output. Recovery inspects the retained launch and never reexecutes an uncertain effect. |

**Gate file publication.** SQLite capture commits the verified source before any loose report is required for admission.
Materialization verifies all existing bytes and publishes a missing file through an exclusive link from its finished
staging file. Sync matching regular files, including producer-created logs. Sync the owned attempt directory and its
containing directories through the control root before reporting successful materialization. Apply the same checks when
an exact retry finds every name already present. A sync error identifies the captured run, Attempt and key. A
conflicting file stays available for inspection. Recovery can retry the original request after checking its result.

Trace successful file and directory syncs through the CLI. Inject file, leaf-directory and ancestor-directory sync
failures before admission, and a restoration failure on completed replay. Reopen the database after each cut. Verify the
captured bytes, original response when admission has committed, restored report and log hashes, and one physical
invocation. Record injected faults separately from any observed power interruption.

## Commit Plan

1. Commit this plan at the verified predecessor and add the bounded selected-action reservation and registration with
   its red/green tests.
2. Connect managed dispatch, current authority and independent request/Attempt inspection. Cover concurrent delivery and
   process interruption.
3. Add verified receipt reconciliation and guarded outer application with duplicate, stale, positive and refused cases.
4. Complete the native and package proofs, operator guide and any justified proof-caller change. Keep tests beside each
   behavior.

## Branch And PR Flow

1. Create an isolated `feat/issue-171-managed-workflow-execution` worktree at the latest verified `origin/main` after
   #170 merges. Check instructions and record the parent SHA in this plan before product edits.
2. Run the focused slices and full checks. Commit owned changes. Use `qodo-review` with a pinned pushed merge base,
   issue/contract links, design decisions, changed files, test results and recent work. Submit a fast asynchronous
   checkpoint after a completed slice and collect it. Use auto depth for the final review of the complete intended diff.
3. Reproduce findings at the reviewed commit, repair supported defects and repeat focused/full checks and final review
   after changes. Preserve service or transport failures and follow the bounded review recovery rule. An eligible failed
   review stays open.
4. Open one PR with `Closes #171`. Require completed structured hosted review of the exact head and passing required CI.
   Recheck finding status after fixes. Stored dismissal requires user authorization for the specific finding.
5. Merge with the reviewed SHA, compare the merged tree and verify post-merge checks. Record revision-bound results in
   #168 before #172 starts.

## Test Plan

Run from the dedicated worktree on a supported Node version. Use new output directories for both native proofs.

```bash
npm ci
npm test -- tests/integration/workflow-execution.test.ts tests/integration/gaap-executor.test.ts tests/integration/gaap-cli.test.ts
npm test -- tests/integration/gaap-native-fixture.test.ts tests/unit/gaap-runner.test.ts tests/unit/gaap-statement.test.ts
npm run test:controller
PYTHONDONTWRITEBYTECODE=1 npm run prove:gaap:goose -- --gaap /absolute/gaap --goose /absolute/goose --output /absolute/fresh-allow
PYTHONDONTWRITEBYTECODE=1 npm run prove:gaap:goose -- --gaap /absolute/gaap --goose /absolute/goose --output /absolute/fresh-bad-patch --case bad_patch
npm run check
npm run security:dependencies
git diff --check origin/main...HEAD
```

### Public lifecycle proof

1. Use separate control and subject repositories. Record `workflow create`, each saved `workflow decide --json`, and the
   explicit apply keys for `frame`, `bind_plan` and `begin_implementation`. Check version 3 and matched current graph,
   proof plan, subject, policy and available capability.
2. Run `workflow execute` with that stored decision and interrupt after enrollment. Read pending claim and Attempt
   identities from both inspectors. Retry the same decision under valid authority to launch once. Capture the
   independent process counter and the exact verified source. Read both stores again after restart.
3. Recover the admitted child through `workflow evidence import gaap` using the bounded correlation document that the
   outer inspector can reproduce. Verify the same source, execution head, claim and result on exact replay. Confirm the
   original outer version, and use a new `workflow decide` to explain any missing proof or reconciliation.
4. Supply the actual required producer evidence and scoped commit for the successful fixture. Apply a newly eligible
   edge deliberately. Verify the resulting version and event with a new process, then replay the same apply key. For the
   refused fixture, verify the original version, retained uncertain effect and safe recovery. Run both paths through the
   installed package. Compare old and new readers through their public commands.
5. Retain failure observations and fresh output paths with each program/binary SHA, fixture identity, environment class
   and exact outcome. The old synthetic implementing/v2 output remains a regression fixture.

Retain the existing proof as a regression. Add an explicit `--workflow-run` proof mode to the existing test harness
using the same pinned host/attestor and checksum-verified Goose 1.54.0. Its first action must come from a real persisted
Workflow Run and production selection. Feed only mapped parameters to the producer. Use fresh, isolated outputs for each
case. Check the native process transcript, one launch, exact request/claim/Attempt and signed admission, then compare
fresh outer inspection before and after deliberate application. Run the two native commands above again with
`--workflow-run` and distinct output directories for this proof. Record source tree and binary digests, public fixture
signer identity and deterministic local provider. Recheck after review repairs. The fixture signs executor evidence
only. Unit 5 owns observation of an actual same-head human action.

Before adding any workflow caller, establish that a specific authorized live proof genuinely needs it. Both current
first-party sensors accept only `workflow_call`. GitHub needs a dispatchable caller on the default branch. Also verify
the actual subject fits this bridge’s complete working-tree profile and has an eligible current PR. The full ThreadLoop
working tree exceeds that profile. Reuse an eligible, already authorized caller if one exists. Otherwise document the
exact subject, repository, base/head, proof plan, trust pins, permission set and proposed artifact route for review. A
tiny dedicated evidence base and feature branch is an option only after its branch and permission model has been
verified. Avoid shipping a general caller or treating a proposed route as observed evidence.

If the user authorizes the prepared live proof and its caller before #172, adapt the existing caller template to the
specific evidence branch, declared bounded gate and review action. Pin both reusable workflows to reviewed full SHAs.
Restrict permissions to repository read, pull-request read only for the review path and OIDC for the delegated signing
job. Use an explicit operator `workflow_dispatch`, no inherited secrets or automated trigger. Verify subject/head and
inputs through the existing independent sign/collect jobs, source tests, workflow security CI and the plan’s trust
policy. Record the enabled caller’s merged SHA. A live dispatch or actual approval requires its prepared bounded request
when user authority is needed.
[Caller example](https://github.com/nnennandukwe/threadloop/blob/7c54c2bb8055f00736e3b5f6631e9aecbe0fd212/examples/threadloop-caller-workflow.yml)

## Definition Of Done

- A selected and mapped engineering request crosses the real bridge once. Its canonical action, claim generation,
  Attempt, subject, policy and executor identities agree across both independent inspectors. Human, unmapped and stale
  requests leave the process count at zero.
- Captured signed evidence survives restart, including a lost success reply. Reconciliation verifies original bytes and
  correlated identities, accounts for the Attempt and refuses uncertain or conflicting effects. Exact retries can’t
  duplicate a launch, receipt, budget charge or transition.
- Fresh independent outer evidence can support an explicit eligible transition. Missing proof, a stale subject, an
  unresolved effect or missing human authority leaves the prior lifecycle version intact and identifies the permitted
  recovery.
- The new commands have verified help/text/JSON, protocol negotiation and installed-package behavior. The legacy session
  and standalone executor APIs still meet their reviewed contracts.
- Native/full checks, local and hosted reviews, merge comparison and post-merge CI are recorded for the exact unit
  revision. Unit 5 can reuse the composed runtime path with the evidence and limits described here.

## Assumptions And Defaults

The governed PR capability slice starts with the explicitly mapped `implement_change` path used by the native producer.
Other graph capabilities can be evaluated. Launch requires an explicit authorized mapping, subject, matching
verification policy and bounded budget. Fresh outer guard receipts, policy decisions and human evidence keep their
existing authority owners. The native fixture deliberately uses public signing material and a deterministic local
provider. Its physical workspace limits, existing stable Git revision during each Attempt and lack of replacement
authority constrain the proof.
