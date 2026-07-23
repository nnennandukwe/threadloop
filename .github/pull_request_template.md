<!-- markdownlint-disable-file MD041 -->

<!--
Thanks for contributing to ThreadLoop.

Before requesting review:
- Read the contribution guide:
  https://github.com/nnennandukwe/threadloop/blob/main/CONTRIBUTING.md
- Link the motivating issue with a closing keyword, for example `Closes #123`.
- Replace or remove all instructional comments.
-->

## Summary

<!-- What changed, and why is this the right change? -->

## Related issue

<!-- Required. Replace the line below with `Closes #123` or another explicit issue link. -->

Closes #

## Changes

<!-- List the meaningful implementation, test, and documentation changes. -->

-

## Impact

<!-- Select every affected contract. -->

- [ ] CLI commands, flags, help text, or exit behavior
- [ ] Machine-readable JSON or protocol output
- [ ] Persisted state, schema, or migration behavior
- [ ] Generated Markdown or review artifacts
- [ ] Git integration, daemon, or reconciliation behavior
- [ ] Installation, packaging, or supported runtimes
- [ ] Documentation only
- [ ] No externally observable behavior

## Validation

<!-- Record the actual outcome. Use "Not run" with a reason when a check does not apply. -->

| Check                                 | Result | Notes |
| ------------------------------------- | ------ | ----- |
| `npm run check`                       |        |       |
| `npm run security:dependencies`       |        |       |
| `git diff --check origin/main...HEAD` |        |       |

## Risk and recovery

<!--
Describe compatibility concerns, migration or rollback needs, and known limitations.
Write "Low risk — ..." when no special recovery step is needed.
-->

## Reviewer guidance

<!-- Point reviewers to the highest-risk decisions, files, or behaviors to verify first. -->

## Checklist

- [ ] The PR is focused on the linked issue and contains no unrelated changes.
- [ ] Tests cover new behavior and important failure paths, or I explained why tests are not needed.
- [ ] CLI help, protocol output, examples, and docs remain aligned where applicable.
- [ ] State or schema changes include compatibility and migration coverage where applicable.
- [ ] User-facing or machine-readable breaking changes are called out explicitly.
- [ ] Logs, fixtures, screenshots, and generated artifacts contain no secrets or sensitive data.
- [ ] The branch is based on the latest `origin/main`.
