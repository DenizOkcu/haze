import type {ToolSet} from 'ai';

export const DEFAULT_MAX_OUTPUT_TOKENS = 16384;
/** Keep generated file payloads comfortably below a model's output-token ceiling. */
export const WRITE_FILE_CHUNK_BYTES = 16 * 1024;
export const IDLE_TIMEOUT_MS = 5 * 60_000;
/** Default per-tool execution deadline; an uncooperative tool cannot defer the turn indefinitely (RH-004). */
export const DEFAULT_TOOL_DEADLINE_MS = 10 * 60_000;
/** Subagents legitimately run long; give their wrapper a larger deadline. */
export const SUBAGENT_TOOL_DEADLINE_MS = 20 * 60_000;
/** Absolute main-turn deadline: no single turn runs longer than this by default. */
export const DEFAULT_TURN_DEADLINE_MS = 30 * 60_000;
/** Maximum accepted explicit `--timeout` value (24 hours). */
export const MAX_TURN_DEADLINE_MS = 24 * 60 * 60_000;
export const MAIN_STEP_LIMIT = 64;
export const MAIN_TOOL_CALL_LIMIT = 120;
export const MAIN_TOOL_ONLY_STEP_LIMIT = 24;
export const BACKGROUND_PROCESS_MAX_CONCURRENCY = 5;
export const BACKGROUND_PROCESS_HISTORY_LIMIT = 20;

// Disposable worker/task-capsule limits. Keep these centralized so model-facing
// schemas and runtime enforcement cannot drift.
// Keep validation tolerant of verbose tool callers while prompt guidance asks
// models to stay below 1,000 chars. Strict 1,200-char rejection caused capable
// models to waste an entire parallel fleet wave before self-repairing.
export const SUBAGENT_OBJECTIVE_CHARS = 4_000;
export const SUBAGENT_DELIVERABLE_CHARS = 600;
// Prompt guidance asks for at most 12 concise scope hints, but tolerate a
// pre-mapped file list so verbose models do not waste a full fleet wave on a
// recoverable schema error.
export const SUBAGENT_SCOPE_ITEMS = 32;
export const SUBAGENT_SCOPE_CHARS = 240;
export const SUBAGENT_ACCEPTANCE_ITEMS = 8;
export const SUBAGENT_ACCEPTANCE_CHARS = 300;
export const SUBAGENT_MIN_STEPS = 4;
export const SUBAGENT_DEFAULT_STEPS = 25;
export const SUBAGENT_MAX_STEPS = 50;
export const SUBAGENT_DEFAULT_TOOL_CALLS = 20;
export const SUBAGENT_MAX_TOOL_CALLS = 50;
export const SUBAGENT_TOOL_ONLY_LIMIT = 12;
export const SUBAGENT_SYNTHESIS_RESERVE = 2;
export const SUBAGENT_DEFAULT_OUTPUT_TOKENS = 4_096;
export const SUBAGENT_MAX_OUTPUT_TOKENS = 16_384;
export const SUBAGENT_DEFAULT_SUMMARY_CHARS = 4_000;
export const SUBAGENT_MAX_SUMMARY_CHARS = 12_000;
export const SUBAGENT_DEFAULT_INPUT_TOKENS = 40_000;
export const SUBAGENT_MAX_INPUT_TOKENS = 200_000;
export const SUBAGENT_DEFAULT_DEADLINE_MS = 300_000;
export const SUBAGENT_MIN_DEADLINE_MS = 1_000;
export const SUBAGENT_MAX_DEADLINE_MS = 30 * 60_000;
export const SUBAGENT_MAX_CONCURRENCY = 10;
export const SUBAGENT_MAX_RETRIES = 5;

/** Default size of the shared bounded model-retry pool for transient model errors and idle-stream stalls, per turn. Configurable via the `modelRetries` setting (0 disables automatic retries). */
export const DEFAULT_MODEL_RETRIES = 2;
/** Upper bound accepted for the `modelRetries` setting (mirrors the settings schema). */
export const MAX_MODEL_RETRIES_SETTING = 10;

// ── Turn-wide budget envelope ───────────────────────────────────────────────
// Values are the existing global limits — recovery slices count against these
// and must never increase them.

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

// ── Tool execution-boundary budget ──────────────────────────────────────────

/**
 * Marker placed on a structured tool result when the execution-boundary budget
 * blocked the call. The underlying implementation never ran, so callers (goal
 * observers, telemetry) must not treat it as a real tool failure with side
 * effects (RH-003).
 */
const TOOL_BUDGET_BLOCKED = '__hazeToolBudgetBlocked';

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
      // Async so the wrapper always returns a thenable — outer wrappers (e.g.
      // the tool deadline) assume `execute` yields a promise — while the
      // check-and-increment below still runs synchronously at call time, so a
      // model-emitted parallel batch cannot overshoot on the event loop.
      execute: async (...args: unknown[]) => {
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
