import {createTurnExecutionState, decideTerminalStatus, normalizeFinishReason, type TurnExecutionState} from '../../../core/agent/completionController.js';
import type {TurnStatus} from '../streaming.js';

/**
 * CLI adapter for the authoritative turn-status decision. The pure policy
 * lives in `core/agent/completionController.ts`; this keeps the single call site
 * in the agent turn (see streaming/AGENTS.md) and preserves the documented
 * field-based signature exercised by `tests/cli/turnOutcome.test.ts`.
 */
export function terminalTurnStatus(input: {aborted: boolean; error?: unknown; assistantText: string; sawToolCall: boolean; lastToolOk?: boolean; finishReason?: string; budgetReached?: boolean; unresolvedToolInputError?: boolean}): TurnStatus {
  void input.error;
  const state: TurnExecutionState = {
    ...createTurnExecutionState(),
    aborted: input.aborted,
    finishCause: normalizeFinishReason(input.finishReason),
  };
  return decideTerminalStatus(
    state,
    {
      sawToolCall: input.sawToolCall,
      assistantText: input.assistantText,
      lastToolOk: input.lastToolOk,
      unresolvedToolInputError: Boolean(input.unresolvedToolInputError),
    },
    Boolean(input.budgetReached),
  );
}
