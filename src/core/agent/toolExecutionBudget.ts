import type {ToolSet} from 'ai';

/**
 * Marker placed on a structured tool result when the execution-boundary budget
 * blocked the call. The underlying implementation never ran, so callers (goal
 * observers, telemetry) must not treat it as a real tool failure with side
 * effects (RH-003).
 */
export const TOOL_BUDGET_BLOCKED = '__hazeToolBudgetBlocked';

export interface ToolExecutionBudgetState {
  /** Number of underlying executions that have actually started. */
  started: number;
  /** Set once a call was blocked so callers can force synthesis. */
  exceeded: boolean;
}

export function createToolExecutionBudget(): ToolExecutionBudgetState {
  return {started: 0, exceeded: false};
}

/** True when a tool result is the structured "budget blocked" placeholder. */
export function isToolBudgetBlocked(output: unknown): boolean {
  return typeof output === 'object' && output !== null && TOOL_BUDGET_BLOCKED in output;
}

export interface BudgetLimit {
  state: ToolExecutionBudgetState;
  limit: number;
}

/**
 * Wrap a tool set so each underlying `execute` checks-and-increments one or more
 * shared budgets synchronously at the actual execution boundary. A model-emitted
 * parallel batch enters `execute` sequentially on the JS event loop, so no more
 * than the remaining budget can reach an underlying implementation even within
 * one batch (RH-003). Revisit if the AI SDK ever yields between queueing a batch
 * and invoking execute.
 *
 * When any supplied limit is exhausted the call is blocked: every limit is
 * marked exceeded, no underlying call runs, and a structured bounded failure is
 * returned so the SDK completes the step and the next prepareStep forces
 * text-only synthesis.
 */
export function withToolExecutionBudget(tools: ToolSet, ...limits: BudgetLimit[]): ToolSet {
  return Object.fromEntries(Object.entries(tools).map(([name, definition]) => {
    if (typeof definition.execute !== 'function') return [name, definition];
    const execute = definition.execute as unknown as (...args: unknown[]) => unknown;
    return [name, {
      ...definition,
      execute: (...args: unknown[]) => {
        for (const {state, limit} of limits) {
          if (state.started >= limit) {
            for (const entry of limits) entry.state.exceeded = true;
            return {ok: false, [TOOL_BUDGET_BLOCKED]: true, error: 'Tool-call budget exhausted; execution was blocked before the underlying tool ran.'};
          }
        }
        for (const {state} of limits) state.started++;
        return execute(...args);
      },
    }];
  })) as ToolSet;
}
