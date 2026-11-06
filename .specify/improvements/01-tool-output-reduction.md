# Tool Output Reduction Consolidation

## Problem
- **DRY Violation**: `core/shellOutput/` and `core/toolOutput/` both implement output reduction logic (e.g., line clamping, token counting).
- **Risk**: Duplicated logic leads to inconsistencies and higher maintenance burden.

## Impact
- Agents must reason about two separate reduction systems.
- Bugs in one system may not be fixed in the other.

## Solution
- Consolidate all output reduction logic into `core/toolOutput/`.
- Deprecate duplicate logic in `core/shellOutput/` and update callers to use `core/toolOutput/`.
- Ensure `core/shellOutput/` reuses the centralized logic for command-aware reduction.

## ✅ Implementation Progress
- ✅ Consolidated reduction logic into `core/toolOutput/reduction.ts` with `makeStreamReduction` and `passthroughReduction` functions.
- ✅ Updated `core/shellOutput/registry.ts` to use the centralized reduction logic.
- ✅ Updated `llm/tools/outputCap.ts` to use the shared `compactOutput` function.
- ✅ Validated changes with relevant tests.

## Validation
- **Test**: Update `tests/core/toolOutput.test.ts` to cover shell command output reduction.
- **Manual**: Verify that `shell` and `grep` tool outputs are reduced consistently.

## Files Modified
- `core/toolOutput/reduction.ts` (enhanced with shell command reduction)
- `core/shellOutput/registry.ts` (updated to use centralized logic)
- `llm/tools/outputCap.ts` (updated to use shared `compactOutput`)
- Tests pass for `core/toolOutput`, `core/shellOutput`, `hazeTools/shell`, and `hazeTools/grep`.