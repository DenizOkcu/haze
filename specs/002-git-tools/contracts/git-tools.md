# Contracts: git tool schemas and result shapes

All tools are registered in `src/llm/hazeTools.ts` via a `gitTools` export from `src/llm/tools/gitTools.ts`. All execute `git` in the workspace repository through `core/process` with bounded output. All results are JSON-serializable and bounded.

## Read-only tools

### `gitStatus`
- Input: none (optional `path` filter)
- Output: `GitStatusResult` — branch, upstream ahead/behind (when available), staged/unstaged/untracked workspace-relative path lists

### `gitLog`
- Input: `limit?` (default ~20, max bounded), `range?` (e.g. `HEAD~5..HEAD`), `path?`
- Output: list of `GitLogEntry` (hash, subject, author, relativeTime) + `truncated` indicator when more history exists

### `gitDiff`
- Input: `path?` (single file or directory), `range?` (commit range), `staged?` (bool), `limit?` (default ~200 lines)
- Output: `GitDiffResult` — per-file stats + bounded patch + `truncated` with narrowing hint

### `gitBranch`
- Input: `remotes?` (bool, include remote branches)
- Output: `GitBranchResult` — current, local[], remotes[]

## Mutating tools (explicit user request required for destructive/history-rewriting actions)

### `gitStage`
- Input: `paths` (string[]), `all?` (bool)
- Output: `ok` + `summary` of staged files

### `gitCommit`
- Input: `message` (string), `all?` (bool, stage modified tracked files first)
- Output: `ok` + commit hash/subject summary

### `gitBranchManage`
- Input: `action` enum (`create` | `delete` | `rename` | `checkout`), `name`, `newName?`/`startPoint?` as applicable
- Output: `ok` + summary

### `gitRebase`, `gitReset`
- Input: required explicit target/mode parameters (e.g. `onto`, `mode` enum `soft`|`mixed`|`hard`)
- Output: `ok` + summary, or structured failure

### `gitFetch`, `gitPull`, `gitClone`
- `gitFetch`: optional configured remote name; updates remote-tracking refs.
- `gitPull`: optional remote name and integration mode (`ff-only` by default, `rebase`, or `merge`).
- `gitClone`: remote HTTPS, SSH, or git URL and new workspace-relative destination; rejects embedded credentials and paths outside the workspace.
- All network operations are bounded and use non-interactive authentication.

## Failure envelope (all tools)

- `reasonCode`: `not_a_repository` | `outside_workspace` | `git_internals_protected` | `secret_file_protected` | `git_error` | ...
- `recoverable`: boolean (`false` for terminal refusals)
- `suggestedNextStep`: present when retryable
- Truncation: every bounded result carries a truthful `truncated` indicator plus narrowing hint
