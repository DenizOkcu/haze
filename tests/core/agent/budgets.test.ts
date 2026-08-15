import {describe, expect, it} from 'vitest';
import {tool, type ToolSet} from 'ai';
import {MAIN_STEP_LIMIT, MAIN_TOOL_CALL_LIMIT, MAIN_TOOL_ONLY_STEP_LIMIT, clampSlice, createToolExecutionBudget, hasUsableBudget, isToolBudgetBlocked, mainTurnBudget, remainingSteps, remainingToolCalls, withToolExecutionBudget, wouldExceedToolCalls, type ToolExecutionBudgetState} from '../../../src/core/agent/budgets.js';



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

import {z} from 'zod';

function makeTools(imp: Record<string, () => unknown>): ToolSet {
  const tools: ToolSet = {};
  for (const [name, fn] of Object.entries(imp)) {
    tools[name] = tool({description: name, inputSchema: z.object({}), execute: async () => fn()});
  }
  return tools;
}

async function runAll(tools: ToolSet, count: number) {
  const results: unknown[] = [];
  for (let i = 0; i < count; i++) {
    const def = tools.eat ?? tools[Object.keys(tools)[0]!]!;
    results.push(await (def.execute as unknown as () => unknown)());
  }
  return results;
}

describe('withToolExecutionBudget', () => {
  it('blocks underlying executions past a single limit within one batch', async () => {
    let calls = 0;
    const tools = makeTools({eat: () => { calls++; return {ok: true}; }});
    const state = createToolExecutionBudget();
    const budgeted = withToolExecutionBudget(tools, {state, limit: 3});
    // Simulate a model-emitted parallel batch of 5 entering execute sequentially.
    const results = await runAll(budgeted, 5);
    expect(calls).toBe(3);
    expect(state.started).toBe(3);
    expect(state.exceeded).toBe(true);
    expect(results.slice(0, 3)).toEqual([{ok: true}, {ok: true}, {ok: true}]);
    expect(isToolBudgetBlocked(results[3])).toBe(true);
    expect(isToolBudgetBlocked(results[4])).toBe(true);
  });

  it('enforces the tighter of a global and a slice limit', async () => {
    let calls = 0;
    const tools = makeTools({eat: () => { calls++; return {ok: true}; }});
    const globalState = createToolExecutionBudget();
    const sliceState = createToolExecutionBudget();
    const budgeted = withToolExecutionBudget(tools, {state: globalState, limit: 120}, {state: sliceState, limit: 2});
    await runAll(budgeted, 5);
    expect(calls).toBe(2);
    expect(sliceState.exceeded).toBe(true);
    expect(globalState.started).toBe(2);
  });

  it('a blocked call produces no side effect and marks all limits exceeded', async () => {
    let calls = 0;
    const tools = makeTools({eat: () => { calls++; return {ok: true}; }});
    const globalState: ToolExecutionBudgetState = {started: 119, exceeded: false};
    const sliceState = createToolExecutionBudget();
    const budgeted = withToolExecutionBudget(tools, {state: globalState, limit: 120}, {state: sliceState, limit: 5});
    const first = await (budgeted.eat!.execute as unknown as () => unknown)(); // starts #120
    const blocked = await (budgeted.eat!.execute as unknown as () => unknown)(); // 121 -> blocked
    expect(calls).toBe(1);
    expect(first).toEqual({ok: true});
    expect(isToolBudgetBlocked(blocked)).toBe(true);
    expect(globalState.exceeded).toBe(true);
    expect(sliceState.exceeded).toBe(true);
  });
});

describe('withToolExecutionBudget × withToolDeadline (RH-003/RH-004 composition)', () => {
  it('a budget-blocked call resolves with the structured blocked result under the deadline wrapper', async () => {
    // The deadline wrapper assumes execute yields a thenable; a synchronous
    // blocked return must still surface as the bounded non-event, never as a
    // TypeError that the SDK would classify as a tool failure.
    const {withToolDeadline} = await import('../../../src/core/deadline.js');
    const tools = makeTools({eat: () => ({ok: true})});
    const globalState: ToolExecutionBudgetState = {started: 120, exceeded: false};
    const budgeted = withToolExecutionBudget(tools, {state: globalState, limit: 120});
    const deadlineWrapped = Object.fromEntries(Object.entries(budgeted).map(([name, definition]) => {
      const execute = definition.execute as unknown as (...args: unknown[]) => Promise<unknown>;
      return [name, {...definition, execute: (...args: unknown[]) => withToolDeadline(() => execute(...args), 60_000)}];
    })) as typeof budgeted;
    const blocked = await (deadlineWrapped.eat!.execute as unknown as () => Promise<unknown>)();
    expect(isToolBudgetBlocked(blocked)).toBe(true);
  });
});
