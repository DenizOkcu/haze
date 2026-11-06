# Shell Tool Safety Hardening

## Problem
- **Safety Risk**: `core/safety/` blocks secret files and git internals, but:
  - Shell tools are not hard-filtered (only instructed).
  - No runtime enforcement for MCP/LSP.

## Impact
- Inconsistent safety boundaries.

## Solution
- Harden shell tool safety:
  - Block secret paths (e.g., `~/.ssh`) in `shell` tool.
  - Add runtime enforcement for MCP/LSP.

## Validation
- **Test**: Update `tests/core/safety.test.ts` to cover shell tool blocking.
- **Manual**: Verify that `shell` tool blocks secret paths.

## Files to Modify
- `core/tools/shellTool.ts` (add blocking)
- `tests/core/safety.test.ts` (update tests)