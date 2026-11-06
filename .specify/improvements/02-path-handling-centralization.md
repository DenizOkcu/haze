# Path Handling Centralization

## Problem
- **DRY Violation**: Workspace-relative path resolution is duplicated across:
  - `core/tools/fileTools.ts`
  - `llm/tools/` (LSP, MCP, subagent)
  - `cli/chat/fileMentionSuggestions.ts`
- **Risk**: Inconsistent path normalization or ignore rules.

## Impact
- Agents must reason about multiple path resolution implementations.
- Bugs in one implementation may not be fixed in others.

## Solution
- Centralize path resolution in `utils/path.ts`.
- Add helpers for:
  - Workspace-relative path normalization.
  - `.gitignore` resolution.
  - Secret file blocking.
- Update all callers to use the centralized helpers.

## Validation
- **Test**: Add `tests/utils/path.test.ts` to cover path resolution and ignore rules.
- **Manual**: Verify that `readFile`, `grep`, and `@` completions use the same path logic.

## Files to Modify
- `utils/path.ts` (new file)
- `core/tools/fileTools.ts` (update to use `utils/path.ts`)
- `llm/tools/` (update LSP/MCP/subagent tools)
- `cli/chat/fileMentionSuggestions.ts` (update UI)
- `tests/utils/path.test.ts` (new test file)