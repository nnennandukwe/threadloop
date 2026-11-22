# ThreadLoop’s TypeScript baseline before Rust

ThreadLoop can bind a Workflow Run to a compiled graph, select its next action and guard the transition that follows.
Managed engineering actions use the GAAP process bridge. A signed child result and a Workflow Run transition have
separate commit points. The live completion proof still needs an independent person's approval and a signed merge
observation at the same reviewed commit. [Runtime issue #172](https://github.com/nnennandukwe/threadloop/issues/172) ·
[Program tracker](https://github.com/nnennandukwe/threadloop/issues/168)

## Requirements and evidence

| Requirement                               | Observed behavior                                                                                                                                                                                                                                                                                                     | Delivery                                                                                                                                                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Additive storage, #85                     | Ordinary gate results use a domain-seeded catalog at storage generation 8. The first compatible write adopts the old layout. Read-only operations leave historical receipt and export bytes intact. Generation 7 requires explicit initialization. Independent SQLite readers and raw inserts check the write guards. | [Storage PR and reviewed plan](https://github.com/nnennandukwe/threadloop/pull/173) · [Main CI](https://github.com/nnennandukwe/threadloop/actions/runs/44950980593)                                                                     |
| Deterministic selection, #110             | The selector derives each of the six outcomes from the canonical input, including ties, outstanding obligations and human handoffs.                                                                                                                                                                                   | [Selector PR](https://github.com/nnennandukwe/threadloop/pull/174) · [Main CI](https://github.com/nnennandukwe/threadloop/actions/runs/44956272381)                                                                                      |
| Durable graph binding and authority, #110 | Create commits the binding and first run version. Decide reads current facts. Apply rechecks evidence and the expected version. Separate processes exercise replay, conflict, interruption and restart.                                                                                                               | [Durable runs PR](https://github.com/nnennandukwe/threadloop/pull/176) · [Process tests](../tests/integration/workflow-store-process.test.ts) · [Main CI](https://github.com/nnennandukwe/threadloop/actions/runs/44961637392)           |
| Bounded external execution, #110          | A selected engineering action produces a claim and Attempt, then one bounded launch. Signed admission commits to the child store. The outer run imports the evidence and reevaluates before a deliberate apply. An uncertain effect holds for reconciliation.                                                         | [Selected execution PR](https://github.com/nnennandukwe/threadloop/pull/177) · [Managed process tests](../tests/integration/workflow-execution.test.ts) · [Main CI](https://github.com/nnennandukwe/threadloop/actions/runs/45016894891) |
| Independent conformance, #110             | A development run passed all 38 frozen cases with the new external subject. The revision-bound packet and isolation controls still need the clean implementation commit.                                                                                                                                              | [Frozen contract](https://github.com/nnennandukwe/threadloop-contracts/blob/v0.1.0/docs/contracts/controller-conformance-v0.1/run-invariant-follow-up.md)                                                                                |
| Governed completion, #110                 | The public fixture route still needs authorization, a willing independent reviewer and the actual review and merge at the subject head. The human handoff remains open.                                                                                                                                               | [Completion criteria](https://github.com/nnennandukwe/threadloop/issues/172)                                                                                                                                                             |
| Rust parity and rollback, M003            | The installed package at the #171 merge lists 24 commands in default v4 and 33 in opt-in v5. Its rollback tests restored the old database and audit exports. Both managed cuts retained one invocation. The final comparison will identify the #172 package by its tarball and CLI hashes.                            | [Original milestone](https://github.com/nnennandukwe/threadloop/milestone/3) · [Reproduction commands](../scripts/pre-rust/README.md)                                                                                                    |

The contracts freeze records the authority model. RunInvariant checks the external subject. ThreadLoop owns runtime
writes. The #86 run identity and #88 read-only audit exports retain their original meaning.
[Authority ADR](adr/0001-sdlc-graph-authority-model.md) ·
[Run identity](https://github.com/nnennandukwe/threadloop/issues/86) ·
[Audit exports](https://github.com/nnennandukwe/threadloop/issues/88)

## Installed command and storage baseline

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

## Rollback boundary

Restore from a quiescent backup taken with both databases checkpointed. Preserve the enrolled subject and its physical
effects. The predecessor can read a v1 run in the same database and refuses operations on a v2 enrollment. Restoring an
earlier snapshot discards later writes. The proof records those writes and checks the restored hashes before recovery.
[Installed comparison and managed rollback](../scripts/pre-rust/README.md)

## What still belongs to Rust

The Rust implementation, TypeScript-versus-Rust comparisons, platform binaries, installers, performance measurements,
release attestation and release-candidate soak belong to M003. This TypeScript baseline supplies inputs to that work.
[Rust planning milestone](https://github.com/nnennandukwe/threadloop/milestone/3)
