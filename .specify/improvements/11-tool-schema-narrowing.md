# Tool Schema Narrowing

## Problem
- **KISS Violation**: Some tool schemas (e.g., `subagent`, `lspRenameSymbol`) are overly generic.
- **Risk**: Ambiguous tool behavior.

## Impact
- Agents must reason about overly permissive inputs.

## Solution
- Narrow schemas to enforce stricter inputs:
  - `subagent`: Enforce `mode` and `deliverable`.
  - `lspRenameSymbol`: Enforce workspace confinement.

## Validation
- **Test**: Update `tests/hazeTools/` to cover stricter schemas.
- **Manual**: Verify that tools reject invalid inputs.

## Files to Modify
- `llm/hazeTools.ts` (narrow schemas)
- `tests/hazeTools/` (update tests)