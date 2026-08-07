import {describe, expect, it} from 'vitest';
import {mainTurnBudget, clampSlice, hasUsableBudget, remainingSteps, remainingToolCalls, wouldExceedToolCalls} from '../../src/core/agent/turnBudget.js';
import {MAIN_STEP_LIMIT, MAIN_TOOL_CALL_LIMIT, MAIN_TOOL_ONLY_STEP_LIMIT} from '../../src/core/agent/budgets.js';

describe('turn budget', () => {
  it('mainTurnBudget mirrors the global limits', () => {
    const budget = mainTurnBudget();
    expect(budget).toEqual({stepLimit: MAIN_STEP_LIMIT, toolCallLimit: MAIN_TOOL_CALL_LIMIT, toolOnlyStepLimit: MAIN_TOOL_ONLY_STEP_LIMIT});
  });

  it('computes remaining steps and tool calls, clamped at zero', () => {
    const budget = mainTurnBudget();
    expect(remainingSteps(10, budget)).toBe(MAIN_STEP_LIMIT - 10);
    expect(remainingSteps(MAIN_STEP_LIMIT + 5, budget)).toBe(0);
    expect(remainingToolCalls(3, budget)).toBe(MAIN_TOOL_CALL_LIMIT - 3);
    expect(remainingToolCalls(MAIN_TOOL_CALL_LIMIT + 1, budget)).toBe(0);
  });

  it('detects when an extra tool call would meet or exceed the call budget', () => {
    const budget = mainTurnBudget();
    expect(wouldExceedToolCalls(MAIN_TOOL_CALL_LIMIT - 1, 1, budget)).toBe(true);
    expect(wouldExceedToolCalls(0, 1, budget)).toBe(false);
  });

  it('reports usable budget only when both a step and a tool call remain', () => {
    const budget = mainTurnBudget();
    expect(hasUsableBudget({steps: 0, toolCalls: 0}, budget)).toBe(true);
    expect(hasUsableBudget({steps: MAIN_STEP_LIMIT, toolCalls: 0}, budget)).toBe(false);
    expect(hasUsableBudget({steps: 0, toolCalls: MAIN_TOOL_CALL_LIMIT}, budget)).toBe(false);
  });

  it('clamps a requested slice to remaining budget', () => {
    const budget = mainTurnBudget();
    expect(clampSlice({steps: 4, toolCalls: 4}, remainingSlice(budget, 60, 100))).toEqual({steps: 4, toolCalls: 4});
    expect(clampSlice({steps: 4, toolCalls: 4}, remainingSlice(budget, 62, 118))).toEqual({steps: 2, toolCalls: 2});
    expect(clampSlice({steps: 4, toolCalls: 4}, remainingSlice(budget, 70, 130))).toEqual({steps: 0, toolCalls: 0});
  });
});

function remainingSlice(budget: ReturnType<typeof mainTurnBudget>, stepsUsed: number, toolCallsUsed: number) {
  return {steps: remainingSteps(stepsUsed, budget), toolCalls: remainingToolCalls(toolCallsUsed, budget)};
}
