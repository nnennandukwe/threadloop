# Issue 85 Storage Compatibility Build Plan

## Summary

A scheduler with a reviewed ThreadLoop runner needs to know whether it can safely act on a session. An earlier change to
the list of ordinary gate results required a SQLite table rebuild, a storage version bump and a runner edit. Keep
generation 8 for compatible additions, check what each operation reads and convert the existing ordinary receipt table
once. This delivery starts at `7c54c2bb8055f00736e3b5f6631e9aecbe0fd212` and closes
[#85](https://github.com/nnennandukwe/threadloop/issues/85). Configurable Workflow Runs follow in a separate delivery.

## Skills To Use

| Stage    | Skills                                          | Expected evidence                                                                                                         |
| -------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Contract | qodo-get-rules, qodo-codebase-wisdom            | Apply the program's producer/consumer and enum rules. Compare the pinned writer and reader code with the prior migration. |
| Storage  | transaction-proof, sqlite-concurrency-hardening | Map the commit point and test rollback, restart and independent connections.                                              |
| Behavior | tdd, failure-path-testing                       | Reproduce failures through the public CLI, make each behavior pass and test recoverable refusals.                         |
| Runner   | cli-interactive-parity, voice-canon             | Exercise reviewed and current runner expectations with CLI output. Verify authored guidance.                              |
| Review   | qodo-review, qodo-review-resolver               | Review each finished milestone locally, then verify final local and hosted reviews at the delivered head.                 |

Qodo Local Review is eligible. Qodo can access the pushed repository and its pinned base. The release uses the
repository's existing Node, SQLite, TypeScript and Vitest tooling.

## Scope

Support fresh repositories and recognized generation-8 and generation-7 stores. Keep the current v7 explicit init
boundary. Validate named read capabilities, retain historical runner and audit identities, and document additive versus
breaking storage evolution. Unit 2 owns graph selection. Unit 3 owns optional graph storage.

## Package Layout / File-to-Task Mapping

- `src/adapters/fs/sqlite-store.ts` owns initialization, write transactions and consistent read snapshots. Isolate the
  ordinary receipt adoption in the adapter if needed to share one definition between new and upgraded databases.
- `src/domain/proof.ts` owns the ordered set of ordinary gate results. Keep signed result authority in its own table.
- `src/services/session-service.ts` owns read-only status, next and audit calls and the additive capability projection.
- `.agents/skills/threadloop-runner/SKILL.md`, the CLI and operator guides document the runner gate and operator path.
- `tests/integration/session-gate.test.ts`, session transition and runner integration tests cover production CLI,
  independent SQLite writes, retained bytes, schema validation and replay. Store historical SQL fixture bytes in tests.

## Dependencies And Settings

Keep the npm lockfile, current supported Node versions and SQLite driver. Generation 8 identifies the compatibility
family. Existing commands retain protocol v4. Keep configuration, environment, wake record versions and package entry
points stable.

## Canonical Contracts

1. A change is additive if existing supported operations still return their promised results and stored records retain
   their meaning. A nullable column, independent table, compatible index or new ordinary result can qualify. Changes
   that reinterpret evidence, remove a required shape or change guards require an explicit breaking decision.
2. `session next --json` retains `data.lifecycle.storage_schema_version` and `contract_status`. Add
   `data.lifecycle.storage_capabilities` with `session_next_v1` when the current session-next read contract has been
   validated. Migration-required responses carry no actionable capability. Existing current generation-8 snapshots still
   match the previous runner. The revised runner requires the named capability, current status and the existing
   authority, proof and version fields. A previously recorded runner digest stays bound to its original bytes.
3. Scope schema inspection to named tables, columns and triggers used by the operation. Require stored authority and
   receipt protections for the operations that depend on them. New features explicitly opt into their own checks. Reject
   malformed and future generations before writing. A check for a newer writer-only feature can't invalidate a supported
   read.
4. The ordinary table keeps its structural constraints, uniqueness, FK and update/delete/replace guards. A catalog
   seeded from the domain plus an unconditional insert trigger rejects unknown results even with foreign keys off. An
   additive domain value changes catalog data without rebuilding receipts. Signed gate results stay passed-only.
5. `status`, `next` and audit exports use read-only connections, including while reading a pre-adoption v8 store. A
   compatible writer adopts once automatically. Only explicit init can advance v7. No command rewrites a prior audit,
   signed package, receipt JSON, hash, sequence or run configuration.

## TDD And BDD Implementation Strategy

Start with a session created through the built CLI. Add an unrelated quoted table name, then run session next. The
pinned CLI reports STATE_CORRUPTED despite the legal additive table. Fix operation scoping through the public path. Use
pinned historical receipt DDL to drive the next slices. Exercise an ordinary write on v8, explicit init on v7, raw
writes from a separate connection, byte-identical reads, and an old and new runner consuming the projection. Cover one
behavior at a time. Keep fixture teardown bounded to each test's owned temporary directory.

## Component Design

SQLite owns the atomic adoption. Acquire BEGIN IMMEDIATE and recheck generation, source definition, object ownership,
and whether adoption already committed. A cached writer must see changes relevant to its next operation. Identify the
known legacy receipt schema before removing any object. Preserve compatible extra objects/columns where supported, or
refuse an unrecognized rebuild before modifying them. Leave independently owned features alone.

A fresh database creates the catalog, seeds the domain and installs the receipt table and its validation trigger.
Adopting a known table uses a transaction-owned temporary name, copies explicit fields and sequence numbers, checks row
identity, restores the index and append-only rules, verifies the final shape and commits. Current adopted stores can
extend their catalog idempotently. Rerunning the writer preserves newer compatible data. Readers hold a SQLite snapshot
while checking the shape they consume. The protocol descriptor keeps its existing command list.

## Failure And Recovery Rules

The canonical state is the set of committed schema objects, catalog rows, original receipt rows and related evidence in
state.db. Before COMMIT, independent readers see the old state. After COMMIT they see the complete new shape with the
same evidence. A lost response is recovered by reopening and inspecting the committed shape. There's no external file
publication or cleanup after commit. Normal connection close and process restart must preserve the committed result.

| Operation                                                     | Injected condition                                                                  | Required outcome and recovery                                                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Open and identify                                             | Unsupported generation, malformed metadata or unreadable file                       | Refuse before changing schema or journal settings. Restore the supported source or use its owning build.      |
| Acquire write lock and inspect                                | Two adopters, a competing writer, or a reserved migration name already present      | Recheck after serialization. Keep concurrent rows. Refuse a name collision and preserve it for investigation. |
| Remove known trigger or index                                 | Wrong owner, changed source shape or unexpected additive object                     | Preserve the original. Report which object prevents safe adoption.                                            |
| Rename old receipt table                                      | SQLite DDL error or interruption                                                    | SQLite rolls back the rename and associated object changes. Reopen the original and retry.                    |
| Create catalog, seed values, create table, index and triggers | A statement fails or another object owns the destination                            | Roll back staged tables and catalog data. Inspect the original source and retry after correction.             |
| Copy rows and verify                                          | Invalid stored row, count mismatch or authority validation failure                  | Keep every old row and its ordering. Report the failure before replacing the source.                          |
| Drop the transaction-owned old table                          | Failure before commit, including an interrupted process                             | Restore the complete old shape through SQLite rollback. An independent reader must still accept the original. |
| Commit and reopen                                             | Lost success response or a contender enters after commit                            | Observe one adopted generation and exactly one copy of each row. Retry without issuing another rebuild.       |
| Read or append after adoption                                 | Missing required validation or immutable protection, invalid ordinary/signed result | Reject the relevant operation. Read-only diagnostics preserve bytes. Restore trusted schema before retry.     |

Lifecycle tests cover new creation, pre-adoption inspection, adoption, rerun, unexpected ownership, mid-adoption
rollback, restart, conflict serialization, continued append and inspection of historical exports. Removal applies only
to the transaction-owned intermediate table. This build has no uninstall operation.

## Commit Plan

1. Record the authorized program and this unit's storage contract.
2. Deliver scoped read/runner behavior with CLI regressions and the compatibility guide.
3. Deliver transactional receipt conversion and catalog enforcement with pinned historical and fault cases.

## Branch And PR Flow

Use `feat/issue-85-storage-compatibility` from the pushed base. Keep the original worktree intact. Run focused checks
and the repository suite. Commit scoped changes, submit a fast asynchronous local review at a completed milestone,
collect its result and submit auto-depth final local review against the full diff. Assess findings, reproduce supported
failures and rerun checks and review on changed code. Open one PR with “Closes #85”, retrieve the structured hosted
review at its actual head, verify required checks, merge the reviewed SHA and check merged content and post-merge CI. A
stored dismissal needs the user's authorization for that finding.

## Test Plan

Run `npm ci`, the focused session-gate, session-transition and runner tests, `npm run check`,
`npm run security:dependencies` and `git diff --check origin/main...HEAD`. Exercise the CLI against independent old and
new connections. Verify a future result can be cataloged without a new SQLite schema cookie or table rebuild, and that
unknown results fail on an FK-off connection. Compare stored ordinary/signed records and audit/export payloads across
adoption. Compare the previous reviewed runner's generation-8 requirements with the new capability requirements. Recheck
package smoke, local review at the pinned base and hosted review at the pushed head after repairs.

## Definition Of Done

A current writer adopts supported repositories without operator action, and future compatible additions keep their
receipt table and reviewed consumers working. Generation-7 and unknown inputs follow their documented refusal paths.
Independent reads, write failures and restarts preserve historical evidence. Native checks, final local review, hosted
review, required CI and merged-tree verification have traceable results.

## Assumptions And Defaults

The initial named public capability covers the existing session-next projection. Store compatibility checks stay inside
the adapter. Existing frozen contract artifacts keep their original bytes. The parent program owns later capabilities.
