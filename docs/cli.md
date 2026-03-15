# ThreadLoop CLI

ThreadLoop is a repo-local CLI for preserving task intent, decisions, risks, validation notes, and reviewer guidance while you work.

## Commands

### `threadloop init`
Initializes `.threadloop/` in the current Git repository and ensures `.threadloop/state/` is ignored in the repo's `.gitignore`.

### `threadloop start <title>`
Starts the single active v1 task/session for the repo.

Options:
- `--goal <goal>`: required task goal; prompts if missing
- `--constraint <constraint...>`: one or more constraints to preserve
- `--base <ref>`: Git base ref for comparisons

### `threadloop capture <kind> [text]`
Captures one structured entry for the active session.

Kinds:
- `intent`
- `note`
- `decision`
- `risk`
- `constraint`
- `validation`
- `reviewer_guidance`

Options:
- `--because <reason>`: attach rationale to a decision or note
- `--edit`: open `$EDITOR` for longer capture text

### `threadloop status`
Shows the active task, current Git scope, and entry counts by kind.

### `threadloop artifact generate [kind]`
Renders a Markdown artifact from the active session.

Kinds:
- `change-brief` (default)
- `pr-summary`
- `handoff`

### `threadloop finish`
Marks the current task/session complete and clears active session state.

## Storage

ThreadLoop stores state locally in the repo:

- `.threadloop/config.json`
- `.threadloop/state/state.json`
- `.threadloop/artifacts/*.md`

Recommended default:
- keep `.threadloop/state/` uncommitted
- commit artifacts only when they are useful for review or handoff
