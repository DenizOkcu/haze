import {MAIN_STEP_LIMIT, MAIN_TOOL_CALL_LIMIT, MAIN_TOOL_ONLY_STEP_LIMIT} from './budgets.js';

/**
 * Turn-wide budget envelope. Values are the existing global limits — recovery
 * slices count against these and must never increase them.
 */
export interface TurnBudget {
  /** Maximum completed model steps across the whole turn (incl. recovery). */
  stepLimit: number;
  /** Maximum completed tool calls across the whole turn (incl. recovery). */
  toolCallLimit: number;
  /** Maximum completed tool-only steps across the whole turn. */
  toolOnlyStepLimit: number;
}

export function mainTurnBudget(): TurnBudget {
  return {stepLimit: MAIN_STEP_LIMIT, toolCallLimit: MAIN_TOOL_CALL_LIMIT, toolOnlyStepLimit: MAIN_TOOL_ONLY_STEP_LIMIT};
}

/** Steps still available to the turn given usage so far (never negative). */
export function remainingSteps(used: number, budget: TurnBudget): number {
  return Math.max(0, budget.stepLimit - used);
}

/** Tool calls still available to the turn given usage so far (never negative). */
export function remainingToolCalls(used: number, budget: TurnBudget): number {
  return Math.max(0, budget.toolCallLimit - used);
}

/** True when adding `extra` tool calls would meet or exceed the call budget. */
export function wouldExceedToolCalls(used: number, extra: number, budget: TurnBudget): boolean {
  return used + extra >= budget.toolCallLimit;
}

/** A recovery slice can only run if at least one step and one tool call remain. */
export function hasUsableBudget(used: {steps: number; toolCalls: number}, budget: TurnBudget): boolean {
  return used.steps < budget.stepLimit && used.toolCalls < budget.toolCallLimit;
}

/** Clamp a requested slice size to what the turn budget actually allows. */
export function clampSlice(requested: {steps: number; toolCalls: number}, remaining: {steps: number; toolCalls: number}): {steps: number; toolCalls: number} {
  return {
    steps: Math.max(0, Math.min(requested.steps, remaining.steps)),
    toolCalls: Math.max(0, Math.min(requested.toolCalls, remaining.toolCalls)),
  };
}
