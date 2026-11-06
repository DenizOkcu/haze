# Reasoning Effort Simplification

## Problem
- **KISS Violation**: Reasoning effort resolution is overly complex:
  - Run-scoped override → session per-model → global setting → default.
- **Risk**: Unnecessary complexity for a rarely used feature.

## Impact
- Agents must reason about multiple layers of reasoning effort resolution.

## Solution
- Simplify to global setting + run-scoped override.
- Remove session per-model reasoning effort.

## Validation
- **Test**: Update `tests/llm/client.test.ts` to cover simplified reasoning effort.
- **Manual**: Verify that `/reasoning` command works with simplified logic.

## Files to Modify
- `llm/client.ts` (simplify reasoning effort)
- `core/agent/reasoningPolicy.ts` (simplify)
- `tests/llm/client.test.ts` (update tests)