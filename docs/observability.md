# Audit export and OpenTelemetry

ThreadLoop's audit ledger is the lifecycle authority. OpenTelemetry is an optional export consumer: it may ship, retain,
and query verified JSONL records, but telemetry input can never authorize or alter a ThreadLoop transition.

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

`audit show` and `audit verify` do not apply lifecycle transitions once schema v6 is active. Use `threadloop init` for
the explicit schema-v7 semantic migration; prior audit events and honest forward-only coverage remain unchanged.

## Collector recipe

The OpenTelemetry Collector `filelog` receiver can consume completed exports:

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
