import {describe, expect, it} from 'vitest';
import {createToolExecutionBudget, isToolBudgetBlocked, withToolExecutionBudget, type ToolExecutionBudgetState} from '../../src/core/agent/toolExecutionBudget.js';
import {tool, type ToolSet} from 'ai';
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
