# ThreadLoop’s TypeScript baseline before Rust

ThreadLoop can bind a Workflow Run to a compiled graph, select its next action and guard the transition that follows.
Managed engineering actions use the GAAP process bridge. A signed child result and a Workflow Run transition have
separate commit points. The live completion proof still needs an independent person's approval and a signed merge
observation at the same reviewed commit. [Runtime issue #172](https://github.com/nnennandukwe/threadloop/issues/172) ·
[Program tracker](https://github.com/nnennandukwe/threadloop/issues/168)

ThreadLoop commit `80e091c9f6412195a8444f048add977d648c4115`, tree `987ef4aeda6bb371b0c2f476a3dbeae9467d89ec`, produced
the measurements below on macOS arm64. Its bundled tarball has SHA-256
`36f1a69c52e0ae4cc4c4fb7e03c207f30c6391efec12f123581b896df5c6fa51`. The later evidence and review commits can be
verified from the linked implementation issue.
[Measured source](https://github.com/nnennandukwe/threadloop/tree/80e091c9f6412195a8444f048add977d648c4115) ·
[Implementation issue](https://github.com/nnennandukwe/threadloop/issues/172)

At this revision, `npm run check` passed all 952 tests in 77 files, built the CLI and verified the packaged install. The
dependency audit reported zero vulnerabilities. All nine Python proof tests passed. The separate controller suite passed
65 tests. The unit 5 plan links each earlier delivery to its reviewed head, matching merge tree and both post-merge
checks. [Predecessor verification](plans/issue-172-controller-conformance-and-parity.md#summary)

## Requirements and evidence

| Requirement                               | Observed behavior                                                                                                                                                                                                                                                                                                     | Delivery                                                                                                                                                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Additive storage, #85                     | Ordinary gate results use a domain-seeded catalog at storage generation 8. The first compatible write adopts the old layout. Read-only operations leave historical receipt and export bytes intact. Generation 7 requires explicit initialization. Independent SQLite readers and raw inserts check the write guards. | [Storage PR and reviewed plan](https://github.com/nnennandukwe/threadloop/pull/173) · [Main CI](https://github.com/nnennandukwe/threadloop/actions/runs/44950980593)                                                                     |
| Deterministic selection, #110             | The selector derives each of the six outcomes from the canonical input, including ties, outstanding obligations and human handoffs.                                                                                                                                                                                   | [Selector PR](https://github.com/nnennandukwe/threadloop/pull/174) · [Main CI](https://github.com/nnennandukwe/threadloop/actions/runs/44956272381)                                                                                      |
| Durable graph binding and authority, #110 | Create commits the binding and first run version. Decide reads current facts. Apply rechecks evidence and the expected version. Separate processes exercise replay, conflict, interruption and restart.                                                                                                               | [Durable runs PR](https://github.com/nnennandukwe/threadloop/pull/176) · [Process tests](../tests/integration/workflow-store-process.test.ts) · [Main CI](https://github.com/nnennandukwe/threadloop/actions/runs/44961637392)           |
| Bounded external execution, #110          | A selected engineering action produces a claim and Attempt, then one bounded launch. Signed admission commits to the child store. The outer run imports the evidence and reevaluates before a deliberate apply. An uncertain effect holds for reconciliation.                                                         | [Selected execution PR](https://github.com/nnennandukwe/threadloop/pull/177) · [Managed process tests](../tests/integration/workflow-execution.test.ts) · [Main CI](https://github.com/nnennandukwe/threadloop/actions/runs/45016894891) |
| Independent conformance, #110             | The production subject passed all 38 cases. The parent independently matched each case with its request, response and output digests. Six forbidden file reads returned a kernel denial.                                                                                                                              | [38 case results and controls](evidence/issue-172-controller-conformance.json)                                                                                                                                                           |
| Governed completion, #110                 | The public fixture route still needs authorization, a willing independent reviewer and the actual review and merge at the subject head. The human handoff remains open.                                                                                                                                               | [Completion criteria](https://github.com/nnennandukwe/threadloop/issues/172)                                                                                                                                                             |
| Rust parity and rollback, M003            | Three installed Node runtimes agreed on all 33 v5 commands and both v4 outputs. Both old readers reproduced the supported audit history. Quiescent restore and recovery preserved one physical invocation in each managed case.                                                                                       | [Installed CLI](evidence/issue-172-installed-cli.json) · [Restored databases](evidence/issue-172-managed-rollback.json)                                                                                                                  |

The contracts freeze records the authority model. RunInvariant checks the external subject. ThreadLoop owns runtime
writes. The #86 run identity and #88 read-only audit exports retain their original meaning.
[Authority ADR](adr/0001-sdlc-graph-authority-model.md) ·
[Run identity](https://github.com/nnennandukwe/threadloop/issues/86) ·
[Audit exports](https://github.com/nnennandukwe/threadloop/issues/88)

## External controller and native execution

The original measurement below used the installed dependencies in the clean implementation and harness checkouts. Git
verified tracked source and lockfiles. The first proof driver reused those installations for its rebuild and harness
execution. The PR tracks the follow-up measurement against independently installed dependencies.
[Review and follow-up evidence](https://github.com/nnennandukwe/threadloop/pull/179)

RunInvariant `54be0d2240c44ee11b65d5e278a2cb667ee523b4` ran the frozen corpus against the three-file runtime with
artifact digest `d416ec2bbf6fec50c1408c11acd96014bf7ac24f92e88416d9af1feb34c9cfaf`. All three graph compilations, 25
decisions and ten execution scenarios passed. Case 024 returned `blocked` with `AMBIGUOUS_REMEDY`. The parent reproduced
its response hash, changed the case label and obtained the same domain result. The controls detected a wrong answer, a
mismatched response and a timeout. The parent ran
`python3 launch.py CASE_ROOT NODE SUBJECT REQUEST_SCHEMA RECEIPT_SCHEMA conformance` for each case, with a ten-second
deadline. The packet records the exact byte limits, schema hashes, case rows and isolation checks.
[External results](evidence/issue-172-controller-conformance.json) ·
[Reproduction commands](plans/issue-172-controller-conformance-and-parity.md#test-plan)

The serial corpus checks behavior visible over the process protocol. Separate SQLite tests race independent writers,
reopen committed state, kill a worker before and after commit, and recheck authority before replay. The generated deep
suite covered 512 controller histories and 48 process histories. The pinned contracts suite passed 404 tests and its
installed smoke test. RunInvariant passed 95 native tests and 59 ThreadLoop integration tests.
[Commit-cut and writer tests](../tests/integration/controller-execution-scenario.test.ts) ·
[Generated histories](../scripts/controller-generated/deep.ts)

Goose 1.54.0 and GAAP `0a82687d6070081e0a5cb613698f0724dc6f00cb` ran the shipping fixture through the real native
binaries using a deterministic local provider and public fixture signing key. All four cases launched once and produced
one independently verified signed admission.
[Native receipts and package hashes](evidence/issue-172-native-execution.json)

| Run                  | Allowed change                                                                                                                                    | Bad patch                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Managed Workflow Run | The Attempt succeeded. A scoped commit and explicit apply moved the run to `verifying`, version 4. The declared local gate passed at that commit. | The signed outcome recorded an uncertain effect. Apply refused and the run stayed at `implementing`, version 3. |
| Standalone bridge    | The child projected idle. The fixed session stayed at `implementing`, version 2.                                                                  | The child required reconciliation. The fixed session stayed at `implementing`, version 2.                       |

The proposed live proof needs the operator to authorize dedicated proof refs, its fixture PR, a default-branch evidence
caller and a willing independent GitHub reviewer. The caller proposal has SHA-256
`06d652b423560f20ec4aa91b56e362a9785611a2220e663428f470583cc1e50c`. The proposal caps signed collection at four
dispatches with zero additional spend. Completion requires the actual reviewer’s decision and a signed observation of
the merge at that approved head. [Live acceptance](https://github.com/nnennandukwe/threadloop/issues/172)

## Installed command and storage baseline

The original package comparison checked archive bytes against their accompanying provenance files and exercised the
installed commands. Those checks needed an independent source build to establish that each supplied archive came from
its claimed Git revision. PR #179 records the revised archive check and its results.
[Package verification](https://github.com/nnennandukwe/threadloop/pull/179)

The Rust milestone originally pinned 15 commands and storage generation 1 at `750ae36`. Its description says ten error
codes. The source declares nine. The installed comparison exercises all nine through current error paths and records the
current declared set. Successful JSON commands write to stdout. JSON failures write an error envelope to stderr and
exit 1. An empty invocation emits usage on stderr and exits 1.
[Historical CLI](https://github.com/nnennandukwe/threadloop/blob/750ae36b6b7b6ea34081a8c90236d8c95f71b086/src/cli-program.ts)
·
[Historical error codes](https://github.com/nnennandukwe/threadloop/blob/750ae36b6b7b6ea34081a8c90236d8c95f71b086/src/contracts/errors.ts)

| Original commands                                                      | Behavior a replacement needs to preserve                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`, `protocol`                                                     | `init` initializes local storage and reports text. Default and explicit v4 have identical JSON and text bytes. Clients can negotiate v5 to discover the workflow commands.                                       |
| `session start`, `session list`, `session status`, `session capture`   | Two active sessions can coexist. Status and capture require a session ID. Changed-file snapshots honor the base ref and exclude ThreadLoop metadata. Editor input appears in the stored goal or requested entry. |
| `session heartbeat`, `session reconcile`, `artifact generate`          | Reconcile requires a session or `--all`. The three Markdown formats retain their content. An implicit artifact target works with one active session and fails on two.                                            |
| `start`, `capture`, `status`, `finish`, `session finish`, `daemon run` | All six return `INVALID_ARGUMENT`. The supported session commands and guarded transitions own those operations. `daemon` remains a recorded heartbeat source.                                                    |

Current initialization preserves an old JSON file without importing its tasks. The installed reader refuses a
generation-1 SQLite file built from the original bootstrap SQL. On an actual pre-adoption generation-8 store, status,
next and audit export preserve the database and historical audit bytes. The next-action response reports its validated
storage capability. The tested generation-9 store survives both read and initialization refusals.

The installed packages on Node 22.22.2, 24.20.0 and 26.8.2 returned identical help and protocol descriptions. Default v4
lists 24 commands. Opt-in v5 lists 33 and advertises `workflow_runs_v1`, `workflow_gaap_execution_v1` and
`workflow_claim_expiry_v1`. The runtime declares 41 error codes. The recorded runner skill retains its reviewed SHA-256
`fd9fabf1ad27f4b91d1b369b9283200045a1ca54e54d38da014d4f29972cc0dc`. The packet contains the complete help text, protocol
digests and runner revisions. [Installed CLI measurements](evidence/issue-172-installed-cli.json)

## Rollback boundary

Restore from a quiescent backup taken with both databases checkpointed. Preserve the enrolled subject and its physical
effects. The predecessor can read a v1 run in the same database and refuses operations on a v2 enrollment. Restoring an
earlier snapshot discards later writes. The proof records those writes and checks the restored hashes before recovery.
[Installed comparison and managed rollback](../scripts/pre-rust/README.md)

Across all three Node versions, restoring a held physical effect kept outer execution revision 3 at revision 3.
Restoring a committed child admission reimported one signed receipt and three blobs, moving outer execution revision 2
to 3. Both cuts left the Workflow Run at lifecycle version 3. Every restored database matched its recorded file hash and
the producer counter stayed at one. The Node 26 single-store backup also reproduced its database and audit export hashes
with each reader. [Paired rollback results](evidence/issue-172-managed-rollback.json) ·
[Single-store comparison](evidence/issue-172-installed-cli.json)

## What still belongs to Rust

The Rust implementation, TypeScript-versus-Rust comparisons, platform binaries, installers, performance measurements,
release attestation and release-candidate soak belong to M003. This TypeScript baseline supplies inputs to that work.
[Rust planning milestone](https://github.com/nnennandukwe/threadloop/milestone/3)
