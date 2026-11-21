# Audit export and OpenTelemetry

**Implemented now:** ThreadLoop applies guarded lifecycle transitions and records their decisions in its durable audit
ledger. A verified export is a read-only projection of that ledger. OpenTelemetry is an optional export consumer;
telemetry input cannot authorize or alter a ThreadLoop transition.

See the [architecture guide](architecture.md) for the lifecycle authority boundary and the distinction between current
exports and planned export alignment in [#88](https://github.com/nnennandukwe/threadloop/issues/88).

## Export

Verify and create a new export:

```bash
threadloop audit export \
  --session "$SESSION_ID" \
  --output ./threadloop-audit.jsonl \
  --json
```

ThreadLoop verifies the complete local chain before export. It writes canonical records shaped as:

```json
{ "event": { "schema_version": 1, "sequence": 1 }, "event_sha256": "0123456789abcdef..." }
```

The command publishes with an exclusive sibling temporary file and refuses to overwrite an existing target. Retain the
reported audit root outside the local database if you need to detect later tail truncation.

`audit show` and `audit verify` never apply lifecycle transitions. Use `threadloop init` for the explicit semantic
migration to the current schema; prior audit events and honest forward-only coverage remain unchanged.

## Attribute a new session

ThreadLoop records a `threadloop.run-configuration/1` descriptor in the immutable `session_started` payload. It derives
its package version, implementation fingerprint, protocol component versions, and storage schema version.
`implementation_scope` identifies which files contributed to the fingerprint. Each scope includes the build's dependency
lock.

| Scope                 | Files covered                                                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source_and_lockfile` | The development checkout's package manifest, lockfile, TypeScript source and JSON resources under `src`.                                                                                              |
| `npm_bundled_files`   | The installed ThreadLoop package manifest, regular files under `dist`, and regular files in the bundled dependency directories listed in the npm lock. Each nested package contributes its own files. |
| `javascript_bundle`   | JavaScript files alongside the running CLI. Standalone builds and installations with missing, relocated or linked bundled dependencies report this narrower scope.                                    |

Compare fingerprints within their recorded scope. The npm package scope uses package-relative paths, so moving the same
intact installation to a different directory preserves its identity. Consumer files, external peers and the Node runtime
are outside these fingerprints. Retain the matching source or distribution separately when you need to reproduce a run.

For caller attribution, provide a JSON file when starting the session:

```json
{
  "harness": "my-harness/revision-123",
  "model": "caller-selected-model/revision-456",
  "proof_plan_path": "./proof-plan.json",
  "runner_skill_path": "./runner/SKILL.md"
}
```

```bash
threadloop session start "Evaluate a guard change" --goal "Exercise the declared task" \
  --run-config ./run-config.json --json
```

Artifact paths resolve from the configuration file's directory. ThreadLoop validates the supplied proof plan, hashes its
canonical JSON, and hashes the exact runner file bytes before creating a session. The descriptor contains digests and
opaque harness/model labels, with no artifact paths or raw plan/runner contents. Use `model: null` when the caller can't
declare a model. Keep secrets, prompts, and personal information out of these labels.

The supplied plan is a caller declaration. The normal `proof_ready` transition independently validates and binds the
authoritative proof plan. Its audit event records the bound digest. Corpus output reports whether that digest matches
the startup declaration (`matched` or `mismatched`). A declaration with no recorded binding digest reports `unbound`. An
unknown declaration reports `unknown`. These fields describe the run. Editing configuration or snapshot files later
can't replace a retained descriptor.

Startup without `--run-config` retains runtime identity with `caller` and both snapshot digests set to null. Corpus
attribution is `runtime_only`. A supplied configuration reports `declared`, which identifies its source without
certifying the caller's harness/model claim or adoption of its runner. Earlier sessions retain their original bytes and
report `legacy_unattributable`. The verifier rejects a startup descriptor on an `audit_activated` record because that
record marks the point where audit coverage began for an existing session.

## Export and independently verify a corpus

```bash
threadloop audit corpus --session "$BASELINE_SESSION" "$CANDIDATE_SESSION" \
  --output ./comparison.jsonl --json
threadloop audit corpus --all --output ./all-sessions.jsonl --json
threadloop audit verify-export --input ./comparison.jsonl --root "$RETAINED_CORPUS_ROOT" --json
```

Choose unique explicit session ids or `--all`. Membership and all selected event prefixes come from one SQLite read
transaction. Active sessions are included as observed snapshots; completion isn't implied. Verification runs outside the
source repository and doesn't need its database. The existing single-session export remains available.

Corpus export and standalone verification accept up to 16 MiB and 32,768 JSONL records per file, including its manifest
and seal. SQLite checks the event count and stored byte lengths in the same snapshot before loading the selection. The
encoder counts the final UTF-8 bytes, including JSON escaping and newlines. The verifier reads a regular file within
those limits. If a selection exceeds a limit, export fewer session ids per file. A single session that exceeds a corpus
limit can still use the native single-session export.

The `threadloop.audit-corpus/1` format is canonical UTF-8 JSONL, including a final newline:

1. A `manifest` declares `comparison_unit: "session"` and sorted, unique session summaries with event count, root,
   coverage, run descriptor, attribution, proof-plan binding status, and outcome.
2. Grouped `event` records contain `session_id`, the exact stored canonical event JSON as a string in `canonical_event`,
   and its original `event_sha256`. The digest covers the UTF-8 bytes of that string's value, before JSON string
   escaping.
3. A final `seal` contains session/event counts and `prefix_sha256`, covering every preceding byte including newlines.

`verify-export` checks versions, framing, canonical bytes, each original hash chain, membership, recomputed outcomes,
and the seal. Unknown versions, missing events, changed summaries, reordered records, appended records, and incomplete
files fail verification. The reported `root` hashes the entire file, including the seal. Retain it outside the export to
detect a fully rewritten corpus or a deliberately removed and resealed session. Hashes establish integrity against a
retained root; they aren't signatures or independent proof that the recorded actions occurred.

The verifier checks lifecycle edges against the history each session retained. Older writers allowed a session to move
directly from `verifying` to `reviewing` before the pre-PR review step existed. If auditing began while a session was
blocked, its first resume must return to a state that could've entered `blocked`. Once the export records a block, its
resume must return to that exact prior state. These checks describe the recorded history. ThreadLoop evaluates
transition authority when the session runs. Each applied transition identifies its request digest and transition id.
Only the recorded move from `framed` to `proof_ready` can supply a bound plan digest. Local receipt counts require a
receipt id and digest, gate id, Git head and recognized gate result at the session's observed verifying state.

The comparison unit is one session, identified by its session id. Task ids or caller labels can support an external
consumer's pairing policy, but ThreadLoop doesn't assume that two sessions performed equivalent tasks. Metric
computation, grouping, baselines, denominators, and outcome comparisons belong to that consumer.

| Outcome field                               | Meaning                                                                                                                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`, `state_version`, `terminal`        | Last covered lifecycle state/version; only `completed` is terminal.                                                                                   |
| `started_at`, `observed_at`, `completed_at` | Session genesis, last covered event, and recorded completion; unavailable times are null.                                                             |
| `wall_clock_to_completed_ms`                | Nonnegative difference between full session genesis and completion; otherwise null, including a backward clock.                                       |
| `pre_pr_implementation_entries`             | Entries into `implementing` before the first post-PR state, including the first entry; null for forward-only coverage whose earlier phase is unknown. |
| `repair_entries_consumed`                   | Covered transitions into `repairing` from a repair-eligible state, matching the lifecycle budget rule.                                                |
| `setup_failed_count`                        | Covered local receipts whose result is `setup_failed`.                                                                                                |
| `gate_failures_by_id`                       | Covered local receipts with other non-`passed` results, counted by gate id.                                                                           |
| `wake_count`, `stop_only_handoff_count`     | Null: scheduler wake and stop-only handoff records aren't in the native ledger.                                                                       |
| `counts_scope`                              | `session` for full coverage; `covered_events` for `schema_v6_forward` coverage.                                                                       |

These observations include failed attempts. Forward-only coverage never supplies an unobserved session start or implies
complete totals. Corpus files can contain repository paths, evidence references, caller labels, and sensitive native
payloads. Retain them only in a destination authorized for those contents.

## Publication and recovery

Exports create an exclusive sibling staging file with mode `0600`. On POSIX filesystems, the creating account can read
and write it, subject to a stricter umask. The filesystem `link` operation publishes that file at a new path without
overwriting an existing target. Concurrent cooperative publishers produce one winner. A write or close failure before
publication leaves the target absent; retries use a new writable path. A cleanup failure after publication is committed
success with a warning naming the retained stage. Inspect the target before removing that stage.

An interrupted process can leave an unpublished staging file or a published target whose response was lost. Use
`verify-export` to inspect a corpus target after restart. Keep an existing target and choose a new filename for another
export. ThreadLoop doesn't scan for orphan stages or promise power-loss durability. The output directory must be trusted
against actors replacing staging paths during publication. Export cleanup removes only its own created stage.

## Collector recipe

The OpenTelemetry Collector `filelog` receiver can consume completed exports. This recipe forwards full canonical
records, not a sanitized viewer projection. Use it only with a destination authorized to receive those payloads;
retaining an export for verification does not itself authorize copying its contents into a generic telemetry backend.

The publisher creates private files. Run the receiver under the account that writes these exports, or give the
authorized Collector account read access to each completed file and search access to its parent directories through your
deployment's access controls. Apply the same access policy to each new rotated file. Confirm the receiver can open one
completed export before enabling the pipeline.

This recipe illustrates the file transport:

```yaml
receivers:
  filelog/threadloop_audit:
    include:
      - /var/log/threadloop/*.jsonl
    start_at: beginning
    include_file_name: true
    operators:
      - type: json_parser
        parse_from: body

processors:
  resource/threadloop_audit:
    attributes:
      - key: service.name
        value: threadloop-audit
        action: upsert

exporters:
  otlp:
    endpoint: ${env:OTEL_EXPORTER_OTLP_ENDPOINT}

service:
  pipelines:
    logs/threadloop_audit:
      receivers: [filelog/threadloop_audit]
      processors: [resource/threadloop_audit]
      exporters: [otlp]
```

Configure the destination and authentication according to the chosen collector deployment. Rotate exports by creating a
new filename; do not modify or append to a published ThreadLoop export.

## Authority boundary

- SQLite stores the append-only audit events and lifecycle state.
- `threadloop audit verify` establishes local chain integrity and can compare a retained external root.
- `threadloop audit export` is a verified projection.
- The Collector and downstream telemetry store are read-only consumers of that projection.
- A dashboard, alert, missing log, or ingested JSONL record is never evidence for a lifecycle transition.

## Planned export alignment

[#88](https://github.com/nnennandukwe/threadloop/issues/88) owns a standardized completed-export envelope and the
privacy boundary for optional viewer projections. Neither that envelope nor a sanitized viewer is implemented here.
Preserve canonical hash-covered records under the controlled verifiable-export contract. A future viewer projection
should expose selected correlation identities, namespaced governance outcomes, and safe evidence references, with raw
content absent by default and provenance/completeness limits visible.

Dashboard deletion, eviction, sampling, and restart must not change the durable ledger, evidence freshness, or lifecycle
state. Trace success and trace identity do not establish evidence admission. This work adds no live telemetry,
dashboard, or authority channel.
