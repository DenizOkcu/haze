# Transcript Partitioning Removal

## Problem
- **KISS Violation**: `cli/chat/transcriptPartition.ts` partitions transcript into static/dynamic regions, but:
  - Dynamic tail clamping adds complexity.
  - Ink’s overflow fallback already replays the transcript.

## Impact
- Agents must reason about unnecessary logic.

## Solution
- Remove dynamic tail clamping.
- Rely on Ink’s replay for overflow.

## Validation
- **Test**: Update `tests/cli/messages.test.tsx` to cover simplified transcript rendering.
- **Manual**: Verify that transcript rendering works without clamping.

## Files to Modify
- `cli/chat/transcriptPartition.ts` (remove dynamic tail clamping)
- `tests/cli/messages.test.tsx` (update tests)