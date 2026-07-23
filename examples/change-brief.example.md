---
kind: change-brief
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

# Add retry logic to job runner

## Summary

Task goal: Reduce transient failure rate. Current Git scope touches 2 file(s).

## Goal and context

- Goal: Reduce transient failure rate
- Constraints: Retry only idempotent jobs; Preserve cancellation behavior
- Started: 2026-03-14T19:00:00.000Z
- Base ref: main

## What changed

- src/job-runner.ts
- tests/job-runner.test.ts

## Key decisions and why

- Retry only idempotent jobs — Non-idempotent replay is unsafe
- Keep exponential backoff bounded — Avoids runaway recovery time

## Risks and follow-ups

- Cancellation edge cases still deserve broader soak coverage

## Validation performed

- Ran targeted tests for retry backoff and cancellation
- Smoke-tested worker shutdown during active retries

## Reviewer guidance

- Focus on idempotency guard and cancellation interaction first

## Git context appendix

- Branch: feat/retry-logic
- Head SHA: abc123
- Diff stats: 2 files, +64 / -12
- Commits since base:
  - abc123 add bounded retry logic to runner
