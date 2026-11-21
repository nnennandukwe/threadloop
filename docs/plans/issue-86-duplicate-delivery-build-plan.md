# Issue 86 Duplicate Delivery Naming Build Plan

## Summary

Rename the scheduler's duplicate-delivery mode under [#86](https://github.com/nnennandukwe/threadloop/issues/86),
starting at `91936f8558a1ca82e31b7e20a95bc541a879af88`. This review unit changes runner instructions and documentation.
The scheduler retains ownership of wake records and serialization.

## Skills To Use

| Stage     | Skill                                    | Responsibility and evidence                                                             |
| --------- | ---------------------------------------- | --------------------------------------------------------------------------------------- |
| Context   | `qodo-get-rules`, `qodo-codebase-wisdom` | Preserve consumer compatibility; inspect known workflow coupling.                       |
| Interface | `cli-interactive-parity`, `dx-audit`     | Check inputs, retained records, retry guidance, and docs together.                      |
| Behavior  | `failure-path-testing`                   | Exercise duplicates, changed request rejection, and racing transitions through the CLI. |
| Review    | `qodo-review`, `qodo-review-resolver`    | Review the full local change and current PR head.                                       |
| Writing   | `voice-canon`                            | Verify authored documentation and delivery text.                                        |

Qodo Local Review is eligible: the connected repository's pushed baseline is available. No TypeScript-specific skill is
available; repository checks cover unchanged implementation. Transaction and lifecycle implementation skills aren't
needed for this naming-only unit.

## Scope

In scope: introduce `duplicate_delivery`, retain `replay` as a deprecated compatibility alias, and preserve exact
retained mode bytes during retries. The identity and corpus requirements of #86 belong to the next review unit.

Out of scope: scheduler implementation, trace execution, lifecycle changes, #85 storage, #87 metrics, and #88 envelopes.

## Package Layout / File-to-Task Mapping

- `.agents/skills/threadloop-runner/SKILL.md`: accepted inputs and compatibility.
- `.agents/skills/threadloop-runner/references/wake-record.md`: retained mode vocabulary.
- `docs/agent-mode.md`: scheduler-facing guidance.
- `tests/integration/runner-replay.test.ts`: existing real-interface duplicate and concurrency verification.

## Dependencies And Settings

No dependency, environment, storage, CLI protocol, or frozen contract version changes. New wake records will use v2 only
after scheduler opt-in; existing v1 records will remain supported. Use the host-native workflow in `AGENTS.md` and
`package.json`.

## Canonical Contracts

Runner inputs accept `normal`, `duplicate_delivery`, and the deprecated `replay` alias. The versioned retained record
accepts `normal | replay` in v1 and `normal | duplicate_delivery` in v2. Updated schedulers explicitly opt into v2; old
v1-only consumers continue using v1. All modes select at most one fresh action after validation. Incoming mode bytes
must equal an existing record's mode; changing the spelling for the same wake stops without action. Existing records
retain their version, mode, and four-input interface.

## TDD And BDD Implementation Strategy

This instruction change uses verification-first review of all three affected surfaces, followed by existing integration
cases for exact duplicate results, conflicting request bytes, and concurrent deliveries. Those cases test underlying CLI
idempotency; the repository has no executable scheduler or mode parser. Alias and record-version acceptance will be
reviewed as an instruction contract, with external scheduler execution explicitly unverified. Avoid tests that repeat
docs.

## Component Design

The scheduler owns retained wake identity. Existing CLI behavior and idempotency tables remain unchanged. Qodo found the
signed-chain probe and SignalPay consuming reusable workflows; those workflows don't change. That lookup isn't an
exhaustive scheduler inventory, so the old spelling remains accepted.

## Failure And Recovery Rules

Unknown modes remain invalid. Missing or incomplete retained records stop duplicate processing. Exact retries retain
their original mode and request bytes; callers use the new spelling only for new records.

## Commit Plan

1. `docs(runner): name duplicate delivery without breaking retained wakes`

## Branch And PR Flow

Use `feat/issue-86-audit-corpora` from the refreshed baseline. Commit this unit, run required checks, and attach issue
and compatibility context to final Qodo Local Review against the pinned pushed merge base. Resolve supported findings,
reverify, and review changed work again. Open a ready PR linked to #86 without closing it. Require completed hosted
review at the current head and passing CI. Merge guarded by that SHA and inspect post-merge checks.

## Test Plan

```bash
npm test -- tests/integration/runner-replay.test.ts tests/unit/protocol-contract.test.ts
npm run check
npm run security:dependencies
git diff --check origin/main...HEAD
```

The final local review will cover the complete committed change. Hosted review must cover the exact PR head. No live
model execution or scheduler mutation is required.

## Definition Of Done

- New instructions name the behavior `duplicate_delivery`.
- Old records and exact retry semantics remain supported.
- Duplicate and race cases and required checks pass.
- Local and hosted reviews cover the merged change, with post-merge CI observed.
- #86 remains open for its identity and corpus criteria.

## Assumptions And Defaults

The issue supports a rename. A deprecated alias avoids requiring external scheduler changes. Removing that alias would
require a later compatibility decision and isn't part of this build.
