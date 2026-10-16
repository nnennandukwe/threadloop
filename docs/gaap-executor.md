# GAAP process execution

The optional `threadloop executor` commands run one frozen Controller Contract action through GAAP and independently
verify its signed evidence. They use the TypeScript reference implementation and a separate state database. Existing
fixed-lifecycle sessions and their schema-8 database remain supported.

## Host adoption

A trusted host supplies two JSON files before the executor starts:

- A `threadloop.gaap-binding/1` binding contains the current frozen `ControllerInput`, `ActionRequest`, execution
  policy, mapping policy, full executor parameters, executor identity and lease duration. Registration requires fresh
  idle execution and creates its own claim and pending Attempt. Imported journal authority isn't accepted.
- A `threadloop.gaap-host/1` configuration selects an absolute executable, literal arguments, exact workspace, explicit
  child environment, timeout, Ed25519 signer allowlist and expected implementation identity. Public keys are raw 32-byte
  lowercase hex. Fixture signers aren't trusted by default.

The Workflow policy must already list the exact verification-policy identity computed by `gaapVerificationPolicy`.
Registration doesn't add trust to the accepted action. The state directory must be outside the subject, with no symlink
components. This reference supports POSIX process-group cleanup and a Git repository with an existing commit; its
portable snapshot profile permits 64 descendants, eight levels and 8192 bytes per file. Git's revision must stay
unchanged during an Attempt. Stronger OS confinement belongs to GAAP's isolation work.

```bash
threadloop executor register --state /absolute/state --binding binding.json --config host.json --json
threadloop executor run --state /absolute/state --json
threadloop executor inspect --state /absolute/state --json
```

Registration is an explicit host trust decision. These files aren't a format for importing claims asserted by an
executor or dashboard. The frozen `threadloop-contracts` APIs create and validate the action and execution history; this
bridge doesn't introduce a Rust controller replacement or migrate existing sessions.

## Process and evidence boundary

The selected executable receives one canonical `threadloop.executor/0.1` request on stdin followed by EOF. It returns
one canonical ExecutorResult on stdout, optionally followed by a newline. ThreadLoop passes arguments directly without a
shell and supplies only the configured environment plus `THREADLOOP_GAAP_EVIDENCE_DIRECTORY`.

The host creates that output directory before launch. The producer writes `envelope.json` and digest-only files under
`blobs/`. Receipt locators never select filesystem paths. The bounded reference producer in
`tests/fixtures/gaap-native-producer.ts` composes the official Goose host and public fixture attestor behind this
interface. It's an acceptance fixture, with deliberately public fixture signing; it isn't a production signing service.

A zero exit or a producer's in-memory verification flag doesn't admit evidence. ThreadLoop authenticates the original
DSSE payload, validates the pinned in-toto predicate and all four contract versions, checks the entire mapped request,
effect decisions/results, mutation chain, usage and independently retained content. It observes the physical workspace
and checks the live graph/state/request/claim/Attempt fence before admission. Accepted signed bytes retain their
original encoding; typed contract identities apply the producer's nullable-field defaults.

## Durable state and recovery

The first SQLite commit records a unique launch intent and started Attempt before spawning. Restarting the command can't
repeat that Attempt. Bounded stdout, stderr, signed-envelope bytes and transport diagnostics are retained as
non-authoritative observations, including rejected or uncertain runs.

Admission uses a later transaction to commit checked blobs, original envelope/predicate, independently mapped result,
ReceiptAdmission and the frozen journal update together. A revision change, expired lease, wrong subject, invalid
signature, malformed output or conflicting identity prevents admission. Failed, blocked and interrupted outcomes retain
unknown effect knowledge unless independent recovery establishes more.

Controller evaluation starts after the admission commit. It checks the outgoing transitions against ThreadLoop's current
guards and returns candidates/diagnostics. GAAP completion doesn't change the Workflow Run state or state version. A
post-commit evaluation failure returns `committed_with_warning`; it doesn't roll back accepted evidence or justify
another execution. The inspector rechecks persisted signatures, content identities and journal receipts.

```bash
threadloop executor admit 1 --state /absolute/state --json
threadloop executor evaluate --state /absolute/state --json
```

`admit` retries verification of a retained successful transport without launching. An identical accepted result keeps
its first admission. Changed content under a reused source identity can't overwrite evidence. `evaluate` rechecks
committed state without launching. Neither command renews a claim, creates replacement authority, infers a stopped
executor from an empty response, or silently resumes an authority-required terminal run.

A lost response or publication failure can leave the workspace changed and the Attempt uncertain. Inspect the stored
observation and current workspace before a trusted recovery decision. This initial bridge doesn't add an automatic
retry, state replacement or destructive removal command. Same-user privileged filesystem interference and escaped
process groups aren't claimed OS confinement.

## Reproduce the real Goose acceptance run

Build the official governed Goose host and attestor from the supporting GAAP revision, install the checksum-pinned Goose
1.54.0 executable, and select a new output directory:

```bash
npm run prove:gaap:goose -- --gaap /absolute/gaap --goose /absolute/goose --output /absolute/new-proof
```

The harness owns a new repository and initial commit, a deterministic local provider, and public fixture trust. It
constructs ThreadLoop's action, claim and Attempt before the real run; those mapped IDs enter GAAP before execution. It
doesn't rewrite an earlier receipt. ThreadLoop independently verifies and persists the returned evidence, then checks
that the edited workspace hasn't satisfied its own commit/proof guards or changed lifecycle state. The provider performs
no inference and incurs no external billing. Synthetic process failure tests are labeled separately from this native
execution.

Pass `--case bad_patch` to retain the three executed effects when independent verification blocks completion. ThreadLoop
must admit that terminal evidence as an unknown execution outcome requiring reconciliation, while leaving its own
lifecycle state unchanged.

Evaluation retains the original request `subject` for an unresolved Attempt, while `observed_subject` and `repository`
report the current physical workspace. A failed or uncertain run that changed files therefore requires reconciliation;
it can't evaluate guards using the original clean observation. Success may adopt the resulting subject for evaluation,
but it still can't supply ThreadLoop's own proof or apply a lifecycle transition.
