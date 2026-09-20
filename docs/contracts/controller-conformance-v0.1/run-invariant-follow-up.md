# Add ThreadLoop Controller Conformance v0.1 support

Status: ready-to-file follow-up specification. This document does not create an issue or implement RunInvariant support.

## Motivation and prerequisites

Reuse RunInvariant's existing external-process harness to evaluate a separate ThreadLoop controller suite. Consume the
accepted artifacts from [ThreadLoop #108](https://github.com/nnennandukwe/threadloop/issues/108), pinned to an immutable
commit and corpus digest. Keep the corpus in ThreadLoop. A complete real controller subject is a separate prerequisite
for reporting real controller conformance; synthetic subjects can validate harness behavior earlier.

Coordinate with [RunInvariant #2](https://github.com/nnennandukwe/run-invariant/issues/2), which owns the distinct GAAP
Agent Run suite and explicitly excludes ThreadLoop lifecycle tests. Do not repurpose that issue or its corpus.

## Required changes

- Add an explicit suite/protocol selection for ThreadLoop without changing existing CLI behavior, frozen GAAP decision
  fixtures, protocol bytes, or evidence packets.
- Consume the published JSON artifacts without importing ThreadLoop's TypeScript modules, npm package, or future Rust
  types. Verify the pinned manifest, compatibility descriptor, fixture inventory, and all digests offline before launch.
- Construct one allowlisted request per case. Never send expected results, titles, rationale, references, coverage
  labels, or recipe instructions to a subject. Retain expectations in the harness.
- Apply ThreadLoop's compact canonical JSON, optional excluded framing LF, independently versioned identities, and
  lowercase hexadecimal SHA-256 conventions. Existing RunInvariant pretty-printed newline-inclusive hashing stays
  frozen.
- Launch the selected executable directly without a shell. Bound execution time, stdin/stdout/stderr, terminate
  timed-out work, and reject nonzero exit, malformed UTF-8, duplicate keys, extra output, truncation, and incomplete
  responses. Document and record runner limits; process isolation is a separate claim.
- Require a harness-pinned subject identity. Validate response/request correlation, domain digests, typed results, and
  the exact comparison projection specified by ThreadLoop. A subject's self-reported revision is not binary attestation.
- Emit a separate packet identifying the subject artifact/revision, runner settings, protocol/schema/canonicalization/
  digest profiles, ThreadLoop source revision, corpus digest, each input/request/response digest, and case results.
  Record transport failures distinctly from valid nonconforming domain results; neither is a pass.

## Acceptance tests

- The existing RunInvariant checks and frozen artifacts remain byte-for-byte unchanged.
- A synthetic conforming subject exercises every operation and expected-result shape; the packet labels it synthetic.
- Test subjects detect expectation leakage, wrong request/subject identity, invalid nested digest, unsupported versions,
  omitted results, extra documents, stderr/stdout overflow, timeouts, and nonzero exits.
- Mutants that admit an untrusted receipt, accept a fenced claim, choose an arbitrary remedy, revive superseded proof,
  overwrite an idempotency conflict, or complete without human authority fail the appropriate frozen cases.
- Corpus tampering, expectation-only changes, membership changes, missing fixtures, and unsupported protocol profiles
  fail before invoking a subject.
- A real TypeScript or Rust controller subject, when available, runs through the same process interface. Report its
  measured result separately from transport tests and synthetic-subject results.

Passing proves only the named executable's behavior on this exact frozen corpus. It does not prove runtime integration,
persistence, crash recovery, model quality, sandbox strength, production safety, certification, deployment, or adoption.
