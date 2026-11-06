# MCP Deprecation

## Problem
- **YAGNI Violation**: MCP (`llm/mcp.ts`, `llm/tools/mcpTools.ts`) is optional and rarely used.
- **Risk**: Unnecessary complexity without clear user value.

## Impact
- Agents must reason about MCP tool loading, even when unused.
- Maintenance burden for unused code.

## Solution
- Deprecate MCP tool loading.
- Document as experimental in `AGENTS.md`.
- Remove MCP-related code if no users request it.

## Validation
- **Test**: Verify that MCP tools are not loaded by default.
- **Manual**: Confirm that MCP-related errors do not crash turns.

## Files to Modify
- `llm/mcp.ts` (deprecate)
- `llm/tools/mcpTools.ts` (deprecate)
- `AGENTS.md` (document as experimental)