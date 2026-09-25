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

## Collector recipe

The OpenTelemetry Collector `filelog` receiver can consume completed exports. This recipe forwards full canonical
records, not a sanitized viewer projection. Use it only with a destination authorized to receive those payloads;
retaining an export for verification does not itself authorize copying its contents into a generic telemetry backend.

The recipe illustrates transport, not the standardized record shape or privacy projection planned in #88:

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
