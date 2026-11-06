# Session Persistence Refactor

## Problem
- **DRY Violation**: Session JSONL handling is duplicated in:
  - `core/session/` (durable storage)
  - `cli/chat/sessionRecorder.ts` (UI updates)
- **Risk**: Inconsistent slimming or ordering.

## Impact
- Agents must reason about two separate session persistence systems.
- Bugs in one system may not be fixed in the other.

## Solution
- Let `core/session/` own all JSONL logic (e.g., slimming, ordering).
- Update `cli/chat/sessionRecorder.ts` to delegate to `core/session/`.

## Validation
- **Test**: Update `tests/core/session.test.ts` to cover JSONL slimming and ordering.
- **Manual**: Verify that session persistence works consistently in both interactive and headless modes.

## Files to Modify
- `core/session/` (add JSONL logic)
- `cli/chat/sessionRecorder.ts` (delegate to `core/session/`)
- `tests/core/session.test.ts` (add JSONL tests)