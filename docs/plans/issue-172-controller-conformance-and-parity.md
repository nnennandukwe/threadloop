# Issue 172 Controller Conformance and Pre-Rust Parity Build Plan

## Summary

Prove the TypeScript controller through an independent process, show recovery from interrupted execution, and measure
what a later Rust implementation must preserve. Deliver the subject, reproducible proof and readiness report in one
ThreadLoop PR. The separate live proof needs an authorized fixture PR and an independent person's decision. The Rust
replacement belongs to M003. [Issue #172](https://github.com/nnennandukwe/threadloop/issues/172) ·
[Program #168](https://github.com/nnennandukwe/threadloop/issues/168) ·
[Runtime gate #110](https://github.com/nnennandukwe/threadloop/issues/110) ·
[Storage #85](https://github.com/nnennandukwe/threadloop/issues/85) ·
[M003](https://github.com/nnennandukwe/threadloop/milestone/3)

| Predecessor            | Inspected evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #85 storage            | PR #173 merged as `8014d80acc8b6209560f2d6df5c9cf450544c4f2`. [PR](https://github.com/nnennandukwe/threadloop/pull/173) · [CI](https://github.com/nnennandukwe/threadloop/actions/runs/44950980593) · [Security](https://github.com/nnennandukwe/threadloop/actions/runs/44950980567)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| #169 selector          | PR #174 merged as `0694d0c50143aa4dd2799586456aa5a18008514f`. [PR](https://github.com/nnennandukwe/threadloop/pull/174) · [CI](https://github.com/nnennandukwe/threadloop/actions/runs/44956272381) · [Security](https://github.com/nnennandukwe/threadloop/actions/runs/44956272369)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| #170 Workflow Runs     | PR #176 merged as `bdf68cc2d3ad915d085aecff47c9181f65fb5205`. Its tree matches reviewed `31388a07566350dfeddc30578d43b8926d5b4e22`. [PR](https://github.com/nnennandukwe/threadloop/pull/176) · [CI](https://github.com/nnennandukwe/threadloop/actions/runs/44961637392) · [Security](https://github.com/nnennandukwe/threadloop/actions/runs/44961637374)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| #171 managed execution | PR #177 merged as `50b3aa61f92bbc1e03b3177683e16aa199a3dd7b`. Its tree `493ec2647f40b295a123ded829592a20c551a4be` matches reviewed commit `ca713573e1ffc0c60ad4be34c58638804c65a4c9`. Hosted Qodo run 2091862 completed at that commit. All 8 required jobs passed. [PR reviews](https://github.com/nnennandukwe/threadloop/pull/177/files) · [Reviewed source](https://github.com/nnennandukwe/threadloop/tree/ca713573e1ffc0c60ad4be34c58638804c65a4c9) · [Merged base](https://github.com/nnennandukwe/threadloop/commit/50b3aa61f92bbc1e03b3177683e16aa199a3dd7b) · [PR CI](https://github.com/nnennandukwe/threadloop/actions/runs/44988350617) · [PR Security](https://github.com/nnennandukwe/threadloop/actions/runs/44988350578) · [Main CI](https://github.com/nnennandukwe/threadloop/actions/runs/45016894891) · [Main Security](https://github.com/nnennandukwe/threadloop/actions/runs/45016894836) · [Expiry commit points](https://github.com/nnennandukwe/threadloop/blob/ca713573e1ffc0c60ad4be34c58638804c65a4c9/docs/plans/issue-171-managed-workflow-execution.md#expire-an-overdue-managed-claim) · [CLI refusal tests](https://github.com/nnennandukwe/threadloop/blob/ca713573e1ffc0c60ad4be34c58638804c65a4c9/tests/integration/workflow-execution.test.ts) · [Qodo response parser](https://github.com/nnennandukwe/threadloop/blob/ca713573e1ffc0c60ad4be34c58638804c65a4c9/src/services/workflow-collection.ts) · [Provider response fixture](https://github.com/nnennandukwe/threadloop/blob/ca713573e1ffc0c60ad4be34c58638804c65a4c9/tests/integration/workflow-collection.test.ts) · [Local review object formats](https://github.com/nnennandukwe/threadloop/blob/ca713573e1ffc0c60ad4be34c58638804c65a4c9/docs/plans/issue-171-managed-workflow-execution.md#collect-local-reviews-in-sha-256-git-repositories) |

At `ca713573e1ffc0c60ad4be34c58638804c65a4c9`, local auto-depth review operation `d2d40a8b-1768-4aa1-82de-7d276a8f0cb2`
completed in incremental mode with complete reported coverage. Qodo lists recommendation `0800154c` as dismissed. The
exact-head review lists recommendation `1a56a90a` as pending. Two Qodo CLI responses for the same missing operation
contained the same U+2014 delimiter and different trace IDs. Rule 576985 permits clearly marked protocol data. Comments
above the parser and its integration fixture identify that delimiter. The parser matches the measured prefix and the
fixture preserves the full provider message. The Qodo triage receipt for `0800154c` records reason `intentional` and
reports pending downstream synchronization. Qodo skipped spec-agent. The native check passed 940 tests in 75 files,
including build and package smoke. The controller suite passed 65 tests. The dependency audit reported zero
vulnerabilities. On Node 22.22.2, 24.20.0, 26.8.2, installed clients passed 129 cross-version calls and 6 signed-fixture
cases. Both managed native cases used the measured tarball, SHA-256
`580e41c90245af236df32d908ea4387996a8261f02f6dbf5ea5da380f8c087bb`. The first two-worker run found zero
invocation-counter entries at the observation interruption. The isolated case and the full one-worker rerun passed on
the same commit. The first run didn't retain the child's transport status. On Node 26.8.2, the host check accepted two
environment configurations and refused six unsupported configurations. An older run kept its recorded state after
dispatch refused its unsupported setting. The signed producer launched once, admitted one result and returned it on
replay. Host proof SHA-256 `74fc0364ebdf81a7d188c0e40240288485cc395dbf55bd5e3d6d7f78a86d235d`. Managed hosts accepted an
empty argument list. Both native controls used two measured file arguments. Creation refused three unsupported argument
forms. An operator could still inspect an older run whose arguments prevented execution. That run recorded zero
execution reservations. Five refused operator commands preserved the child and outer database heads. The eligible expiry
replayed with the same result. Expiry packet SHA-256 `56eb411b8e67d818ba72c57b9e77cf88437b1b51539cb690a6a09c625dea3164`.
The packaged CLI admitted one fixture review for a real SHA-256 Git repository and replayed it after reopening.
Independent object hashes matched the accepted base, head and tree. Substituting any one of them left the receipt count
at one and the run at implementing/v3. The fixture used a local status reader with GitHub sensors disabled. Git object
proof SHA-256 `4e777606b30b36dbe07d15b24d1da5c2391b6c23ae8172da63284a6e16325026`. Hosted Qodo run 2091688 at `9b71c05`
listed interpreter finding `e6ee99a6` as pending. Run 2091862 at `ca71357` lists it as implemented.

## Skills To Use

| Stage              | Skills and work                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan and contracts | Use software-build-plan, qodo-get-rules and qodo-codebase-wisdom to check the actual base and applicable rules. Apply producer/consumer coordination and exhaustive enum handling to the subject and its packet.                                                                                                                                     |
| Implementation     | Use tdd and failure-path-testing for public process, reducer, importer and CLI behavior. Use transaction-proof and sqlite-concurrency-hardening for the shared root reader/writer, independent connections and commit cuts. Use workflow-invariants for witness freshness and human authority, and cli-interactive-parity for the installed surface. |
| Delivery           | Use qodo-review and qodo-review-resolver on the complete intended change. Use voice-canon and verify_language.py for the plan, report, PR and evidence summaries.                                                                                                                                                                                    |

Qodo returned ten scoped rules for the external protocol and journal changes. Rules 1060877 and 1060865 require
coordinated producer and consumer validation and exhaustive handling of the frozen result types. Rules 1060879, 1060863,
1060853, 1060851, 1060843, 1060842 and 1060888 apply if a shared field, parameter, alias or configuration name changes.
The A2UI message rule has no applicable message type here. Existing dependency pins and established names carry forward.
Qodo Codebase located request construction and response checking in RunInvariant and root reads, writes and commit
markers in ThreadLoop. The lookup omitted resolved commit IDs. Direct Git reads at the pins below verified those entry
points.
[External checker](https://github.com/nnennandukwe/run-invariant/blob/54be0d2240c44ee11b65d5e278a2cb667ee523b4/src/threadloop/runner.js)
·
[SQLite owner](https://github.com/nnennandukwe/threadloop/blob/50b3aa61f92bbc1e03b3177683e16aa199a3dd7b/src/adapters/fs/gaap-state.ts)

## Scope

Deliver a production-backed external controller subject, all 38 frozen cases, independent SQLite and native failure
proof, the governed completion result, and parity and rollback measurements. Use the accepted graph, ordinary storage
generation, execution and evidence contracts. Preserve the legacy CLI, runner, audit/export bytes, historical graph
bindings and independently owned GAAP, RunInvariant and contracts checkouts. The separately authorized GAAP roadmap owns
GAAP source changes. This build uses the current TypeScript package, existing processes, SQLite and CI.

## Package Layout / File-to-Task Mapping

| Owner                                                                                                                            | Change or call                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/controller-conformance/`                                                                                                | Small subject, build entry and parent-side proof launcher. Ship a reproducible revision-bound artifact via the source checkout. Build with `node scripts/controller-conformance/build.mjs --output NEW_DIRECTORY`. The runner launches `node BUILD/runtime/scripts/executor-contract/subject.mjs conformance`. Sibling identity, manifest and build metadata stay with the parent. Existing CLI contracts keep their own entry points. |
| `src/domain/workflow-controller.ts` and public contracts exports                                                                 | Route normalized graph input to `compileWorkflowProfile(JSON.stringify(input))`, decision input to `selectWorkflowDecision(input)`, and execution inputs to the public execution reducers used by ThreadLoop.                                                                                                                                                                                                                          |
| `src/adapters/fs/gaap-state.ts` and its SQLite root storage                                                                      | Extract the canonical single-row read/write already used by the executor. Share those functions with the case store. Preserve GAAP's root schema, owner checks, commit-generation readback and signature/blob transaction.                                                                                                                                                                                                             |
| `src/services/gaap-executor.ts`, `workflow-evaluation.ts`, `workflow-execution.ts` and workflow stores                           | Exercise the actual launch, signed admission, pure reevaluation and deliberate apply in native and persistence tests. A subject case uses its own frozen authority inputs.                                                                                                                                                                                                                                                             |
| Existing controller, managed execution and store integration tests, `scripts/prove-gaap-goose.{py,ts}`, `scripts/smoke-pack.mjs` | Extend the smallest missing boundary test. Reuse the existing native fixed and `--workflow-run` modes. Package comparisons use physical installs.                                                                                                                                                                                                                                                                                      |
| `docs/pre-rust-readiness.md`, `docs/architecture.md`, `docs/plans/issue-172-controller-conformance-and-parity.md`                | Track the plan, findings, requirement-to-evidence index and measured status. Track the small proof drivers or their equivalent in `scripts/` after review so reproduction works from a clean checkout.                                                                                                                                                                                                                                 |

## Dependencies And Settings

Retain the existing locked Node/TypeScript/npm/SQLite stack. Support Node 22.22.2+, 24.15.0+ in their respective majors,
and Node 26+. Verify each actual runtime and package. Use a fresh bounded directory for each proof and reclaim only its
fixtures. Recheck available disk before installs or native output. Preserve existing caches and worktrees.

| Input                    | Pinned identity                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts                | `v0.1.0` commit `7dcf432bc75a68b5ee803c6ebb7346b6bb417f83`, installed commit `4ed9a94a2a089b9ae950d93297f7a6b9b939d3a6`, common `docs/contracts` tree `ab807daea6e0c81786f92b82fdaad1e50db6418c`.                                                                                                                                                                                                                                                              |
| RunInvariant             | `54be0d2240c44ee11b65d5e278a2cb667ee523b4`. Its `threadloop/pin.json` SHA-256 is `96f21b9265d2045d3e9273d4b53ba24a208a7cd00cff0a2dee9636447b27179f`. Corpus source is ThreadLoop `fde510deca780c7cada8a2e461bd15af0fe4ae88`.                                                                                                                                                                                                                                   |
| Corpus and compatibility | Corpus digest `11620588c6f4b39353ea9f77e361a50b5cb0dc970410b1ac10aa8bef13efad84`. Compatibility digest `9590ab51c9081ee2c43f67c0ed1b3453588acdda0e63f259827625971643eadf`. Verify all eight conformance schemas by name and hash and all 18 domain schemas in the descriptor. Retain inventory, input and fixture digests in the parent packet.                                                                                                                |
| Native binaries          | The #171 managed cases used GAAP `0a82687d6070081e0a5cb613698f0724dc6f00cb` and Goose 1.54.0. The host, attestor and Goose SHA-256 values were `sha256:42305ab1ebed503c68ce6796fe1a9f6a727ca4442809b76c7daa261f124054db`, `sha256:d1ee3ef7e8e40d147d7aec1ff34c1a0af3b11b0618a39a2517f35fd5af10f257` and `sha256:4b8258c24adad9e07957d1dddfc7d965b97883dce2eff64af7e3d3c005655d81`. Recheck the actual binaries and transcript for each applicable native case. |

## Canonical Contracts

### Process and authority

One process reads one bounded canonical UTF-8 JSON request through EOF and emits one canonical response on stdout.
Operational diagnostics use stderr. The protocol is `threadloop.controller-conformance/0.1`, with the frozen request,
response, fixture, canonicalization and digest profiles. Reuse `parseExecutorMessage` and `canonicalExecutorJson` from
the public executor codec, enforce the published closed schemas, recompute `input_digest` and `request_digest`, and
return the request digest, independently measured subject identity, result and recomputed response digest. Malformed
framing, unknown versions, duplicate keys, unexpected fields, mismatched identities or digests fail before dispatch.
Valid transport with an invalid domain document yields its ordered `{code,path,identifier}` diagnostics. The pinned
transport permits 10 seconds, 16 MiB plus one byte on each of stdin and stdout, and 1 MiB on stderr.
[Frozen process contract](https://github.com/nnennandukwe/threadloop-contracts/tree/v0.1.0/docs/contracts/controller-conformance-v0.1)

The parent checks the corpus manifest and expanded input, launches the subject, validates nested identities and compares
the machine result. The subject sees operation and domain input. Case ID and corpus ID serve envelope correlation only.
Retain selection order, including the generally applicable completion-witness ordering in 011 and exhaustive
`AMBIGUOUS_REMEDY` in 024. The harness handles blocked-reason prose and enclosing decision digest according to its
frozen comparison. Preserve the frozen outcomes if an implementation discrepancy appears.

Bundle the subject and embedded wire schemas using a clean exact revision and matching lockfile. The runtime artifact
consists of the ESM bundle and two published GAAP upstream schemas, `agent-run-request.schema.json` and
`terminal-run-receipt.schema.json`, at the module-relative paths used by the codec. Compute each file's hash and length.
Sort by relative path, then hash the UTF-8 canonical JSON array of `{bytes,path,sha256}` entries without a trailing
newline. The operator's identity JSON names subject, version, revision and `artifact_digest`. The subject measures its
own explicit runtime list. Record Node, launcher, sandbox policy and build-input manifest separately. Embed the
published execution-scenario wire schema in the bundle. Dispatch only the operation and domain input. Changing a valid
case label must preserve the domain result. If bundling exposes another runtime file, identify it, measure it and review
the closure before execution.

PR #179's first hosted review identified two installations outside Git's clean-tree check. A local rebuild could use the
same installed packages as the submitted build, and the parent could load the harness's existing dependencies. The
independent proof must stage the exact source revisions, install their lockfiles into fresh directories and use that
harness for inventory, execution and controls. The pinned contracts Git package needs its generated distribution. Build
it from the exact contracts checkout with the contracts lockfile and its tracked build script. Use that output in the
isolated ThreadLoop install. Compare the submitted runtime to the independently built artifact before scoring. Record
all three source revisions, lock identities and the contracts build step. Test this through the proof command with an
inert difference in a disposable installation.
[Hosted finding](https://github.com/nnennandukwe/threadloop/pull/179#discussion_r4658087972)

Use the tested macOS isolated launcher with a fresh per-case scratch directory, explicit runtime reads, restricted
environment, closed inherited file descriptors, confined writes and disabled network. The parent retains the checkouts,
fixtures, shared values, golden vectors, synthetic subject, operator identity and output packet. Recheck the three
runtime files, a kernel-denied read for the fixtures and the five-file negative control after building the final
artifact. Inspect the actual bundler inputs and run controls against existing denied files. At the #170 preflight, four
isolated transport calls compiled graph `22fb31abcf828c86c0c299eed82bc0d196285a62a9875bfd96fa3d5580202234`, selected an
engineering action, returned `AMBIGUOUS_REMEDY`, and reopened a replayed registration. The kernel denied five forbidden
reads. The three-file artifact digest was `ec5902d1c871f206e4ddcd90bc8d8048e2406e381523ae108a92ee8814fe7258`. Full wire
validation, production persistence and the 38-case final artifact still need measurement.

### Frozen case inventory

Each numbered entry is a `case_NNN` from the pinned manifest. This inventory belongs in the plan and parent-side report.
The adapter must remain independent of it.

| Operation               | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graph compilation (3)   | 001 governed PR identity, 002 unreachable terminal, 003 uncontrolled cycle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Decision (25)           | 004 required action, 005 refresh stale evidence, 006 independent proof, 007 review evidence, 008 available transition, 009 human approval, 010 human merge, 011 completion, 012 terminal, 013 stale observation, 014 unsupported capability, 015 waiting, 016 expired claim, 017 unknown execution, 018 setup handoff, 019 repair-budget handoff, 020 human release handoff, 021 publication, 022 admitted repair, 023 commit repaired work, 024 equivalent remedies, 025 mutation after verification, 026 higher-sequence expired proof, 027 reversed receipt arrival, 036 completed Agent Run still needs outer proof and approval. |
| Execution scenario (10) | 028 exact redelivery, 029 competing executor A first, 030 B first, 031 running-claim expiry, 032 late receipt after replacement, 033 unadmitted GAAP report, 034 independent success admission, 035 request identity conflict, 037 same-revision acquisition A first, 038 B first.                                                                                                                                                                                                                                                                                                                                                    |

### Opt-in live governed completion

Use the dedicated small shipping-quote fixture in `nnennandukwe/threadloop`. The Unit 5 delivery tree exceeds the
physical GAAP profile. The measured #171 base contains 434 tracked paths. GAAP checks the full checkout and index within
64 descendants, eight levels and 8,192 bytes per file. Keep code, file modes, caller and test inputs in the measured
fixture. Keep both databases, dependencies and proof outputs outside it.

Submit the prepared route decision inside the owning chat before any new public action. It requests authorization for a
reviewed caller enablement PR from `proof/issue-172-evidence-caller` if needed, the dedicated base
`proof/issue-172-parity-base`, feature `proof/issue-172-shipping-quote`, one fixture PR into that base, one scoped full
Qodo review and bounded signed observations. Identify the author, willing independent GitHub User and their node ID,
dispatcher and merger. The reviewer decides after the actual PR and head exist. A route approval can't supply their
review. Preserve both refs through collection. The operator will retain the approval or refusal with the exact proposed
refs and budget. [Issue #172](https://github.com/nnennandukwe/threadloop/issues/172)

The proposed fixed caller installs at `.github/workflows/issue-172-evidence.yml`, 2,753 bytes, SHA-256
`06d652b423560f20ec4aa91b56e362a9785611a2220e663428f470583cc1e50c`, Git blob `b3f7d34e735db4455eb7b455ed059df8ebbcc7a8`.
Confirm the reviewed default-branch installation and identical base and feature bytes. Its gate and review sensors both
pin `bdf68cc2d3ad915d085aecff47c9181f65fb5205`. Bind both build-signer URIs to those paths and SHA, the GitHub Actions
OIDC issuer and the exact feature-ref caller certificate. Use run `session_wf_issue172_shipping`, gate `shipping_quote`,
command `["python3","-B","-m","unittest","-v","test_shipping"]`, working directory `.` and 30,000 ms timeout. Private
actionlint 1.7.12 accepted the caller. Verify the eight independent quote examples and preserve the test/caller bytes
while committing only the intended changes to `shipping.py`, `terminal.txt` and `mcp.txt`. Before enablement, present
the complete caller bytes with the recorded SHA-256.
[Reviewed reusable workflows](https://github.com/nnennandukwe/threadloop/tree/bdf68cc2d3ad915d085aecff47c9181f65fb5205/.github/workflows)

Bind the real repository, proof base, approved reviewer, setup/2 enrollment, local and independent gate, immutable proof
plan, GAAP host, Qodo reader and `host_producers` declarations. Record actual feature head H, tree, content digest,
effect, claim/Attempt and signed child admission. Collect the fresh local gate and full Qodo review at the enrolled
base, H and tree. Before each dispatch prepare a specific signed observation on the current run and compare its session
ID, prepared receipt ID, plan digest, subject H and gate or PR target to the caller inputs.

The budget allows one gate and up to three review dispatches, eight standard jobs, 570 configured runner-minutes total,
zero new spend. Count failed and uncertain dispatches. Check an uncertain run before retrying. Use one preparation/key
per observation and retain signed packages before expiry. Verify trust, subject, policy, timing and receipts at import.
Present the actual PR URL, H, current gates, findings and authority to the reviewer in this chat. An eligible GitHub
User must approve H. The authorized merger checks the same H and merges into the proof base. After signed observation of
that merge and `merged_at`, decide, explicitly apply completion, and reopen the run. Changed H, expired evidence, budget
exhaustion or a declined review leaves the live row pending. Preserve head H for post-merge collection.

## TDD And BDD Implementation Strategy

1. Start with a failing public request/response test. Compile an independently authored alternate graph. Mutate its
   opaque case ID and reseal the envelope. Check that only the correlation changes. Add one decision at a time,
   including the tie, human handoff and terminal cases.
2. Reproduce the execution boundary with one registration. Persist it, reopen, replay it and inspect the row
   independently. Add a real rejected operation, then an identity conflict, receipt fencing and a racing stale proposal.
   Drive production reducer behavior from normalized input.
3. Run the external suite once the subject handles all three operations. Check that an isolated deliberately wrong
   result is rejected by the parent. Keep mutation controls and oracle files outside the production build.
4. Run the four native paths, persisted interruption checks and installed rollback. Record the same request, Attempt,
   source and lifecycle head from independently reopened stores. Execute authorized live stages as their prerequisites
   become available.

## Component Design

`execution_scenario` has exactly `initial`, `steps`, `admitted_digests` and `projection_snapshot`. Use the unique
supplied digests as a read-only case authority. Preserve step ordering and each original actor, ID, time, context,
expected revision and expected digest. Call `createExecutionJournal` for creation, `applyExecutionOperation` for each
step and `projectExecution` after reopening for final projection. The reducers replay and authenticate the prior data.
Stop on validation diagnostics. Map successful results to the published step fields and projection fields, including
rejected receipts, identity conflicts and all controller execution fields. The ordinary GAAP helper generates IDs and
grants admissions after its own checks. The managed evaluator admits a projection from a physical observation. Both stay
on the production host side.
[Host operations](https://github.com/nnennandukwe/threadloop/blob/50b3aa61f92bbc1e03b3177683e16aa199a3dd7b/src/services/gaap-executor.ts)
·
[Frozen reducers](https://github.com/nnennandukwe/threadloop-contracts/blob/4ed9a94a2a089b9ae950d93297f7a6b9b939d3a6/scripts/execution-contract/model.ts)

Use `readSealedRoot(db): { value: unknown; digest: string }` and `writeSealedRoot(db, value, expectedRowDigest?): void`
inside each owner's synchronous SQLite transaction. The shared read verifies the bytes, row hash and canonical encoding.
A conditional write must update exactly one row. On the host, keep v1/v2 validation, managed owner, root revision fence,
commit marker and blob/receipt/journal admission in the original transaction. The subject creates a private case
database and never dispatches a process. After creation, open a fresh connection per step, use `BEGIN IMMEDIATE`, and
check the returned model `expected_execution_digest` against the loaded journal. The SQLite compare-and-swap uses the
digest of the whole stored row. A model-proposed rejected or conflicting append is durable. Exact replay writes no new
root, event or marker. Return each result after commit. Reopen the final journal for projection under the same case
authority. Create the first row with INSERT. Update the existing row only when its stored digest matches the one read.
Verify that a stale row digest prevents the update using a second connection. The model must still process a stale
operation revision because it records that refusal as an event. Preserve the separate admission sets and operation IDs
for both prescribed arrival orders.

## Failure And Recovery Rules

| Fault or invalid input                                   | Required observation                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unauthorized initial, step or projection input           | Missing exact digest yields the model diagnostic and no unauthorized append. A duplicate admission set fails input validation. For a replay at the next prefix, require its new prefix-specific admission. Removing it yields `UNTRUSTED_EXECUTION_INPUT`. Restoring it returns the original result without a write.                         |
| Storage corruption, stale selection or competing writers | Verify SQLite row hash independently. Resealing the storage row around a changed inner digest still yields `EXECUTION_DIGEST_MISMATCH`. Race two connections against the original domain revision. Where the losing operation is admitted at the winning prefix, expect one grant and one recorded conflict/rejection with the frozen code.  |
| Interrupt at the journal commit boundary                 | Before commit, reopening gives the original root. After commit before response, read back the durable append and require authorized replay. Compare bytes, revision and count. Reclaim only the case directory owned by this trial.                                                                                                          |
| Child or outer response loss                             | Check snapshots at enrollment, start, physical effect, transport observation, signed admission and outer import. A durable start can precede process creation. Compare independent invocation count with claim, Attempt and outer version. Unknown effects remain held. A committed child admission can be imported without executing again. |
| Missing fresh proof, approval or merge                   | Return the guarded refusal or human handoff. Preserve lifecycle state and authenticated evidence. An operator can collect the next eligible proof or prepare a fresh observation within the approved scope.                                                                                                                                  |

## Commit Plan

1. Commit the verified canonical Unit 5 plan before production edits.
2. Commit bounded framing, production dispatch, shared row storage and source-driven red/green tests in coherent slices.
3. Commit reproducible proof tooling and the report, with the complete requirement-to-evidence index and accurate live
   status. Keep external artifact measurements traceable to the code SHA that ran.

## Branch And PR Flow

Use the verified #171 merge as the Unit 5 base in its own issue branch and worktree. Keep all other checkouts, branches
and checkpoints intact. Run repository instructions and host-native checks on the full diff. Qodo Local Review is
eligible given a pushed reviewable base and established access. Pin that merge-base, supply plan, decisions, evidence
and recent work, use fast checkpoints and auto depth for the final complete committed diff. An eligible review service
failure records an outstanding gate. Reproduce and fix supported findings, then re-review the new head. Obtain specific
authorization for any stored dismissal.

Open one PR linked to #172 and #168. Require a completed structured hosted review on the current PR SHA, required CI and
Security, and a final head/tree check before merging with the reviewed SHA. Verify the merged tree and main CI
afterward. Use a non-closing link to #172 while mandatory live proof is pending. The fixture PR has its own destination,
review and same-head merge. The implementation PR may deliver independently verified work while the live acceptance
remains open.

## Test Plan

**Native and external checks.** Use fresh disposable clones of the pinned dependencies. Install their locked packages
and run upstream checks there, then supply those clean clones to the read-only external proof. Set `CONTRACTS` and
`HARNESS` to their absolute paths and `EVIDENCE` to a fresh directory outside the clean ThreadLoop checkout. The parent
invokes RunInvariant, supplies the measured identity, starts each subject in its own scratch directory and retains the
raw and public packets. The measured launcher requires macOS Seatbelt. Its parent has separate deadlines for inventory,
the complete suite and negative controls. After a parent timeout, the launcher reaps its case process before the driver
removes scratch. The proof uses a private npm cache for public registry reads while installing the three locks. An
operator running the proof needs network access to those public dependencies and space for the disposable installs. The
three installs and rebuild fit on a 512 MiB temporary volume on the measured macOS arm64 host.

```bash
npm ci
npm run test:controller
npm run test:controller:deep
VITEST_MAX_WORKERS=2 npm run check
python3 -B -m unittest discover -s tests/proof -v
npm run security:dependencies
git diff --check origin/main...HEAD

(cd "$CONTRACTS" && npm ci && npm run spec:conformance:check && npm run check)
(cd "$HARNESS" && npm ci && npm test && THREADLOOP_CHECKOUT="$CONTRACTS" npm run test:threadloop)
npm run build:controller-subject -- --output "$EVIDENCE/build"
python3 -B scripts/controller-conformance/prove.py --harness "$HARNESS" --contracts "$CONTRACTS" \
  --build "$EVIDENCE/build" --output "$EVIDENCE/controller.json" --raw-output "$EVIDENCE/raw.json"
```

Require exit 0 and packet schema `run-invariant.threadloop-packet/0.1` with `subject_kind: controller`. Check
`conformance.total` and `conformance.passed` equal 38 and `failed`, `nonconforming`, `protocol_error` and
`transport_error` equal zero. Match each row in `conformance.cases` to its frozen ID and operation, and retain the
verified input, request and response digests. Compare the packet’s `source`, `contract` and `subject` with the pinned
corpus, schema and measured artifact. Retain `runner.command`, `runner.limits`, `runner.report_limits` and
`claim_boundary` alongside the packet. Record the runner checkout revision and process exit status separately.
[Packet fields](https://github.com/nnennandukwe/run-invariant/blob/54be0d2240c44ee11b65d5e278a2cb667ee523b4/src/threadloop/runner.js)
·
[Process exit status](https://github.com/nnennandukwe/run-invariant/blob/54be0d2240c44ee11b65d5e278a2cb667ee523b4/src/threadloop/cli.js).
Exercise separate restart/CAS and profile-binding tests through production service and CLI paths. The serial corpus
doesn't race SQLite writers. Verify that the parent reclaims the per-case directory after a timed-out child is killed.
Publish the runner's counts and one row for each of the 38 case IDs with operation, status and measured digests. For
case 024, bind the observed reason to the runner row by matching the original request and response digests and stdout
hash. Keep the raw packet's SHA-256, exit code and measured launcher limits. Omit host paths and unbounded output from
the public packet.

**Four native controls.** Each run gets a fresh output directory. Use the locked GAAP host/attestor, Goose 1.54.0 and
the deterministic local provider.

```bash
export PYTHONDONTWRITEBYTECODE=1
npm run prove:gaap:goose -- --gaap "$GAAP" --goose "$GOOSE" --case allow --output "$EVIDENCE/fixed-allow"
npm run prove:gaap:goose -- --gaap "$GAAP" --goose "$GOOSE" --case bad_patch --output "$EVIDENCE/fixed-bad"
npm run prove:gaap:goose -- --gaap "$GAAP" --goose "$GOOSE" --workflow-run --case allow --output "$EVIDENCE/managed-allow"
npm run prove:gaap:goose -- --gaap "$GAAP" --goose "$GOOSE" --workflow-run --case bad_patch --output "$EVIDENCE/managed-bad"
```

Fixed allow and bad-patch must preserve the legacy outer state at implementing/v2 with signed admission in each case.
Allow projects idle. The admitted unknown outcome requires reconciliation. Managed allow must record a selected request,
one launch and signed admission, then a scoped commit, explicit apply to verifying/v4 and passing local proof at that
commit. Managed bad-patch must record the admitted unknown outcome and refuse advancement at implementing/v3. Check
process, transcript, physical workspace, child and outer records independently. The #171 managed allow and bad-patch
provenance SHA-256 values are `ddc8d71f28d8431bce72bd0de46572fba11ca702d078d17c66075d0eb9dcfc1d` and
`06383e8b219448bd4cb9ffcee97d63acf99c5589f4c25553a6226b8f446fc287`. The fixed allow and bad-patch provenance SHA-256
values are `fa969d1079b1d4648f0f1782aa303d554973ac63bf2bc9759f77cff396bc5f3a` and
`ac21568e1a6cf97cd5857d568fc2d3e5be6ba51a19a0b859ab000db483e7a440`. The locally deterministic cases use fixture trust
and don't supply live human evidence.

**Parity and rollback.** Measure a fresh exact-head TypeScript package and its runtime files, locked dependency blob, OS
and Node. Reconcile each of M003's original 15 command names and generation-1 expectations at
`750ae36b6b7b6ea34081a8c90236d8c95f71b086` with the actual installed interface. Nine names remained at #170. Default v4
then listed 24 commands and opt-in v5 listed 30. Measure the complete #172 CLI, including setup/2 execution and
collection. Check aliases, removed commands, flags/help, text/JSON, error/exit behavior, implicit or ambiguous session
targets, multiple active sessions, captured/editor content, Git filtering, artifact formats, snapshots, reconcile,
daemon disposition, storage and concurrent writes. Preserve the reviewed runner hashes and protocol v4 text/JSON bytes.
Retest v5 discovery, v1/v2 coexistence and predecessor refusals on Node 22/24/26.

Reuse the reviewed #170 rollback tarball `c8c96f8229ee141bfe31b1509440e548aa2fb64b089bd6f44b41016e7e0fe078` and
pre-adoption package `4370cea4a5d7be5e283fcafc09fdce07e37168929db8a1e21448614e79f51bc1`. The historical single-database
packet `3db08ed2a23e9063be041036adf3833dd27e2e06658232f794176e1144d5afbd` compared the old reader to upgraded state,
restored the quiescent backup and reproduced export SHA-256
`8e2a2160fd9ddc471d35e3491199a36880655c1a81a3ed44e57b298ae871a722`. Check generation 7 explicit init, generation 8
additive features and future-generation refusal. Compare database and artifact/export digests as well as logical state.
Account for read-side WAL/SHM files and for all newer writes lost by restoring an older snapshot.

Rerun the two-database rollback from independent quiescent checkpoints and matching source paths. Leave the physical
subject and invocation counter outside the backup. At reviewed head `ca713573e1ffc0c60ad4be34c58638804c65a4c9`, the
held-effect backup was 822,020 bytes. Restored execution stayed at revision 3. The committed child-admission backup was
812,625 bytes. Recovery imported one signed receipt and three blobs at outer execution revision 2→3. Each case recorded
one physical invocation and lifecycle version 3. Both restored pairs reproduced their original file hashes. The #170
client refused five managed workflow probes and both child operations and still read a legacy v1 run. Rollback packet
SHA-256 `4e1f947a71858c92d8baf904ef2ccb6d78527d511711c6ff211289c8cb9f8642`. For Unit 5 use a new exact-SHA package,
integrity/quick checks, completed WAL checkpoints, a 64 MiB cap per backup, an independent reader, and before/after
evidence for both cuts.

**Evidence for the readiness report.** Review and track the parent-side isolation launcher, installed-package comparator
and quiescent rollback driver in the ThreadLoop change. Each driver must accept explicit inputs and reproduce its
measurements from a clean commit. Keep the corpus and parent-side comparisons outside the controller artifact. Record
each M003 command and storage disposition, the proposed live route, its authorization status and the fixed caller’s
measured bytes in the readiness report. Include the 38 sanitized case rows, pins, artifact manifest, parity and rollback
results and native proof digests in the report or a linked CI artifact with its retention and SHA-256. Keep signed
originals in authorized evidence storage and expose the fields needed to verify them. Link reviewed drivers, public
results and durable artifact locations from the tracked evidence index.

For every #110/#85/#168/M003 requirement record expected behavior, observed result, status, source commit/tree,
OS/runtime, package or artifact hash, reproducible command, and durable evidence location. Compare review and merge
trees. A report commit changes its own head. Rerun the external suite, rollback and relevant package/native checks at
the final reviewed SHA. Link that final packet and post-merge result from #172 and the tracker. Preserve historical
receipts and exact pins.

## Definition Of Done

Close #172 and #168 only when all prerequisite units have merged-tree and post-merge proof, the real subject passes all
38 cases, the four native and persistence paths hold, installed parity and both rollback paths are measured, and the
live Workflow Run reaches its guarded completion after current proof, review, eligible same-head human approval and
signed merge observation. Refresh M003's TypeScript baseline and label its Rust migration, cross-language differential,
performance, release packaging, artifact provenance and RC soak as future work. A passed simulated case can't fill a
pending live row.

## Assumptions And Defaults

Proceed with local, read-only dependency and CI work using existing entitlements. Obtain the operator’s decision on
fixture refs, caller enablement, fixture PR, Qodo submission and dispatch budget before starting those live steps. If
the user or eligible reviewer hasn't supplied a necessary decision, finish the independent conformance, native, recovery
and parity work. Publish the accurate pending status, preserve the run and evidence, and leave the prerequisite Goal
open.
