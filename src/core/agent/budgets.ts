export const DEFAULT_MAX_OUTPUT_TOKENS = 16384;
export const IDLE_TIMEOUT_MS = 5 * 60_000;
export const MAIN_STEP_LIMIT = 64;
export const MAIN_TOOL_CALL_LIMIT = 120;
export const MAIN_TOOL_ONLY_STEP_LIMIT = 24;
export const ACTIVE_CONTEXT_TOKEN_BUDGET = 40_000;

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
