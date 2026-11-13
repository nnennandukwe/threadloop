# Generated controller histories

ThreadLoop's controller and executor have to reject late claims, duplicate deliveries and stale evidence while keeping
unknown effects visible. This test suite generates operation histories, compares the accepted TypeScript contracts with
an independent model, and checks the implemented GAAP bridge through real processes and SQLite. It addresses
[issue #112](https://github.com/nnennandukwe/threadloop/issues/112).

## Run and replay

```bash
npm ci
npm run test:controller
npm run test:controller:deep
npm run check
npm run security:dependencies
```

The normal `npm test` and `npm run check` paths include the bounded profile, named regressions and executable mutation
checks. The deeper profile's a narrower test command; it doesn't replace `npm run check`. CI runs the bounded profile on
each pull request's supported OS/Node matrix. A separate weekly and manually dispatched workflow runs the deeper profile
on Ubuntu with Node 22.22.2 and a 15-minute job limit.

| Profile    | Contract histories                                     | Maximum steps per history | Process histories                | Maximum process steps |
| ---------- | ------------------------------------------------------ | ------------------------- | -------------------------------- | --------------------- |
| Bounded CI | 24 for each of seeds 112, 106108 and 111112            | 25, including setup       | 6 for each of seeds 112 and 111  | 6                     |
| Deeper     | 128 for each of seeds 112, 106108, 111112 and 20260920 | 69, including setup       | 24 for each of seeds 112 and 111 | 16                    |

Each process history owns one new repository and database, and launches at most one Attempt. Counts bound generated
work; they're not time or coverage guarantees. All histories run without a model provider, remote service or billing.
Contract clock steps use explicit UTC time. Real-process tests use the implemented wall-clock lease with a bounded
history, rather than pretending the bridge has a configurable runtime clock.

Failures shrink through fast-check 4.10.2. The report prints the seed, shrink path, number of shrinks and versioned JSON
history after minimization. Save that history object, or the whole generated-failure JSON envelope, and replay it:

```bash
npm run test:controller:replay -- history.json
npm run test:controller:replay -- --help
```

Replay doesn't need the generator or its seed. Add each fixed counterexample as a named deterministic fixture in
`tests/fixtures/controller-generated/regressions.json`, or as a named process-history fixture when it crosses the
bridge. The failure report's path supports fast-check replay within the pinned generator version; serialized histories
remain the primary replay artifact when the generator changes. A minimized case's minimality is relative to fast-check's
shrinker, rather than an exhaustive proof over every shorter history.

## Independent expectations and actual boundaries

`tests/generated/controller/model.ts` implements the expected state changes without importing the contract validators,
SUT adapter or production runtime. It tracks immutable grant/report identities, current claim generations, Attempt and
effect knowledge, request closure, human reconciliation, conflicts and audit revisions. The adapter imports only
`threadloop-contracts` public entry points and versioned assets from its pinned Git revision. It builds each Action
Request from normalized input and explicit intent; expected decisions and fixture labels aren't passed to the subject.

After every generated operation, the runner compares request status, every claim and Attempt, receipt admission,
conflicts, revision and controller execution projection. It also checks candidate decisions against missing lifecycle
guards. Exact journal redelivery can't append twice. Restart serializes the complete journal and host admission facts,
reloads them, and reconstructs the projection. The authority set's an explicit synthetic host fixture; it isn't proof
that an executor asserted trustworthy evidence.

The operations include acquisition, competing/duplicate delivery, renewal, expiry, replacement, start, release,
cancellation, invalidation, human recovery, request/receipt/operation identity conflict, receipt admission and malformed
input, subject/state/graph/policy/authority/capability drift, human-only requests and terminal input. The contract has
no production controller selector: candidate validation and request construction don't claim to choose or execute the
next Required Action. Execution evidence never changes a Workflow Run's state or state version.

`process-model.ts` independently predicts the implemented one-Attempt bridge. Its adapter invokes the real synthetic
producer as a child process, exercises signed evidence verification and the real SQLite store, and reopens readers
between operations. Generated operations include execution, pre-aborted cancellation, retained-output admission,
inspection, evaluation, repository mutation and restart. Test-only fault rearming exercises a second admission failure
before successful retained-output recovery; it doesn't change runtime authority. Named cases retain real file changes
when a response or receipt publication's lost. Faults cover dispatch before/after commit, response retention before
commit, admission preparation, blob writes, accepted-result insertion and evaluation after committed admission. The
suite checks evidence/journal agreement and refusal to blindly rerun a started Attempt. It doesn't assume blocked or
failed GAAP work left the workspace unchanged.

## Four required unsafe mutants

Each witness first passes against the unmodified pinned subject. The test then copies that package's executable
distribution into a unique owned cache directory, patches exactly one site, and requires the same history to fail. It
removes only its own copy afterward. Source files, installed dependencies and CLI test bundles aren't changed.

| Mutant                       | Unsafe change                                                 | Witness                                                |
| ---------------------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| Stale claim acceptance       | Ignore lease expiry in claim fencing                          | Start, reach lease deadline, submit success            |
| Duplicate advancement        | Append an exact replay as another authoritative journal entry | Admit a receipt, redeliver its operation               |
| Stale receipt acceptance     | Ignore receipt-admission expiry                               | Submit otherwise valid evidence with expired admission |
| Executor-selected transition | Skip graph/guard checks on a proposed transition              | Submit an unsupported completion transition            |

Duplicate advancement here targets the accepted execution journal's revision and append boundary. This implementation
doesn't apply configurable graph transitions, so the suite doesn't claim to mutate an unimplemented lifecycle writer.
The test requires the expected behavioral failure, including the journal validator's duplicate-entry rejection; import,
patch or setup failures don't count as killed mutants.

## Conformance promotion and evidence limits

```bash
npm run test:controller:replay -- history.json --export-conformance scenario.json
```

This command replays a passing controller history and validates its exported input against the published
`controller-conformance-v0.1` execution-scenario schema. The output contains normalized initial context, request,
policy, attempted operation/context pairs, independently modeled host admission digests and the final projection
snapshot. It preserves duplicate and rejected deliveries as inputs. It includes no expected decisions, labels, source
paths or implementation objects. Existing files aren't overwritten.

Promotion still needs independently reviewed expected results and corpus metadata. The v0.1 subject stops at its first
invalid operation; a generated run can continue testing the unchanged state afterward. Curate that prefix when promoting
such a case. This command doesn't rewrite the frozen corpus, manifest or digests. It doesn't read or alter
RunInvariant's independent GAAP decision or runtime corpora.

Property tests supplement process, persistence, crash-recovery and cross-implementation conformance evidence. The
contract histories' filesystem serialization proves replay agreement for those bytes; it doesn't prove atomic runtime
storage. The separate process/SQLite histories cover their named injection boundaries, rather than arbitrary power loss,
hostile filesystem interference, external effect isolation or production certification. They don't implement GAAP
inner-run persistence, automatic recovery, resumable terminal runs, a Rust subject or exactly-once effects.
