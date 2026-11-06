# Subagent Profiles Simplification

## Problem
- **YAGNI Violation**: `core/subagent/` supports multiple execution profiles (e.g., `compact`, `escalation`), but only `compact` is used.
- **Risk**: Unused code paths add complexity.

## Impact
- Agents must reason about unused profiles.
- Maintenance burden for unused code.

## Solution
- Simplify to `compact` profile only.
- Remove `escalationModel` unless explicitly requested.

## Validation
- **Test**: Update `tests/core/subagent.test.ts` to cover `compact` profile only.
- **Manual**: Verify that subagent execution works without `escalationModel`.

## Files to Modify
- `core/subagent/` (remove unused profiles)
- `tests/core/subagent.test.ts` (update tests)