# Validation Parsing Consolidation

## Problem
- **DRY Violation**: Shell command validation parsing is split between:
  - `core/validation/` (structured validation)
  - `core/shellOutput/` (command-aware reduction)
- **Risk**: Overlap in parsing logic (e.g., `git diff`, `npm test`).

## Impact
- Agents must reason about two separate parsing systems.
- Inconsistent validation results.

## Solution
- Move command-aware parsing to `core/validation/`.
- Deprecate duplicate logic in `core/shellOutput/`.
- Ensure `core/shellOutput/` reuses the centralized logic.

## Validation
- **Test**: Update `tests/core/validationParser.test.ts` to cover shell command parsing.
- **Manual**: Verify that `shell` tool validation is consistent with `core/validation/`.

## Files to Modify
- `core/validation/` (add shell command parsing)
- `core/shellOutput/` (deprecate duplicate logic)
- `tests/core/validationParser.test.ts` (add shell command tests)