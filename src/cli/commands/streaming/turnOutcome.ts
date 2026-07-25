import type {TurnStatus} from '../streaming.js';

export function terminalTurnStatus(input: {aborted: boolean; error?: unknown; assistantText: string; sawToolCall: boolean; lastToolOk?: boolean; finishReason?: string; budgetReached?: boolean}): TurnStatus {
  if (input.aborted) return 'aborted';
  if (input.error) return 'failed';
  if (input.lastToolOk === false) return 'failed';
  if (input.budgetReached || input.finishReason === 'length' || input.finishReason === 'error') return 'failed';
  if (input.sawToolCall && input.assistantText.trim().length === 0) return 'failed';
  return input.assistantText.trim().length > 0 ? 'complete' : 'failed';
}
