---
kind: handoff
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

# Handoff: Add retry logic to job runner

## Current state

- Goal: Reduce transient failure rate
- Branch: feat/retry-logic
- Base ref: main
- Changed files: 2

## Open risks

- Cancellation edge cases still deserve broader soak coverage

## Important notes

- Preserve cancellation behavior across retries

## Validation already done

- Ran targeted tests for retry backoff and cancellation

## Suggested reviewer/operator focus

- Focus on idempotency guard and cancellation interaction first

## Git context appendix

- Branch: feat/retry-logic
- Head SHA: abc123
- Diff stats: 2 files, +64 / -12
- Commits since base:
  - abc123 add bounded retry logic to runner
