# Corpus coverage and proof limits

All fixtures receive schema, canonicalization, manifest, and digest checks. The additional check column describes only
what the existing development tooling can establish. No row represents an external subject run.

| Cases   | Requirement or control                         | Additional available check                                            | Remaining proof                                  |
| ------- | ---------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------ |
| 001     | Valid governed PR graph                        | Exact compilation and graph identity                                  | Runtime use of the compiled graph                |
| 002     | Unreachable terminal                           | Topology rejection                                                    | External compiler behavior                       |
| 003     | Uncontrolled cycle                             | Topology rejection                                                    | External compiler behavior                       |
| 004–023 | Accepted controller examples; all six outcomes | Candidate binding/prerequisite checks                                 | Complete deterministic selection                 |
| 005     | Stale repository receipt                       | Old-subject evidence cannot support the candidate                     | Selection and authenticated admission            |
| 009–011 | Human approval, merge, completion observation  | Human actor and guard bindings                                        | Real human evidence and lifecycle application    |
| 016     | Expired current claim                          | Expiry blocks healthy waiting                                         | Runtime fencing                                  |
| 024     | Ambiguous next action                          | Input/schema/digest checks; two equivalent remedies are explicit      | Selector must prove `AMBIGUOUS_REMEDY`           |
| 025     | Post-verification mutation                     | Subject C requires new proof; B receipts remain historical            | Live mutation observation                        |
| 026–027 | Out-of-order receipts                          | Newest authoritative sequence supersedes an older pass in both orders | Authentic sequence assignment                    |
| 028     | Duplicate Action Request and operation replay  | No new claim or work; replay retains revision                         | Durable deduplication                            |
| 029–030 | Concurrent Execution Claims                    | Both serialized arrival orders retain only the first owner            | Real transaction isolation                       |
| 031     | Expired running Attempt                        | Unknown effect requires reconciliation                                | Executor death and durable recovery              |
| 032     | Replaced claim and late receipt                | Old receipt fenced; replacement remains pending                       | External effect fencing                          |
| 033     | GAAP completion without admission              | Raw success leaves Attempt running                                    | Actual GAAP execution and receipt authentication |
| 034     | Independently admitted success                 | Attempt/request close; controller execution becomes idle              | Separate outer lifecycle evidence                |
| 035     | Changed content under reused identity          | Original request retained; conflict requires reconciliation           | Durable conflict retention                       |
| 036     | Outer state after completed Agent Run          | Missing outer proof still requires collection                         | Full selector and human completion               |

Cases 037–038 add both arrival orders for acquisition proposals prepared against the same revision-zero journal. The
second proposal receives `EXECUTION_VERSION_CONFLICT`; only the first claim/Attempt exists.

## Acceptance mapping

| Issue #108 criterion                                                           | Artifact and automated evidence                                                    |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Language-independent canonical stdin/stdout protocol                           | README operations and process exchange; published request/response schemas         |
| Independently versioned protocol, schemas, fixtures, canonicalization, digests | Identity table; unsupported-version tests                                          |
| Request and response bound to exact canonical content                          | Golden request/response files; frame and digest-tampering tests                    |
| No expected outcomes or titles in subject input                                | Explicit request allowlist; metadata/expectation substitution and isolation tests  |
| Corpus internally validated in CI                                              | Normal Vitest suite through existing CI and `npm run check`                        |
| No language, package-manager, or in-process dependency in the external seam    | Materialized JSON operations; RunInvariant follow-up requires artifact consumption |
| Distinct schema/runtime/persistence/recovery/certification claims              | This table, checker output, README proof limits                                    |
| Manifest records every identity and input digest                               | Manifest schema; exact inventory, missing/extra/duplicate/path tests               |
| Add/remove/change fixture changes corpus digest                                | Complete-fixture hashes in manifest; membership/content mutation tests             |
| Explicit extraction criteria                                                   | README ownership: second real implementation or external governance requirement    |

## Provenance and limits

Cases 001 and 004–023 retain accepted #104/#105 expectations, with the graph embedded into each normalized input. Cases
002–003 and 024–038 were authored from the accepted topology, selection, and execution rules. A one-time independent
Python authoring calculation materialized journal/admission preimages and SHA-256 identities; no ThreadLoop validator
produced their expected answers. Expiry expectations were checked against #106's distinction between claim closure and
explicit evidence invalidation. The reviewed result fields are listed in the protocol's execution projection schema.

Canonical vectors were independently calculated with Python JSON encoding, explicit UTF-16 key ordering, and SHA-256.
The committed tests only compare these artifacts; neither tests nor the schema publisher regenerate them. A corpus
revision requires reviewing the changed normative expectation and recalculating the manifest and affected exchange
vectors explicitly. Existing domain fixtures and canonical files are not rewritten.

Candidate checks are necessary but insufficient for selection. Case 024 deliberately retains `SELECTION_PROOF_REQUIRED`
from the existing validator. Its expected blocked decision is a future subject requirement, not a skipped failing
runtime test. Synthetic response tests exercise the checker with constructed responses and do not constitute evidence
that an executable controller implements this protocol.
