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
npm test
npm run build
```

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
npm test
npm run build
npm run smoke:pack
git diff --check origin/main...HEAD
```

If a check does not apply or cannot run, record that explicitly in the pull request with the reason and any narrower
validation performed. Do not describe a check as passing unless it completed successfully.

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
