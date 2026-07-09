# src/core/tasks/AGENTS.md

Last updated: 2026-07-09 for the 0.8.0 release.

Workspace-local task storage.

## Contract

Maintainability focus:

- Keep task storage deliberately simple and workspace-local; do not add cross-session/global task state without a clear product need.

- Tasks persist to `.haze/tasks.json` under the current workspace using `resolveWorkspacePath`.
- `.haze/` is runtime state and should remain ignored by git.
- The model-facing `writeTasks` tool uses full-replacement semantics: each call supplies the complete desired list.
- IDs and timestamps are generated server-side; do not trust model-supplied IDs.
- Task statuses are `pending`, `in_progress`, and `completed`.
- Loading errors return an empty list rather than crashing the UI.
- `/clear` and new-turn cleanup may clear tasks through this module.

## Tests

Update `tests/core/taskStorage.test.ts` and `tests/llm/tools/taskTool.test.ts` for storage or model-facing task behavior changes.
