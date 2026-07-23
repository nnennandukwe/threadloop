---
kind: pr-summary
task_id: task_example
session_id: session_example
generated_at: 2026-03-14T20:00:00.000Z
branch: feat/retry-logic
base_ref: main
head_sha: abc123
changed_files:
  - src/job-runner.ts
  - tests/job-runner.test.ts
---

# PR Summary: Add retry logic to job runner

## Summary

Reduce transient failure rate

## Changes in scope

- src/job-runner.ts
- tests/job-runner.test.ts

## Key decisions

- Retry only idempotent jobs — Non-idempotent replay is unsafe

## Validation

- Ran targeted tests for retry backoff and cancellation

## Reviewer guidance

- Focus on idempotency guard and cancellation interaction first
