# Issue 170 Durable Workflow Runs Build Plan

## Summary

A developer can compile a Workflow Profile and evaluate explicit inputs. To use that graph across restarts, ThreadLoop
needs to remember the exact graph, decide from evidence it can verify, and apply a selected transition only on request.
This unit will deliver that behavior for configurable Workflow Runs in one PR. The legacy session lifecycle keeps its
existing interface. [Issue #170](https://github.com/nnennandukwe/threadloop/issues/170) ·
[Runtime tracker](https://github.com/nnennandukwe/threadloop/issues/168) ·
[Run binding contract](https://github.com/nnennandukwe/threadloop-contracts/blob/v0.1.0/docs/contracts/workflow-graph-v0.1/README.md#compatibility-and-run-binding)

The selector merged in [PR #174](https://github.com/nnennandukwe/threadloop/pull/174) at
`0694d0c50143aa4dd2799586456aa5a18008514f`. Its tree matches the reviewed head
`8c38e27a8ad978d675c87145e8ff27a9b7837920`. It exports
`selectWorkflowDecision(snapshot: unknown): ValidationResult<ControllerDecision>`. This change builds on storage
`8014d80acc8b6209560f2d6df5c9cf450544c4f2` and contracts `4ed9a94a2a089b9ae950d93297f7a6b9b939d3a6`.
[Program plan](controller-runtime-rust-prerequisites.md) ·
[Selector CI](https://github.com/nnennandukwe/threadloop/actions/runs/44956272381) ·
[Selector security](https://github.com/nnennandukwe/threadloop/actions/runs/44956272369)

## Skills To Use

| Stage               | Skills                                                               | Evidence                                                                                                                                           |
| ------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract            | qodo-get-rules, qodo-codebase-wisdom, codebase-design                | Recheck the merged public selector, storage ownership and protocol discovery. Apply rules 1060877 and 1060865 to every producer and enum consumer. |
| State               | workflow-invariants, transaction-proof, sqlite-concurrency-hardening | Model creation, evidence admission, transition, conflict, replay and restart. Read committed results through an independent SQLite connection.     |
| Implementation      | tdd, failure-path-testing                                            | Drive each slice through the public commands and verify held state after refusals and interrupted writes.                                          |
| Developer interface | cli-interactive-parity, voice-canon                                  | Compare the old protocol output, new negotiated output, packaged commands, runner instructions and public examples. Verify authored language.      |
| Delivery            | qodo-review, qodo-review-resolver                                    | Checkpoint a finished slice, review the full final diff against its pushed base, and verify the hosted review at the PR head.                      |

Qodo Local Review is eligible. The program's scoped rules, checked repository access and pushed base apply. Recheck the
unit's base and report any review failure with the actual error. Use the existing Node, SQLite, TypeScript, Commander
and Vitest tooling. The scoped rules lookup returned 1060877 for matching producer and consumer validation, 1060865 for
exhaustive enum handling, and 1060863 and 1060851 for preserving fields consumed by the older protocol. Rules 1060879
and 1060888 cover the sensor inputs and their callers. Keep the CLI documentation, command metadata, packaged examples
and tests aligned. The applicable dependency rule retains the existing lockfile and immutable pins.

## Scope

Persist compiled graph bytes, run identity, policy, state version, authoritative history, evidence admission and
idempotent transition results. Expose four lifecycle operations and two evidence operations. A preparation binds a
sensor observation to its producer version before collection. An import verifies and admits the resulting signed
artifact. Start with the governed-PR slice and demonstrate another accepted profile with different node IDs or topology.
Calls to the selector must accept the full frozen vocabulary even when a particular host has no producer for a
capability.

Unit 4 owns selected engineering execution, executor claims, Attempts and cross-database reconciliation. Unit 5 owns
external conformance and the observed human completion demonstration. Install, launch and runtime evidence for those
units stay with their own deliveries. Preserve existing sessions, audit-v1 chains, run-configuration digests and
non-authoritative exports. [GAAP integration #171](https://github.com/nnennandukwe/threadloop/issues/171) ·
[External verification #172](https://github.com/nnennandukwe/threadloop/issues/172)

## Package Layout / File-to-Task Mapping

- New `src/services/workflow-runtime.ts` will own create, inspect, decide and apply. Assemble actual input facts here
  and invoke the merged selection function. Keep arbitrary graph IDs out of `TaskStatus` and `applySessionTransition`.
- New `src/adapters/fs/workflow-store.ts` will own workflow tables and snapshot/transaction operations. Reuse the #85
  generation checks, connection lifecycle and transaction patterns in `src/adapters/fs/sqlite-store.ts`. Extract the
  narrow shared access needed to avoid competing writers for the same database. Keep `executor.sqlite` under the
  existing bridge owner.
- `threadloop-contracts/workflow` supplies `compileWorkflowProfile` and `validateGraphBinding`. Use the unit 2 selector
  and its public result types, existing canonical JSON, SHA-256 and proof-plan canonicalization. A new runtime schema
  belongs to the TypeScript package.
- `src/adapters/git/client.ts` and `src/adapters/fs/gaap-files.ts` supply physical repository facts.
  `src/services/signed-receipt-import.ts`, `src/domain/review.ts` and the Sigstore adapter own signed sensor checks.
  Reuse the exported `parseSignedReceiptEnvelope`, `validateSignedReceiptStatement`, `parseSignedReviewReceiptEnvelope`,
  `parseSignedReviewReceiptPackage` and `verifySigstoreReceipt`. Share the signer projection and context checks. Keep
  the existing session importers and their fixed-state append guards with their current caller.
- Both first-party sensor workflows, their capture and signing scripts, and `src/adapters/github/review-sensor.ts`
  implement the optional prepared-receipt path. Keep historical package bytes, workflow pins and the legacy collection
  path readable and verifiable. Update the sensor input reference and example caller for the new mode.
- New `src/commands/workflow.ts`, `src/cli-program.ts`, `src/commands/protocol.ts`, `src/contracts/protocol.ts`,
  protocol component versions, CLI/runner docs and `scripts/smoke-pack.mjs` own user-facing parity. Add focused run,
  fault and protocol tests where their production interfaces are exercised.

## Dependencies And Settings

Retain the locked contracts pin `4ed9a94a2a089b9ae950d93297f7a6b9b939d3a6` after checking the merged base. Use
generation 8 optional workflow tables under the initialized **control repository's** `.threadloop/state/state.db`. The
control repository can own several runs. Scope every operation to an explicit run ID. Generate neither a default run
pointer nor a scheduler wake. Leave generation 7 on its explicit operator migration path.

Use a separate **subject checkout** for the governed-PR run. The persisted location must identify a canonical absolute
Git worktree root, with an explicit repository identity and pinned origin where sensor trust requires it. Keep control
storage and executor output outside that checkout. The existing GAAP physical observer includes all subject files apart
from root `.git` and limits files to 8 KiB, descendants to 64 and depth to 8. Creating control state inside that tree
would change the subject digest. Check these limits when advertising GAAP dispatch support. Surface unavailable
observation for an unsupported subject and retain the original binding.
[Existing executor workspace contract](https://github.com/nnennandukwe/threadloop/blob/7c54c2bb8055f00736e3b5f6631e9aecbe0fd212/docs/gaap-executor.md)

Keep the supported Node versions and existing operator environment. Pass an optional prepared receipt ID from each
reusable workflow to its scripts through a step-local environment variable. An omitted or empty optional input selects
the legacy path. Skip new workflow callers in this unit. The example passes the input through to the pinned reusable
workflows. Gate execution and review collection retain their existing read-only job permissions. Only the separate
signers receive OIDC permission. The proofs here use fixture signers and a GitHub response double. The later proof needs
an approved live caller and observed same-head human evidence.

## Canonical Contracts

### Commands and wire versions

Invoke these commands from the initialized control repository. Paths to setup/profile/decision/source files resolve from
the call's working directory. An input file's relative local artifact paths resolve from its directory at creation. The
stored run uses retained canonical bytes and its bound subject root thereafter.

```text
threadloop workflow create <run-id> --profile <yaml> --setup <json> [--json]
threadloop workflow inspect <run-id> [--json]
threadloop workflow decide <run-id> [--json]
threadloop workflow apply <run-id> --decision <file> --idempotency-key <key> [--json]
threadloop workflow evidence prepare <kind> --run <run-id> [--gate <id>|--pr <n>] [--instruction <file>] --expected-state-version <n> --idempotency-key <key> [--json]
threadloop workflow evidence import <kind> --run <run-id> --source <file> --expected-state-version <n> [--json]
threadloop protocol [--contract 4|5] [--json]
```

- **Create.** Accept an explicit bounded opaque run ID, compile one YAML profile with the public compiler, retain
  canonical graph bytes and validate the digest. The closed `threadloop.workflow-setup/1` input supplies
  `subject_workspace`, repository identity, explicit selector policy rules and references to immutable proof-plan and
  trusted source configurations. Validate the referenced bytes and their identities. The proof plan specifies the exact
  allowed commands and signer policies. Match declared gate IDs and proof binding transition to that graph/plan. Where
  commit work needs a path scope, retain an explicitly adopted path scope and its digest in the run setup. A Git diff
  alone can't prove that a change is within the plan. Advertising an actor/capability requires an actual configured
  producer. Reject unknown top-level fields, given state/history/receipts, arbitrary executables in the graph,
  self-declared signer identity and a mismatched graph or policy. Runs that opt into the GitHub sensors use a unique
  `session_wf_<suffix>` ID. Restrict the suffix to `[A-Za-z0-9_-]+` and the complete ID to 160 characters. The sensors
  require the `session_` prefix and 40-character lowercase invocation SHAs. Legacy session creation generates
  `session_<UUID>`. Other graph runs need only the documented local ID bounds. Keep a sensor-enabled run ID unique
  within this initialized store and verify its exact signed value at import. Bind the target repository and base at
  create. On the first review preparation, adopt the exact PR number and URL for this run, then require that target for
  every subsequent review observation.
- **Inspect.** Return `contract_version: 1`, `workflow_run_id`, `graph_schema_version`, `graph_digest`, `policy`,
  `state`, `state_version`, `history_digest` and `evidence_revision`. Inspect verifies the persisted binding and event
  chain. It can operate while the subject checkout is offline. Retain the same fields in create's initial view. Genesis
  selects `compiled.graph.initial_state` at version 0.
- **Decide.** Return the frozen `ControllerDecision` envelope in `data.controller_decision` alongside `data.expectation`
  containing run/graph/policy IDs, state and evidence revision, history digest, subject, evaluation time, input digest
  and decision digest. Derive each value from actual inputs. Collect fresh observations without writing to either
  database. Return a valid `blocked`, `waiting` or `terminal` outcome as a successful decision. Invalid or missing graph
  bytes return a typed error with a recovery hint.
- **Apply.** Consume exactly one successful `workflow decide --json` envelope and a new or previously used key. Treat
  every value in that file as an expectation. Reconstruct the authoritative input and selected edge. Only
  `transition_available` can advance the run. The persisted result has `contract_version`, run, graph, transition ID,
  from/to, previous/new version and event/decision digests. Use the recorded result on exact replay. A different request
  under the same key conflicts even when it reaches the same target. An obsolete version or evidence/subject/policy
  identity requires a new decision. Idle, handoff, waiting or blocked responses never launch a process.
- **Evidence prepare.** Require exactly one target. Use `--gate` for `signed-gate`, `--pr` for `signed-review`, and
  `--pr` with `--instruction` for `signed-instruction`. Under the write lock check the version, current clean physical
  subject, pinned sensor policy and allowed target. Commit a cryptographically random 128-bit ID encoded as
  `wfr_<32 lowercase hex digits>` and its producer context. Return the prepared ID and the exact sensor inputs. The
  operator passes them to the verified caller. This command doesn't launch a job, append controller evidence or advance
  the run. An exact retry of the preparation key returns the original ID, context and deadline even after expiry. A
  different request under the key conflicts.
- **Evidence import.** Accept bounded raw bytes from the configured sensor. Authenticate the envelope, signed statement,
  signer and source context before its first admission. Look up the signed ID in this run's preparations. Check the
  immutable context and the current write expectation. Return source and canonical package digests, admission identity,
  derived receipt IDs, evidence revision and unchanged run state/version. Use the signed-instruction source described
  below for explicit human control.

Apply the existing `{ok, command, data}` / `{ok:false, command, error:{code,message,details}}` envelope and command exit
conventions. Text create/inspect shows run ID, graph, state and version. Text decide shows the selected outcome and its
transition/action or reason and recovery. Text apply shows the committed edge, version and event digest. Text import
reports the source/admission identity. Text prepare reports the ID, kind, target and deadline. Reuse
`STATE_VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `STATE_CORRUPTED`, `TRANSITION_GUARD_FAILED` and specific signer
diagnostics. Add `WORKFLOW_RUN_NOT_FOUND` for an unknown run. Include a stable `details.reason` and exact recovery step
for stale input or unavailable storage. Every read preserves a missing store.

The selector CLI returned these SHA-256 values over its exact default protocol output, including the final newline. The
packaged compatibility test should compare both complete streams. The v4 text hash is
`5ac51f9c27359b9f27e717adec58d4b85c3e78e4b721957ed534f2d9a7e40fcf`. The v4 JSON hash is
`e5943879bfaf27696f0c791adca0d5510e6e49d5660edfa9beb75931c846ed90`.

Default `protocol` and explicit `--contract 4` return the same v4 content and command usage as the verified predecessor,
including the original usage for the protocol command itself. Freeze the old command/option surface through an explicit
v4 builder or view and verify its rendered JSON and text against the predecessor CLI. The opt-in v5 descriptor
advertises the actual registered workflow leaves, protocol negotiation, `workflowRun: 1` and a `capabilities` list
containing `workflow_runs_v1`. Consumers require the specific capabilities they use and accept additional names. Later
executor support must advertise its own capability. Retain the session/runner version numbers. Reject unknown versions.
The existing builder enumerates every registered Commander leaf and option. Keep the v4 view separate before formatting
usage. `src/adapters/fs/run-configuration.ts` copies `PROTOCOL_COMPONENT_VERSIONS` into the recorded descriptor.
Preserve its v4 values for legacy sessions. A v4 runner stays on its current protocol and storage gates. A graph command
never becomes an autonomous action in an existing wake.

### Setup file

A graph can start with a local repository and the built-in controller. For example, this setup supports the guard-free
`start_quote` transition from `intake` to `prepared`.

```json
{
  "schema_version": "threadloop.workflow-setup/1",
  "subject_workspace": "../subject",
  "repository_id": "fixture-repository",
  "policy": {
    "id": "fixture-policy",
    "proof_binding_transition_id": null,
    "local_gate_ids": [],
    "independent_gate_ids": [],
    "publication_destination": null
  },
  "proof_plan": null,
  "trusted_sources": null,
  "allowed_change_paths": []
}
```

For a governed PR, use the canonical HTTPS origin as the repository ID. Set `proof_plan` to a v4 plan file and
`trusted_sources` to the host's source configuration. Name the graph's proof-binding transition and the local and
independent gates from the plan. List the repository-relative paths that engineering work can change. The host derives
the observed baseline, verification-policy digests and authority identities when it adopts the setup. Store the
validated contents so a later edit to a setup or profile file can't replace an active run's binding. The CLI accepts no
preverified receipts or current state in this file.

A `threadloop.workflow-sources/1` document names `host_producers` and `github`. The supported host producer names are
`local-gate` and `pre-pr-review`. A name enrolls an existing producer. Capability discovery also checks whether the
producer is connected. Set `github` to null for local operation, or supply `base_ref`, the enrolled GitHub User's
`human_node_id`, `preparation_ttl_ms` and `evidence_ttl_ms`. These intervals must be positive safe integers. Both signer
policies come from the bound v4 proof plan. The product review and explicit instruction use the same enrolled User and
separate PR targets.

The predecessor returned `INVALID_ARGUMENT` for `workflow create` using a compiled three-state profile
(`22fb31abcf828c86c0c299eed82bc0d196285a62a9875bfd96fa3d5580202234`) and a committed, clean subject. A second SQLite
connection saw the same data version and 76 schema objects before and after the call. The new command must create the
run at `intake`, version 0, and reopen it after the profile file changes.

### Trusted inputs

- **Graph and policy.** Use the public compiler's `{graph, graph_digest}` result. Retain UTF-8
  `canonicalJson(compiled.graph)` with no final newline. On read verify the stored byte hash and canonical byte
  equality, reconstruct the compiled envelope and call `validateGraphBinding` with the strict two-field graph binding.
  Its parsed-value check can't detect whitespace changes in the source bytes. Creation retains the validated
  policy/setup bytes and digests. Inspect and select verify intrinsic hashes and pinned identity against the run's
  immutable genesis. A profile edit starts a separately bound run. Use a local immutable host policy to identify the
  registered verification adapters, their identities and capability mappings. A selector policy's strings alone can't
  authenticate the holder of an identity.
- **Observation.** Read the actual checkout, branch, revision, content digest, clean status and ancestry. Identify the
  observation deterministically from its verified facts. A missing or replaced workspace yields an unavailable
  observation. Bind commit authority to the recorded implementation basis, changed bytes and exact allowed path scope.
  Never mark a dirty tree `within_plan` by default.
- **History.** Rebuild phase from the graph's optional phase policy, genesis and applied transitions. Derive budget
  counts from accepted entries named by each graph budget. A duplicate consumes nothing. Record the prior state on
  suspension and require that exact return edge plus current scoped human authorization for recovery. Rebind a
  still-active repair admission to the new version on valid recovery, and clear it on progress out of repair. Preserve
  the admitted count and original entry version at the limit.
- **Evidence.** Each receipt retains its run, graph, producer version, exact subject, verification policy, workflow
  policy, acceptance, sequence, typed payload, digest and applicable deadline. Recheck supersession, expiry and claim
  fencing before use. An earlier producer version remains eligible across transitions on an unchanged subject and
  policy. A receipt's verified upper version bound and live use conditions are separate checks.

- **Governed PR intake.** Use the host-owned, immutable plan and observed baseline for its named binding transition. For
  local proof, take a retained result only from an actual trusted run of the bound gate, with before/after subject,
  artifact hash, clean result and output bytes verified by the existing proof evaluator. A copied caller-provided local
  receipt can't grant that authority. The existing gate process records into a fixed session. The graph service needs a
  run-aware ingestion callback for its trusted producer. Unit 4 supplies selected execution and owns the production
  dispatch connection. The same rule applies to a local pre-PR review: retain the current-head review artifact and
  identity from the trusted reviewer/host, including its outcome and blocking findings. Omit unsupported sources from
  the capability set. Tests can exercise admission through an explicitly injected trusted producer; label fixture
  evidence and separately test the public import/refusal path.

### Prepared sensor evidence

1. At preparation, persist the run ID, graph digest, producer state and version, clean subject (repository, revision,
   content digest and branch), exact gate declaration or PR URL/number/base, bound proof-plan digest, policy identities,
   authorized signer SHA/URI, kind and deadline. The host computes these facts from its stored binding and observed
   checkout. The operator supplies the requested target and expected version. An explicit human instruction also
   includes its proposed purpose and explanation. Require the immutable sensor configuration to specify positive bounded
   preparation and evidence lifetimes. The host sets the preparation deadline to its commit-time clock plus the
   configured interval, capped at any earlier policy or observation deadline. For new evidence, begin the configured
   validity interval at signed gate `ended_at` or review `observed_at` and cap it at the applicable policy deadline.
   Reject future measurements and expired evidence on first admission. Use the host clock at the write boundary and at
   application.
2. Add optional `prepared_receipt_id` to each existing `workflow_call`. In this mode the capture script sets the draft
   ID from the input, the signer rechecks that ID against its own workflow context, and the signer uses it as the final
   `receipt_id`. Require the reserved ID format in both steps. Continue checking the captured run/attempt URI, plan,
   gate or PR and source context at signing. Omitted input retains the existing random-ID and review collection paths.
   Both in-toto statements already bind the canonical artifact digest, which covers its receipt ID. The existing gate
   v1/v2 and review v1 package schemas can carry that value. Pin the merged sensor revision in the run's trust policy
   and later caller. Package format alone can't identify this producer behavior.
3. On import verify the signed run ID, canonical statement and artifact, issuer, certificate, transparency inclusion,
   configured caller identity, pinned sensor revision, source repository/ref/SHA and run attempt URI. For the gate,
   match the declared gate, tested branch and source/before/after head. For the review, verify the certificate against
   the actual caller revision/ref and the in-toto subject against the signed PR head. Those SHAs can differ. Verify
   destination URL, number and base, then reobserve the bound clean checkout. A different physical digest at the same
   Git SHA fails. The GitHub snapshot omits the PR source repository/ref, merge commit SHA and merger ID. Only claim
   what the signed fields establish.
4. The signed ID locates the prospective context. Use its original version as `source_state_version`. Never copy the
   importer's current version or a caller's version assertion into that field. Check current state separately with
   `--expected-state-version`. A preparation made at version 3 can supply evidence at version 4 when the bound subject,
   authority, purpose and deadlines still hold. A package with no matching preparation or a stale subject can't be
   relabeled. A positive check also binds the authenticated invocation URI to this accepted source.
5. Keep the exact input bytes, their SHA-256, canonical package digest and verified signer record. A unique preparation
   admits one package. A byte-identical prior acceptance returns its original result after state changes or expiry.
   Different bytes, including alternate whitespace, signature or invocation under the same prepared ID, conflict. An
   unused preparation expires at `now >= valid_until`. A new preparation requires a new key and a fresh observation.
   Receipt validity ends at the independently derived evidence deadline. A short collection deadline doesn't revoke an
   already accepted fact before its own deadline. Keep rejected and expired inputs out of the active fact set.
   [First-party signing context](https://github.com/nnennandukwe/threadloop/blob/8014d80acc8b6209560f2d6df5c9cf450544c4f2/src/domain/attestation.ts#L251)
   ·
   [Sensor environment](https://github.com/nnennandukwe/threadloop/blob/8014d80acc8b6209560f2d6df5c9cf450544c4f2/scripts/sensor-environment.ts#L8)

**Gate outcomes.** Require exit zero, no signal, a clean before/after tree and an unchanged tested commit for a pass.
The signed source retains each recorded outcome. An authenticated, matching newer failure supersedes an earlier
same-subject pass. Map `failed` to the independent failure payload. For a verified non-pass without a matching
independent payload, retain its named source outcome, remove the older pass from the active stream and return a reason
with the next allowed collection or operator action. Reject unauthenticated packages before any such change. Preserve
the legacy pass-only store. For each gate, require strictly advancing signed completion time across distinct accepted
measurements at the same subject and policy. An older or conflicting equal-time reading can't revive a pass.

**Named current approval.** In prepared mode query GitHub's `PullRequest.latestOpinionatedReviews` with the existing
pagination and stable PR metadata checks. It returns the latest opinion per user. Include reviewers regardless of write
access, then match the run's enrolled human GraphQL node ID. Retain only a submitted `User` approval at the exact PR
head. Cross-check the candidate with the full review history already available from the sensor. A later same-actor
change request or dismissed review bars the older approval. An informational comment supplies no opinion. Refuse
ambiguous order, partial pagination, changing results or unidentified authors when they prevent establishing the
candidate. Keep collecting trusted thread status and aggregate decision independently. These conditions use the existing
v1 approvals array. A generated receipt in prepared mode records only the current subset through the verified sensor
implementation at its pinned SHA. Legacy sensor snapshots can't grant named current approval to a graph run.
[GitHub review fields and states](https://docs.github.com/en/graphql/reference/pulls#pullrequest) ·
[Review package format](https://github.com/nnennandukwe/threadloop/blob/8014d80acc8b6209560f2d6df5c9cf450544c4f2/docs/attestations/review-v1.md)

A reviewer can clear their change request by approving the PR. A permitted repository administrator or writer can
dismiss a blocking review, subject to the repository's dismissal restrictions. Dismissal supplies no assent from the
named reviewer. A different reviewer's approval or the aggregate PR decision can't supply it either. A newer accepted
snapshot replaces the complete current approval set for that PR/subject/policy. Preserve earlier approvals as history.
Reject older or conflicting equal-time snapshots. Derive the separate merge observation from the matching signed PR
target, head, `merged` and `merged_at`. A regular PR approval supplies no recovery intent.
[GitHub branch rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-a-pull-request-before-merging)
·
[Dismissing a review](https://docs.github.com/en/enterprise-cloud@latest/pull-requests/how-tos/review-pull-requests/dismissing-a-pull-request-review)
·
[Frozen receipt contract](https://github.com/nnennandukwe/threadloop-contracts/blob/v0.1.0/docs/contracts/controller-v0.1/README.md#explicit-input-and-trust-boundary)

## TDD And BDD Implementation Strategy

1. Capture the merged predecessor CLI's default protocol text and JSON. Start with a red public create/reopen test for a
   graph using renamed nodes. Implement atomic creation, inspect and exact create replay. Change the YAML and prove the
   persisted run still selects from the original graph.
2. Drive a guard-free decision on the stored run. Compare state.db and event sequence before/after inspect and decide.
   Repeat with a second topology. Corrupt the persisted graph or its genesis reference and verify the CLI refuses before
   application.
3. Save a successful decision and apply it once. Retry after restart, change bytes under its key, race two independent
   processes, and edit the subject between decide and apply. Test an expired observation, changed evidence with the same
   state version, stale policy, corrupt history and unauthorized terminal application.
4. Add one verified evidence producer at a time. Reject raw normalized input and wrong-run, wrong-graph, stale-head,
   unknown signer and wrong-plan packages before writing an admission. Apply budget, suspension, recovery and human
   completion examples with credible provenance. Test absence of an enrolled recovery verifier explicitly.
5. Verify the old runner, new help/JSON/text routes, v5 capability view and a packed install. Exercise each durable cut
   through an independent reader and reopen after process termination. Add focused tests with their behavior.

## Component Design

Use optional workflow tables for graph bytes, immutable run genesis/setup, versioned state, append-only events, sensor
preparations and accepted sources, plus an idempotency index bound to the operation. Give the new store exclusive
ownership of its schema and state writes. Scope checks to capabilities with #85's compatibility rule. Use state.db
foreign keys, unique run/version and run/sequence identities, atomic compare-and-swap and append-only
mutation/replacement defenses on authoritative records. Legacy readers won't need these tables.

**Database access.** Share the cached writer, foreign keys, busy timeout, close hook and synchronous transaction
primitive. Keep legacy bootstrap/adoption in its existing caller. Workflow creation must open an existing initialized
control database and check generation 8 under the lock. Open its escaped SQLite file URI with `mode=rw` to prevent
creation if the database disappears between lookup and open. Independent native Node 22, 24 and 26 probes verified
existing-file updates and rejection of missing files, including paths with a space and a hash character. Classify the
entire workflow object set as absent, valid or conflicting. Create it only when all its objects are absent. Verify
columns, CHECK clauses, unique keys, ordered FKs and update/delete/replace triggers. A partial set or occupied name
fails before DDL. Keep the feature outside `SESSION_COLUMNS` and the session cache's claims. Reads use one independent
read-only `withReadSnapshot` callback to check generation, required schema, binding, genesis, events, projection and
replay/evidence records. A Promise can escape the existing synchronous transaction callback. Complete hashing of bounded
inputs or network work outside the callback and perform its authoritative synchronous rechecks before returning.

**Create commit.** Validate and hash setup before the transaction. Under BEGIN IMMEDIATE confirm the storage generation
and ownership of optional schema objects. Compare existing graph bytes on digest reuse. The graph, genesis, version-zero
projection and receipt for the create operation become visible together at COMMIT. Identical initial inputs for the same
run ID return the original create result after subsequent progress. Different initial bindings for that ID conflict.

**Apply commit.** Parse the request, canonicalize all its expected fields and hash it. Inside the write transaction
validate retained authority and the integrity of the recorded operation, then check the prior idempotency result before
fresh-state predicates. A successful retry can return its committed result even if the subject has since changed. For a
fresh operation validate chain, state, evidence revision, graph, policy and observation. Verify the original decision at
its stated instant against trusted inputs, then reevaluate temporal and authority predicates using host time. A
refreshed input can change a decision digest solely because time advanced. Require the same eligible edge and evidence
witnesses, current deadlines, and unchanged graph/subject/state/evidence identities. Evaluate a final bounded local
observation immediately before the guarded update. Use the synchronous physical workspace observer inside the write
transaction. Read Git ancestry independently of a tree-diff check so a later descendant with identical contents can
satisfy the recorded ancestry relationship. SQLite can't lock an independent Git checkout; the decision certifies the
observed subject at application and a later external mutation requires fresh facts on subsequent operations. CAS on run,
expected state, version and evidence revision. Require one affected row and commit the new projection, evidence
references, event and original result together.

**Preparation and admission commits.** Preparation atomically commits its context, original response and replay key. An
unaccepted preparation contributes no receipt. For admission, first hash the bounded bytes and allow a verified
exact-byte readback of an earlier committed acceptance. New admission requires complete signature authentication outside
the write transaction. Under the writer lock, check the retained binding and exact-byte replay before first-use checks.
Reobserve the subject, verify the preparation, stream order and import CAS, then commit acceptance, source bytes,
derived facts or withdrawal, first-use binding and one evidence revision. The lifecycle version remains unchanged. A
crash before commit leaves the preparation unused. A lost reply after commit recovers the original result from a fresh
read-only handle.

## Failure And Recovery Rules

Always preserve unowned schema objects, previously committed events, proof source bytes, original run identities and
other writers' results. Apply or admit only with fresh verified prerequisites. Maintain one committed mutation outcome
for each accepted request identity. Pre-commit interruption must expose the complete prior state. Post-commit
reporting/cleanup failure requires readback of the accepted operation through a new connection; only a matching receipt
can support committed-with-warning. An inconclusive readback reports an uncertain result and the same-key recovery
command.

| Operation or cut                                                                                      | Fault and durable observation                                                                                                                                 | Recovery proof                                                                                                             |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Read setup/profile/graph or open subject                                                              | Missing, malformed, symlinked or mismatched source. Existing store and bindings remain intact.                                                                | Correct the source and retry create or restore the original bound graph. Capture before/after digests.                     |
| Open read-only storage and inspect capabilities                                                       | Absent workflow feature, unsupported generation, missing table/trigger or wrong schema owner. A read performs no setup.                                       | Use the appropriate writer for eligible new storage or restore trusted data. Inspect legacy reads without workflow tables. |
| Create optional tables, insert graph, insert genesis, insert state, insert result                     | Inject an exception and kill a child after each write and just before COMMIT. The run is absent or its original state remains complete.                       | Reopen on an independent connection and rerun the identical create. Concurrent creation preserves the first binding.       |
| Create or retry a preparation                                                                         | Crash before/after the preparation commit, race two requests for one key, expire an unused ID.                                                                | Reopen and retry the exact key. Inspect original context and deadline. Use a fresh key for a fresh observation.            |
| Read source, authenticate package, retain bytes, append admission/facts and advance evidence revision | Corrupt source, unsupported trust, conflicting ID, changed state/subject or lost DB access. No partial acceptance or sequence gaps from a failed transaction. | Correct the input or inspect the existing acceptance. Verify raw stored bytes and signer binding on readback.              |
| Load selection, observe subject, begin write and recheck CAS                                          | Another process changes state/evidence or the subject changes between observations. No unauthorized state advance.                                            | Re-decide on the current run. Test two writers and a concurrent immutable reader.                                          |
| Append transition event, update projection, record replay outcome, commit                             | Interrupt before each durable step, immediately before commit and after commit before response. Reader sees complete old or new state.                        | Retry identical bytes/key. Verify one event/version and one budget debit. Reused key with changed content conflicts.       |
| Return output or close handles after commit                                                           | Lost stdout/cleanup or readback failure. Never start another operation as compensation.                                                                       | Inspect the committed result or retry the original request. A busy lock gets bounded retry with the same identity.         |

Lifecycle closure covers new schema creation, run creation, inspection, read-only selection, verified evidence
admission, transition application, terminal and suspended behavior, rejection, competing writers, restart/retry,
authority tampering and output loss. Retain run records for audit. No deletion operation belongs to this build. SQLite
owns journal sync and rollback; test the observable transaction and process cuts without promising recovery from
physical disk loss.

## Commit Plan

1. Record the verified base and plan. Deliver graph binding and run creation/inspection with restart and
   conflicting-reuse tests.
2. Deliver trusted input projection and read-only selection, then add versioned explicit application with the
   replay/fault tests.
3. Deliver prepared sensor ingress, the pinned reviewer observation, verified admission, authorization and refusal
   cases. Exercise explicit signed instructions, including withdrawal and exact-suspension replay.
4. Deliver protocol negotiation, package smoke and durable public examples. Keep tests for each operation with its
   implementation.

## Branch And PR Flow

Use the isolated `feat/issue-170-durable-workflow-runs` branch at `0694d0c50143aa4dd2799586456aa5a18008514f`. Preserve
previous worktrees and frozen sources.

Commit only owned changes. Run native focused and full checks before review. Submit a fast asynchronous local checkpoint
at a completed slice with #170, the verified base, current head, trust decisions and fault coverage. Collect it. Run
auto-depth final Qodo Local Review on the complete change set. Reproduce findings, repair supported defects, rerun
checks and review changed heads. Report eligible service failures accurately.

Open one PR with `Closes #170`. Require completed structured hosted review at its actual head and the current required
checks. Prefer automatic attribution for fixes. A stored dismissal needs specific authorization. Merge the reviewed SHA,
compare the resulting tree and verify post-merge CI. Record the actual evidence in #168 before Unit 4 starts.

## Test Plan

Use the startup/package scripts already in the merged worktree. Add focused files for the new public interfaces and use
their actual names in the final proof record.

```bash
npm ci
npm test -- tests/integration/workflow-runtime.test.ts
npm test -- tests/integration/workflow-interruption.test.ts
npm test -- tests/unit/protocol-contract.test.ts tests/integration/runner-replay.test.ts
npm run test:controller
npm run check
npm run security:dependencies
git diff --check origin/main...HEAD
```

Run these evidence and storage cuts through their production entry points:

- Race first creates, fail each feature DDL/genesis write and collide with a foreign or partial schema. Legacy reads
  work with workflow tables absent or damaged. Check WAL logical rows and an independent connection's
  `PRAGMA data_version` as well as DB bytes for read-only operations.
- Prepare at v3, advance with an unchanged clean subject, admit at v4 and prove the receipt retains v3. Test wrong
  preparation, unknown ID, wrong run/kind/gate/PR/base/caller, dirty tree at the same SHA, first use at the deadline,
  replay after expiration and reordered signed observations. Race two admissions of different valid signed bytes under
  one ID. Verify exactly one outcome and evidence revision. Reject whitespace-only replay under a used ID.
- Run the updated sensor collection and signing-context scripts through the optional input path with controlled source
  data and an injected verifier. Check legacy behavior with that input omitted. Exercise old approval followed by the
  same actor's change request, another reviewer's positive vote, dismissal without fresh assent, a later explicit
  reapproval, stale commit, bot, changed pagination and same-head distinct PRs. Assert the normalized human approval
  disappears after withdrawal. A prepared review can have different invocation and PR subject SHAs. Confirm signed merge
  fields independently of human approval. Keep fixture results clearly labeled.
- Accept a clean gate, then a newer matching signed failure at the same head. Confirm the former pass can't authorize
  apply. Exercise corrupt retained source/graph bytes, dropped triggers, concurrent CAS, exact create replay after
  progress, consumed-preparation replay after process termination and one failed apply after changed evidence.

Verify original v4 text/JSON against bytes collected by invoking the preceding merged CLI. Use a packed installation to
create, decide, apply, reopen and inspect an alternate graph and to exercise unknown/future protocol refusal. Retain the
precise graph, policy, before/after state versions, independent audit hashes, SQLite fault cuts, tested head, review
results and remaining gaps. Run the voice verifier on authored material. Label fixture signer evidence and reserve live
completion claims for Unit 5.

## Definition Of Done

- Restart and profile edits preserve a run's original graph. A second topology follows its own nodes through the same
  service.
- The production selector consumes verified facts. Explicit apply enforces evidence, subject, version, authority,
  budgets, suspension, recovery and terminal guards. Exact retries and racing writers leave the promised durable state.
- Original session and runner clients continue to use v4. Clients requesting v5 can discover and run the new commands
  from the installed package. Historical evidence and read-only paths retain their tested behavior.
- #170's required checks, fresh local/hosted review, merge and post-merge verification have exact revisions and results.
  A missing required acceptance source stays open with its bounded decision.

## Assumptions And Defaults

An authorized operator creates a run's initial local trust configuration. Possession of an arbitrary path, a typed actor
name or a self-consistent digest can't supply evidence from a trusted producer. Tests may deliberately install fixture
identities for local proof and must identify them as fixtures. The prepared, pinned review sensor can prove named
same-head assent and observed merge. Its signed PR facts carry no explicit recovery instruction.

**Human instructions.** Use the enrolled review sensor and GitHub User for explicit stop, block and recovery. Add
`signed-instruction` to evidence prepare/import. Preparation takes `--instruction <file> --pr <n>` and binds its
canonical bytes to the original physical subject, graph, workflow policy, active or suspended version, intended edge,
receipt ID, human identity and expiry. Return the bytes for the human to review in a separate authorization PR. The
product PR and the instruction PR must have separate targets and evidence streams.

The instruction describes one of three purposes. `request_stop` supplies a reason and projects `stop_requested`.
`block_run` supplies the intended suspension edge, original state, reason, stop code, evidence reference and recovery
guidance. Admit `block_evidence` once. An explicitly combined stop and block can project both receipts in one
acceptance. `recover_run` names the original suspension, recorded prior state and reason. A verified instruction
projects `human_approval` with `scope=recovery` for that suspension. Each projection expires or becomes historical when
the prepared version changes. Only an explicit guarded apply changes state. Normal return after recovery preserves
budget counts and can't reuse an older instruction.

Require a current same-commit approval by the enrolled User on the exact instruction PR, collected after preparation by
the pinned caller on the configured base. In a bounded read-only Git object source, verify the approved commit, tree,
regular root file `.threadloop-instruction.json` and manifest blob. Disable replacement objects, require the
authenticated base revision as ancestor and verify that only the instruction file changed. Compare its raw bytes with
the prepared manifest. Check the original physical subject at admission and apply. A missing object, mismatched base,
superseded approval or expired preparation keeps the handoff pending. The fixture test uses a real companion commit, an
independent checkout and a test signer. Live recovery requires an actual approval of the prepared instruction.
[Review statement fields](https://github.com/nnennandukwe/threadloop/blob/8014d80acc8b6209560f2d6df5c9cf450544c4f2/src/domain/review.ts#L65)
·
[Frozen input and trust contract](https://github.com/nnennandukwe/threadloop-contracts/blob/v0.1.0/docs/contracts/controller-v0.1/README.md#explicit-input-and-trust-boundary)
