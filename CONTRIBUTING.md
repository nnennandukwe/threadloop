# Contributing to ThreadLoop

Thanks for helping improve ThreadLoop. This guide defines the shared workflow for issues and pull requests so that
proposed changes are reproducible, reviewable, and traceable.

## Before opening an issue

Search [open and closed issues](https://github.com/nnennandukwe/threadloop/issues?q=is%3Aissue) before creating a new
one. Then choose the issue form that matches the request:

- **Bug report** for reproducible incorrect behavior
- **Feature request** for a concrete workflow problem and testable outcome
- **Documentation improvement** for missing, inaccurate, or unclear guidance
- **Usage question** when the [README](README.md), [CLI reference](docs/cli.md), and
  [agent-mode guide](docs/agent-mode.md) do not answer the question

Include the smallest useful reproduction or workflow description. Redact credentials, tokens, private repository
content, and other sensitive data from commands, logs, fixtures, and screenshots.

## Development setup

ThreadLoop requires:

- Node.js 22.13.0 or newer
- npm
- a Git repository

From the repository root:

```bash
npm ci
npm run check
```

`npm ci` installs the repository-managed Git hooks. The full check runs formatting verification, ESLint, Markdownlint,
TypeScript, dead-code analysis, community-file validation, tests, the production build, and the packaged-install smoke
test.

See the [README](README.md) for local `npm link` and packaged-install workflows.

## Branch and issue workflow

Every pull request must trace back to an issue that defines the motivation and acceptance criteria.

1. Start from a clean checkout and update `main`:

   ```bash
   git switch main
   git pull --ff-only origin main
   ```

2. Create a focused branch:

   ```bash
   git switch -c <type>/<short-description>
   ```

   Use a descriptive type such as `feat`, `fix`, `docs`, `test`, or `chore`.

3. Keep the change scoped to the issue. Avoid unrelated formatting or refactors.
4. Rebase or otherwise reconcile the branch with the latest `origin/main` before requesting review.
5. Open the pull request with an explicit closing reference such as `Closes #123`.

For long-running autonomous work, use one task per checkout or Git worktree as described in the
[agent-mode guide](docs/agent-mode.md).

## Implementation expectations

Preserve parity across every contract affected by the change:

- CLI implementation, `--help` output, and the [CLI reference](docs/cli.md)
- text output, JSON output, and the published protocol contract
- persisted state, schema migrations, and compatibility behavior
- generated artifacts and their examples
- package contents and supported Node.js runtimes

Add tests for new behavior and important failure paths. State migrations and compatibility changes should include
focused regression coverage.

## Validation

Run the complete local validation suite from the repository root:

```bash
npm run check
npm run security:dependencies
git diff --check origin/main...HEAD
```

`npm run security:dependencies` blocks high and critical npm advisories. CI also runs OSV-Scanner against the lockfile.
Unlike formatting, linting, and type checking, dependency advisory results can change when vulnerability databases are
updated.

If a check does not apply or cannot run, record that explicitly in the pull request with the reason and any narrower
validation performed. Do not describe a check as passing unless it completed successfully.

## Git hooks

The pre-commit hook rejects whitespace errors and runs only the staged-file checks that apply to the change. TypeScript
or tooling changes also trigger whole-project type and dead-code checks. The pre-push hook runs the test suite and
production build; CI additionally runs the packaged-install smoke test and security jobs.

Hooks are guardrails, not the source of truth. Use `--no-verify` only when a hook itself is broken or the repository is
being bootstrapped, record the reason in the pull request, and run the equivalent commands before review.

## Security exceptions

Do not add blanket vulnerability or secret-scanning baselines. An unavoidable dependency exception must name one
advisory in `osv-scanner.toml`, explain why the vulnerable behavior is unreachable, link a remediation issue, and expire
within 30 days. High or critical advisories must be fixed rather than ignored.

## Pull request quality

Use the pull request template and complete every applicable section. A review-ready pull request:

- explains what changed and why
- links the motivating issue
- distinguishes user-facing, machine-readable, persistence, and packaging impact
- records exact validation results
- calls out compatibility, migration, rollback, and known-risk considerations
- tells reviewers where to focus
- contains no secrets or sensitive repository data

Keep commits organized and scoped so the resulting history is easy to review.
