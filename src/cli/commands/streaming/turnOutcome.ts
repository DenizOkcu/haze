import {createTurnExecutionState, decideTerminalStatus, normalizeFinishReason, type TurnExecutionState} from '../../../core/agent/completionController.js';
import type {RequestIntent} from '../../../core/goal/requestClassifier.js';
import type {ValidationOutcome, WorkTaskProgress} from '../../../core/agent/workState.js';
import type {TurnStatus} from '../streaming.js';

/**
 * CLI adapter for the authoritative turn-status decision. The pure policy
 * lives in `core/agent/completionController.ts`; this keeps the single call site
 * in the agent turn (see streaming/AGENTS.md) and preserves the documented
 * field-based signature exercised by `tests/cli/turnOutcome.test.ts`.
 *
 * The optional work-evidence fields (intent, mutation/validation counts, task
 * progress) project the turn-wide `TurnExecutionState`; when omitted, the
 * defaults cannot reject a turn (unknown intent, no mutations, no task list).
 */
export function terminalTurnStatus(input: {aborted: boolean; error?: unknown; assistantText: string; sawToolCall: boolean; lastToolOk?: boolean; finishReason?: string; budgetReached?: boolean; unresolvedToolInputError?: boolean; intent?: RequestIntent; mutationCount?: number; validationOutcome?: ValidationOutcome; taskProgress?: WorkTaskProgress}): TurnStatus {
  void input.error;
  const state: TurnExecutionState = {
    ...createTurnExecutionState(),
    aborted: input.aborted,
    finishCause: normalizeFinishReason(input.finishReason),
    intent: input.intent ?? 'unknown',
    mutationCount: input.mutationCount ?? 0,
    ...(input.validationOutcome ? {validationOutcome: input.validationOutcome} : {}),
    ...(input.taskProgress ? {taskProgress: input.taskProgress} : {}),
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
