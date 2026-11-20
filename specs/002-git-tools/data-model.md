# Data Model: Dedicated Git Tools

Entities are the structured result shapes returned by the git tools (see `contracts/git-tools.md` for exact schemas).

## GitStatusResult

- `branch`: current branch name (or detached HEAD marker)
- `upstream`: upstream branch + ahead/behind counts, when available
- `staged`: list of staged file paths (workspace-relative)
- `unstaged`: list of modified but unstaged file paths
- `untracked`: list of untracked file paths
- Validation: all path lists workspace-relative and stable; empty lists are valid empty results

## GitLogEntry

- `hash`: abbreviated commit hash
- `subject`: commit subject line
- `author`: author name
- `relativeTime`: human relative timestamp (e.g. "2 hours ago")
- Validation: list bounded by `limit` (default ~20); truncation indicator present when more history exists

## GitDiffResult

- `files`: per-file change stats (path, insertions, deletions)
- `patch`: bounded unified diff text (default ~200 lines)
- `truncated`: boolean + narrowing hint (path/range) when the diff was cut
- Validation: patch line count never exceeds the effective bound; `truncated` is always set truthfully

## GitBranchResult

- `current`: current branch
- `local`: list of local branches
- `remotes`: list of remote branches, when available

## Mutation results (stage/commit/branch/rebase/reset)

- `ok`: boolean
- `summary`: compact human-readable outcome (e.g. commit hash + subject, branch created)
- `error`: structured failure with `reasonCode`, `recoverable`, `suggestedNextStep` (via `HazeToolError`/`structuredToolFailure`)
- Validation: destructive/history-rewriting operations only execute on explicit user request; failures are actionable and never raw process dumps

## Common failure envelope

- `reasonCode` (e.g. `not_a_repository`, `outside_workspace`, `git_internals_protected`, `secret_file_protected`)
- `recoverable`: boolean — terminal refusals use `false` so the model does not retry
- `suggestedNextStep`: short recovery hint when retryable
