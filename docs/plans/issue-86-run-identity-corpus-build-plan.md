# Issue 86 Run Identity and Audit Corpus Build Plan

## Summary

Deliver immutable run attribution and independently verifiable multi-session exports for
[#86](https://github.com/nnennandukwe/threadloop/issues/86), from baseline `91936f8558a1ca82e31b7e20a95bc541a879af88`.
This review unit follows the separate runner naming change. Comparison is per session; external consumers compute
comparisons and metrics. Identity remains descriptive metadata.

## Skills To Use

| Stage        | Skill                                    | Responsibility and evidence                                                                                |
| ------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Context      | `qodo-get-rules`, `qodo-codebase-wisdom` | Preserve consumer fields and inspect the existing export publisher and known coupling.                     |
| Architecture | `workflow-invariants`                    | Keep identity out of every guard and retain lifecycle semantics in regression checks.                      |
| Persistence  | `transaction-proof`                      | Model session-start atomicity and no-overwrite file publication; inject failures around the commit point.  |
| Behavior     | `failure-path-testing`                   | Exercise malformed inputs, mixed legacy coverage, tampering, incomplete files, conflicts, and retry paths. |
| Interface    | `cli-interactive-parity`, `dx-audit`     | Check commands, help, protocol, errors, and docs through actual CLI calls.                                 |
| Review       | `qodo-review`, `qodo-review-resolver`    | Review each testable milestone and the full verified local change, then gate the exact PR head.            |
| Writing      | `voice-canon`                            | Verify authored docs, labels, and delivery text.                                                           |

Qodo Local Review is eligible for the connected repository and pushed baseline. Swift and Python-specific retrieved
rules won't be applied to TypeScript. No dedicated TypeScript skill is available. Repository checks cover the stack;
there's no unrelated code audit or new test framework.

## Scope

In scope: run-descriptor v1 at session start, proof-plan binding observations, corpus v1, standalone verification,
session outcomes, compatibility docs, publication recovery, and tests.

Out of scope: #85 storage redesign, #87 intervention metrics, #88's standard envelope, #77 publication, dashboards, live
telemetry, scheduler wake ingestion, and changes to frozen controller/executor/evidence contracts.

## Package Layout / File-to-Task Mapping

- New `src/domain/run-configuration.ts`: exact descriptor and caller-file shapes.
- New `src/adapters/fs/run-configuration.ts`: capture implementation, proof-plan, and runner snapshot digests.
- `src/services/session-service.ts`, `src/commands/session.ts`: optional startup configuration input.
- `src/adapters/fs/sqlite-store.ts`: retain the descriptor in genesis and read a consistent corpus snapshot.
- New `src/domain/audit-corpus.ts`: deterministic corpus codec, outcome projection, and standalone verification.
- New `src/services/audit-corpus.ts`: repository reads, file verification, and publication orchestration.
- `src/adapters/fs/audit-export.ts`: exclusive publisher and observable cleanup outcomes.
- `src/commands/audit.ts`, `src/cli-program.ts`, `src/contracts/protocol.ts`: additive CLI and protocol surfaces.
- New unit/integration tests: format, publisher failures, attribution, and CLI workflows.
- `docs/observability.md`, `docs/cli.md`: contracts, privacy, and examples.

## Dependencies And Settings

No new dependencies or environment variables. SQLite stays v8, audit events stay v1, and existing protocol component
versions retain their meaning. The descriptor and corpus use separate explicit `/1` schema identities. Frozen contract
assets and their pinned dependency remain unchanged. Use the documented host-native Node/npm toolchain.

## Canonical Contracts

`session start --run-config <file>` optionally reads an exact JSON object with `harness`, nullable `model`,
`proof_plan_path`, and `runner_skill_path`. Relative artifact paths resolve from that file's directory. ThreadLoop
validates and hashes the canonical supplied proof plan and exact runner bytes before session mutation. It derives its
package version, implementation fingerprint, storage version, and protocol component versions from the running code. It
retains digests and opaque caller descriptions, with no local artifact paths or raw runner/proof-plan content.

The caller's supplied plan describes intended configuration. The later authoritative proof-plan binding remains
independent; a recorded binding digest lets a consumer report `matched`, `mismatched`, or `unbound`. A mismatch never
changes a guard. Without caller configuration, new runs record runtime identity and explicitly incomplete attribution.
Old genesis records remain byte-for-byte unchanged and unattributable.

```text
threadloop audit corpus (--session <ids...> | --all) --output <new-file> [--json]
threadloop audit verify-export --input <file> [--root <sha256>] [--json]
```

Corpus v1 is canonical UTF-8 JSONL: one manifest, grouped event records, and a final seal. The manifest lists sorted,
unique session ids, roots, event counts, coverage, descriptors, attribution, and outcomes. Each event retains the exact
canonical event string and its original SHA-256. The seal hashes all preceding bytes. The command also reports the
whole-file SHA-256 for external retention. Standalone verification checks framing, versions, session membership,
canonical bytes, original chains, manifest projections, seal, and an optional external root without opening SQLite.

Per-session outcomes report the last observed state/version, terminal status, time to completion, observed pre-PR
implementation entries, repair entries, setup failures, and gate failures by id. Counts describe covered ledger events.
Wake and stop-only handoff counts are null because the scheduler owns those unrecorded facts. Forward-only legacy
coverage never implies complete session history. Existing `audit export`, `show`, and `verify` shapes remain available.

## TDD And BDD Implementation Strategy

1. Fail startup attribution tests, then capture and atomically retain validated descriptors.
2. Fail standalone new/legacy/mixed corpus tests, then implement the pure codec and consistent SQLite snapshot.
3. Fail CLI export/inspection and publisher fault cases, then wire commands and recovery messages.
4. Exercise unchanged guard, runner, protocol, and packaged-install paths before review.

## Component Design

The domain codec owns format validation and derived outcomes; filesystem adapters own bytes. One SQLite read transaction
selects sessions and their verified chains, so concurrent appends can't mix observations within an export. The
session-start transaction commits task, session, initial entry, and genesis together. Identity is read only by export
code; lifecycle evaluators keep their existing inputs.

The implementation fingerprint covers the running bundle and sibling JavaScript chunks, or source files and the lockfile
in the development path. It's content identity, not a signature or a deployment claim. Caller declarations remain
labeled as declarations. No analytics engine or generic telemetry abstraction enters the domain.

## Failure And Recovery Rules

Canonical state is the durable ledger; owned export state is one new target and its exclusive sibling staging file. The
file commit point is successful `link(staging, target)`. Before that point, failure preserves any existing target. After
that point, cleanup failure returns committed success with a warning and the staging path. Retrying uses a new target; a
conflicting target is preserved. Power-loss durability and automatic orphan discovery aren't promised.

| Phase / operation                      | Failure or race                                            | State and recovery                                                         | Verification                |
| -------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------- |
| Read/parse configuration and artifacts | Missing, malformed, unsupported shape                      | No session mutation; fix the named input and retry                         | Startup integration cases   |
| Session insert transaction             | Genesis insertion fails                                    | Roll back task/session/entry together                                      | SQLite failure injection    |
| Snapshot read/validation               | Empty, missing, corrupt chain; concurrent append           | No export publication; restore trusted ledger or retry a fresh snapshot    | Corpus integration cases    |
| Parent `mkdir`                         | Non-directory or denied write                              | Existing target unchanged; choose a writable directory                     | CLI I/O case                |
| Exclusive staging `open`               | Collision or permission failure                            | Never remove an unowned file                                               | Publisher failpoint case    |
| Staging write / close                  | Partial write or close failure                             | Target absent; remove owned stage or name the recovery artifact            | Publisher failpoint cases   |
| Target `link`                          | Existing target, concurrent publisher, or I/O failure      | Preserve winner/old target; remove only owned stage                        | Race and failure cases      |
| Staging removal after commit           | Cleanup error or interruption                              | Valid committed target remains; report warning / inspect target on restart | Cleanup and inspector cases |
| Export read/parse/verify               | Tamper, missing seal, unknown version, wrong retained root | Preserve file; reject with an actionable error                             | Independent verifier cases  |

Always publish only after validation. Never overwrite a target or delete an unowned stage. Exactly one concurrent
publisher wins. Removal applies only to the transaction's owned stage; user exports have no removal command. A process
interrupted before the link can leave an orphan stage, while the target stays absent. After the link, standalone
verification settles the target's integrity. Regeneration from the same captured events is deterministic.

## Commit Plan

1. `feat(audit): retain immutable declared run configuration`
2. `feat(audit): export and independently verify session corpora`

## Branch And PR Flow

Use `feat/issue-86-run-identity-corpus` from refreshed main, reconciled with the naming unit before review. Keep
behavior and its tests together. Run focused and full checks, commit, and submit context-bearing Qodo checkpoints and
final review against the pushed merge base. Resolve supported findings, reverify, and review the new head. Open a ready
PR with `Closes #86` once all criteria are covered. Require completed hosted review at the exact head, required CI, and
a SHA-guarded merge. Verify merged code and post-merge CI before reconciling the issue.

## Test Plan

Use bounded disposable repositories and teardown, with no live service calls. New and legacy sessions, mixed exports,
immutable attribution, malformed files, wrong roots, dropped/reordered records, changed canonical bytes, manifest and
outcome tampering, terminal and forward-only outcomes, concurrent publication, cleanup failure, and retry will be
tested. Guard tests must prove that caller metadata can't admit proof or authorize lifecycle advancement.

```bash
npm test -- tests/unit/audit-corpus.test.ts tests/unit/audit-export.test.ts tests/integration/audit-corpus.test.ts
npm run check
npm run security:dependencies
git diff --check origin/main...HEAD
```

Final Qodo Local Review will cover all committed changes at the pinned pushed base. Repository CI owns the larger
supported runtime/OS matrix. No production telemetry ingestion or model execution will be claimed.

## Definition Of Done

- New sessions can retain exact runtime, proof-plan, runner, and caller attribution immutably.
- Identity remains outside lifecycle authority, with compatibility regression evidence.
- Mixed-session corpora verify from retained bytes alone, including completeness checks and retained roots.
- Outcome definitions and unknown/partial fields are documented; metrics stay external.
- Existing sessions and exports remain usable without invented identity.
- Required checks and exact-head reviews pass; the delivered change is merged and post-merge CI is observed.

## Assumptions And Defaults

Configuration input is optional to preserve startup compatibility. Full attribution requires caller declarations and
matching recorded proof-plan binding; unbound or mismatched declarations remain visible. No caller can retroactively add
identity to a legacy session. Unknown format versions fail closed. Convention mapping and any viewer projection will be
designed separately under #88.
