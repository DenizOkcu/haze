import {recordGoalContinuation, type TurnExecutionState} from '../../../core/agent/completionController.js';
import type {ToolExecutionBudgetState} from '../../../core/agent/budgets.js';
import type {AttemptRecovery} from './attemptOutcome.js';
import type {TurnExecutionOptions} from '../streaming.js';

/**
 * Recovery-slice admission for the turn loop (extracted from
 * `runAgentTurn`). Length/rescue credits are single-use, so a slice cannot
 * trigger another of the same kind; goal continuation is repeatable but
 * progress-guarded and counts against the shared turn budget.
 */
export function startRecoverySlice(recovery: AttemptRecovery, state: {turnState: TurnExecutionState; sliceBudget: ToolExecutionBudgetState; options: TurnExecutionOptions}, debugLog: (line: string) => void): TurnExecutionOptions {
  if (recovery.kind === 'length') {
    state.turnState.lengthCreditUsed = true;
    state.turnState.lengthRecoveriesAttempted += 1;
  } else if (recovery.kind === 'rescue') {
    state.turnState.rescueUsed = true;
  } else {
    recordGoalContinuation(state.turnState);
  }
  // A new slice gets a fresh execution allowance, clamped once here; the
  // slice budget persists across provider retries within the slice (C2).
  state.sliceBudget.started = 0;
  state.sliceBudget.exceeded = false;
  debugLog(`starting ${recovery.kind} recovery slice: ${recovery.slice.maxSteps} steps / ${recovery.slice.maxToolCalls} tool calls`);
  return {
    ...state.options,
    ephemeralControl: recovery.control,
    recoverySlice: {kind: recovery.kind, maxSteps: recovery.slice.maxSteps, maxToolCalls: recovery.slice.maxToolCalls},
  };
}
