# Runtime

This project uses a host-native Node workflow. Run commands directly from the
repository root.

## Prerequisites

- Node 22.5.0 or newer
- npm
- a Git repository

## Running Commands

Typical commands:

```bash
npm ci
npm test
npm run build
npm run smoke:pack
```

## Rules

- Run commands directly on the host from the repository root.
- Prefer the existing npm scripts over ad hoc command variants when they cover
  the task.
- Keep the documented local workflow aligned with `package.json` engines and
  scripts.

## Git Workflow

- When the user introduces a new issue or asks for a new piece of work, start by
  syncing with the remote `main` branch before making changes, unless the user
  explicitly asks for a different base branch or workflow.
- Fetch the latest remote state, update local `main`, and ensure new work starts
  from the latest `origin/main` state. Rebase or otherwise reconcile local
  branch state as needed before starting the new issue.
- Create a fresh branch dedicated to that issue before making code changes. Use
  a branch name that is specific to the issue being solved.
- Keep commits organized and scoped so the resulting history is easy to review.
- When opening a pull request, include an explicit link or closing reference to
  the issue that motivated the work so the PR is traceable to the original
  request.
