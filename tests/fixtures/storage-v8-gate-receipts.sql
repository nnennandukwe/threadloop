CREATE TABLE gate_receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      gate_id TEXT NOT NULL,
      plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256) = 64),
      head_before TEXT NOT NULL,
      head_after TEXT NOT NULL,
      result TEXT NOT NULL CHECK(
        result IN (
          'passed', 'failed', 'timed_out', 'aborted', 'invalidated',
          'execution_error', 'cleanup_failed', 'setup_failed'
        )
      ),
      artifact_path TEXT NOT NULL,
      artifact_sha256 TEXT NOT NULL CHECK(length(artifact_sha256) = 64),
      receipt_json TEXT NOT NULL,
      receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256) = 64),
      state_version INTEGER NOT NULL CHECK(state_version >= 0),
      created_at TEXT NOT NULL
    );
