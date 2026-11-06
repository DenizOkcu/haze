# Large File Split

## Problem
- **Maintainability Risk**: Large orchestration files violate the "900-line split rule":
  - `cli/commands/chat.tsx` (1,200+ lines)
  - `core/agent/runAgentGoal.ts` (900+ lines)

## Impact
- High context load for agents.
- Hard to navigate and debug.

## Solution
- Split into smaller modules:
  - `chat.tsx` → `chat/turnLifecycle.ts`, `chat/sessionLifecycle.ts`
  - `runAgentGoal.ts` → `agent/toolLoop.ts`, `agent/goalPolicy.ts`

## Validation
- **Test**: Update tests to cover split modules.
- **Manual**: Verify that chat and goal execution work after splitting.

## Files to Modify
- `cli/commands/chat.tsx` (split)
- `core/agent/runAgentGoal.ts` (split)
- `tests/cli/chat.test.tsx` (update tests)
- `tests/core/agent.test.ts` (update tests)