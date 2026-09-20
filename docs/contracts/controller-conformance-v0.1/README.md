# Controller Conformance Protocol v0.1

Status: contract and internally validated corpus for [#108](https://github.com/nnennandukwe/threadloop/issues/108). The
corpus lives in ThreadLoop. [RunInvariant](https://github.com/nnennandukwe/run-invariant) is the intended external
execution harness; its current release does **not** consume this suite. There is no new process runner, controller
selector, TypeScript runtime subject, or Rust subject in this build.

## Artifacts and development commands

- [Request](schemas/request.schema.json) and [response](schemas/response.schema.json) schemas define the process
  interface.
- [Fixture](schemas/fixture.schema.json), [manifest](schemas/manifest.schema.json), and
  [execution scenario](schemas/execution-scenario.schema.json) schemas define portable test material.
- [Compatibility](compatibility.json) pins the raw bytes of every accepted upstream domain schema.
- [Manifest](manifest.json) identifies all 36 materialized cases, input digests, and complete fixture digests.
- [Golden vectors](vectors/golden.json) and canonical request/response files pin the byte rules independently.
- [Coverage](coverage.md) maps requirements to cases and separates available checks from future proof.
- [RunInvariant follow-up](run-invariant-follow-up.md) is a ready-to-file integration specification, not an opened
  issue.

From the repository root, with the documented Node version and `npm ci` completed:

```bash
npm run spec:conformance:check
npm test -- tests/unit/controller-conformance.test.ts
npm run check
npm run security:dependencies
```

The check command reads committed artifacts, verifies their identities and available semantic checks, and exits nonzero
with the failing case/path and recovery guidance. It writes nothing and executes no external subject. The Vitest suite
runs in the existing CI matrix and adds independent Ajv validation, generated-schema parity, and adversarial tests.

`npm run spec:conformance:schemas` explicitly publishes only schemas. It constructs and validates all schema documents
before writing any output. It never regenerates fixtures, manifests, expectations, or vectors. A filesystem failure
during publication may leave a partial schema update; restore the schema directory or rerun publication before checking.
This command is development tooling, not a transactional runtime writer.

## Independent identities

| Field                    | Exact supported identity                   |
| ------------------------ | ------------------------------------------ |
| Protocol                 | `threadloop.controller-conformance/0.1`    |
| Request schema           | `threadloop.conformance-request/0.1`       |
| Response schema          | `threadloop.conformance-response/0.1`      |
| Fixture format           | `threadloop.conformance-fixture/0.1`       |
| Manifest format          | `threadloop.conformance-manifest/0.1`      |
| Compatibility descriptor | `threadloop.conformance-compatibility/0.1` |
| Canonicalization         | `threadloop.conformance-json/0.1`          |
| Digest profile           | `threadloop.conformance-sha256/0.1`        |

These identities evolve independently. Matching numeric suffixes do not negotiate support. Unknown versions, fields,
operations, result variants, or mismatched digests are rejected; no reader drops fields before hashing. The
compatibility file separately pins graph, controller, execution, and executor `0.1` schemas. A schema-file change
requires an intentional compatibility update and changes corpus identity through `compatibility_digest`.

## One-case process exchange

A future harness starts the executable directly, without a shell, and sends exactly one request on stdin followed by
EOF. The executable writes exactly one response to stdout followed by EOF, sends diagnostics to stderr, and exits zero.
A scenario contains multiple ordered operations, but remains one independently evaluated case. Processes must not share
state between cases. No handshake, environment-derived clock, implicit policy lookup, or provider access is part of this
protocol.

The envelopes are `{ request, request_digest }` and `{ response, response_digest }`. Request payload fields are
explicitly allowlisted: protocol, schema, fixture format, canonicalization, digest profile, corpus digest, opaque case
ID, operation, normalized input, and input digest. Titles, rationale, references, coverage metadata, semantic-check
classifications, Action Intents, and expected results stay in the harness. Digests identify public corpus content; this
is input isolation, not a claim that a malicious subject cannot memorize a public corpus.

Response payload fields are protocol, schema, fixture format, canonicalization, digest profile, exact request digest,
subject identity, and result. The subject declares `name`, `version`, `revision`, and `artifact_digest`. The harness
must pin an expected subject identity independently and compare it exactly; self-declaration is not authentication or
binary attestation. The conformance checker accepts that expected identity explicitly.

Transport failure, timeout, nonzero exit, missing/truncated output, or more than one response must not be interpreted as
a controller decision. The future harness must bound execution time and stderr and record those runner settings in its
packet. This build defines the message limits below but does not implement or certify process isolation or termination.

## Operations and normalized results

### `compile_graph`

Input is the JSON representation of a Workflow Profile; corpus inputs omit author descriptions. YAML parsing is outside
the external interface. The subject applies #104 shape, topology, authority, and normalization rules and returns either
`{ status: "compiled", compiled_graph }` or `{ status: "invalid", diagnostics }`.

Graph identity retains the existing domain hash algorithm. Invalid graph fixtures remain valid protocol inputs: the
request's `input` is bounded JSON, not a promise that the document passes the domain schema being tested.

### `decide`

Input is the complete Controller Input, including its Compiled Graph, explicit observation, history, policy, receipts,
execution projection, known request identities, and evaluation time. Output is `{ status: "decision", decision }` using
the accepted Controller Decision envelope, or input-validation diagnostics. The subject must derive its action; no
proposed decision or selected Action Intent is transmitted.

All six outcomes are represented. A decision only reports a transition or action candidate; it applies no lifecycle
event. The accepted candidate validator proves bindings and prerequisites, not precedence over every alternative. In
particular, `case_024` has two equivalent `run_local_gates` remedies. Its normative `AMBIGUOUS_REMEDY` expectation
requires a future selector. The existing validator still returns `SELECTION_PROOF_REQUIRED`, and coverage explicitly
records that gap.

### `execution_scenario`

Input contains `initial` context/request/policy, ordered `{ context, operation }` steps, `projection_snapshot`, and
`admitted_digests`. Every value is materialized JSON: there are no recipe names, callbacks, fixture-file lookups, hidden
clocks, or dependencies on TypeScript imports. Initial journal creation precedes the supplied steps; exact operation
replays retain the accepted journal semantics. A structural validation failure stops the trace and returns `invalid`. A
rejected or conflicting _operation result_ remains an observed trace step and is processed according to #106.

`admitted_digests` is a closed synthetic host-authority allowlist using the #106 admission preimage. It models facts
supplied by the test host, independently of an executor report. Missing admissions remain untrusted. A real adapter must
never populate a production admission store merely because an executor supplied these JSON fields. Receipt admissions
inside contexts are separately required and checked against their complete bindings.

The `execution` result contains each step's disposition, code, revision, claim, Attempt, and replay flag. Its final
projection contains request status, revision, claim identities/statuses, Attempt identities/statuses/effect classes,
receipt identities/digests/dispositions, conflict identities/digests, and the existing controller execution projection.
This is a deliberate projection schema, not the full journal or every historical field. The request digest retains all
input material. Omitted journal details, actual executor death, persistence, and true concurrent transaction isolation
are not proven by matching this projection.

Competing claims are represented in both serialized arrival orders. An expired claim is not automatically an explicit
evidence invalidation. A fenced late receipt cannot change its replacement Attempt. The GAAP cases use synthetic #107
report evidence and #106 admission semantics; they do not execute GAAP or prove receipt authentication. Completing an
Attempt supplies neither outer proof nor human approval.

## Canonical bytes and digest preimages

Canonicalization reuses the bounded #107 codec internally under its own versioned profile:

- Objects sort keys by UTF-16 code units, including integer-looking keys; arrays retain order.
- Strings preserve well-formed Unicode without normalization and use ECMAScript JSON escaping.
- Numbers are non-negative safe integers, at most `9007199254740991`; floats, negative zero, and unsafe integers fail.
- JSON has no insignificant whitespace. UTF-8 is strict. Duplicate keys, BOM, CRLF, and multiple documents fail.
- Exactly one optional trailing LF is framing and is excluded from canonical content digests.
- Maximum canonical content is 16 MiB, plus that optional LF; maximum nesting is 64 and values one million.
- Object APIs additionally reject accessors, proxies, cycles/shared references, sparse arrays, and non-JSON objects.

Every digest below is SHA-256 over exact canonical UTF-8 bytes, encoded as 64 lowercase hexadecimal characters:

```text
input_digest          = H(C(input))
request_digest        = H(C(request))
response_digest       = H(C(response))
fixture_digest        = H(C(complete fixture, including expectation and metadata))
compatibility_digest  = H(C(complete compatibility descriptor))
corpus_digest         = H(C(manifest payload))
```

Envelope digests are outside their own preimages. The complete wire envelope is also canonical; its payload digest plus
strict envelope shape binds every variable field. Embedded graph, controller, Action Request, execution, and GAAP hashes
retain their accepted algorithms and prefixes. Never recompute them using the new profile as a migration shortcut.

The existing RunInvariant subject protocol uses pretty-printed JSON with a final LF included in its request hash.
ThreadLoop's new profile uses compact JSON and excludes optional framing. RunInvariant must introduce explicit support
for this distinct suite instead of changing its frozen protocol. See the follow-up specification.

## Corpus integrity and comparison

Each fixture has an opaque `case_NNN` identity, operation, literal input, expected result, and harness-only metadata.
Manifest entries sort by case ID and bind its exact `fixtures/case_NNN.json` path, operation, input digest, and complete
fixture digest. Duplicate IDs, path escapes, missing or unlisted files, symlinks, malformed UTF-8, and duplicate JSON
keys fail the development loader/checker. Artifact loading performs no network resolution.

Adding/removing a fixture, changing its ID, input, expectation, or metadata changes the corpus digest. JSON presentation
changes alone do not. Compatibility schema checksums, in contrast, hash literal upstream file bytes. There is no
automatic manifest refresh command: corpus changes require intentional review of expectations and freshly calculated
identities.

Check response framing, versions, declared subject, request binding, and all applicable embedded domain identities
before comparison. Compare result arrays in their specified order. Invalid diagnostics compare their complete machine
triples `code`, `path`, and nullable `identifier`; library-specific prose is absent from that wire result.

Blocked Controller Decision messages and recovery wording are informational. Validate the complete decision digest
first, then exclude only `reasons[*].message`, `reasons[*].recovery`, and their enclosing `decision_digest` for
comparison. All other decision fields, including request contents and digests, remain significant. No recursive
stripping of fields from arbitrary domain data is permitted. Execution results omit human recovery prose by
construction.

Development functions in `scripts/controller-conformance/validation.ts` return `ValidationResult` diagnostics:

```typescript
validateCorpus(manifest, fixturesByPath, compatibility);
buildSubjectRequest(fixture, manifest);
validateSubjectResponse(responseBytes, request, expectedSubject);
compareCaseResult(fixture, manifest, request, responseBytes, expectedSubject);
```

They are not packaged CLI exports and create no state. Comparison additionally binds the complete fixture to the
supplied manifest and request, preventing substitution of a different expectation after request construction. Graph and
execution checks reuse accepted development semantics; decision checks remain candidate validation, never a new
selector.

## Proof boundaries and ownership

CI proves schema consistency, artifact integrity, expectation isolation, and the explicitly available development-model
checks. Synthetic response tests exercise protocol checking with constructed responses. They are not external-subject
results, runtime integration evidence, persistence/crash-recovery proof, certification, or evidence of production
safety. Public hashes and synthetic admission facts are not authentication.

The corpus remains in ThreadLoop until at least a second real implementation or an external governance requirement
justifies extraction. A test double is not that second implementation. Extraction requires a later governance decision
preserving artifact identity and provenance; it is not a prerequisite for this contract.

[#111](https://github.com/nnennandukwe/threadloop/issues/111) owns runtime GAAP integration,
[#112](https://github.com/nnennandukwe/threadloop/issues/112) owns generated state-machine tests, and
[#109](https://github.com/nnennandukwe/threadloop/issues/109) owns broad documentation alignment. Shipped CLI behavior,
SQLite v8, accepted domain golden bytes, and RunInvariant's frozen suite remain unchanged.
