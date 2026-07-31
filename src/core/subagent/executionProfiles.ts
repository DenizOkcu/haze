import {z} from 'zod';
import {
  SUBAGENT_DEFAULT_DEADLINE_MS,
  SUBAGENT_DEFAULT_INPUT_TOKENS,
  SUBAGENT_DEFAULT_OUTPUT_TOKENS,
  SUBAGENT_DEFAULT_STEPS,
  SUBAGENT_DEFAULT_SUMMARY_CHARS,
  SUBAGENT_DEFAULT_TOOL_CALLS,
  SUBAGENT_MAX_CONCURRENCY,
  SUBAGENT_MAX_DEADLINE_MS,
  SUBAGENT_MAX_INPUT_TOKENS,
  SUBAGENT_MAX_OUTPUT_TOKENS,
  SUBAGENT_MAX_RETRIES,
  SUBAGENT_MAX_STEPS,
  SUBAGENT_MAX_SUMMARY_CHARS,
  SUBAGENT_MAX_TOOL_CALLS,
  SUBAGENT_MIN_DEADLINE_MS,
  SUBAGENT_MIN_STEPS,
} from '../agent/budgets.js';
import type {WorkerMode} from './contracts.js';

export interface SubagentExecutionProfile {
  name: string;
  maxConcurrency: number;
  maxSteps: number;
  maxToolCalls: number;
  maxOutputTokens: number;
  maxSummaryChars: number;
  maxInputTokens: number;
  deadlineMs: number;
  maxRetries: number;
}

export const customProfileSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(SUBAGENT_MAX_CONCURRENCY).optional(),
  maxSteps: z.number().int().min(SUBAGENT_MIN_STEPS).max(SUBAGENT_MAX_STEPS).optional(),
  maxToolCalls: z.number().int().min(1).max(SUBAGENT_MAX_TOOL_CALLS).optional(),
  maxOutputTokens: z.number().int().min(256).max(SUBAGENT_MAX_OUTPUT_TOKENS).optional(),
  maxSummaryChars: z.number().int().min(500).max(SUBAGENT_MAX_SUMMARY_CHARS).optional(),
  maxInputTokens: z.number().int().min(1_000).max(SUBAGENT_MAX_INPUT_TOKENS).optional(),
  deadlineMs: z.number().int().min(SUBAGENT_MIN_DEADLINE_MS).max(SUBAGENT_MAX_DEADLINE_MS).optional(),
  maxRetries: z.number().int().min(0).max(SUBAGENT_MAX_RETRIES).optional(),
}).passthrough();

export const COMPATIBILITY_PROFILE: SubagentExecutionProfile = {
  name: 'compatibility', maxConcurrency: 5, maxSteps: SUBAGENT_DEFAULT_STEPS,
  maxToolCalls: SUBAGENT_DEFAULT_TOOL_CALLS, maxOutputTokens: SUBAGENT_DEFAULT_OUTPUT_TOKENS,
  maxSummaryChars: SUBAGENT_DEFAULT_SUMMARY_CHARS, maxInputTokens: SUBAGENT_DEFAULT_INPUT_TOKENS,
  deadlineMs: SUBAGENT_DEFAULT_DEADLINE_MS, maxRetries: 2,
};

export const BUILT_IN_SUBAGENT_PROFILES: Readonly<Record<string, SubagentExecutionProfile>> = {
  'local-safe': {...COMPATIBILITY_PROFILE, name: 'local-safe', maxConcurrency: 1, maxSteps: 16, maxToolCalls: 12, maxOutputTokens: 2_048, maxInputTokens: 20_000, maxRetries: 0},
  'local-throughput': {...COMPATIBILITY_PROFILE, name: 'local-throughput', maxConcurrency: 2, maxSteps: 20, maxToolCalls: 16, maxOutputTokens: 3_072, maxInputTokens: 24_000, maxRetries: 0},
  'cloud-balanced': {...COMPATIBILITY_PROFILE, name: 'cloud-balanced', maxConcurrency: 3, deadlineMs: 180_000},
  'cloud-fast': {...COMPATIBILITY_PROFILE, name: 'cloud-fast', maxConcurrency: 5, deadlineMs: 120_000, maxRetries: 1},
};

export const MODE_TOOL_NAMES: Readonly<Record<WorkerMode, readonly string[]>> = {
  inspect: ['listFiles', 'readFile', 'grep', 'readToolOutput'],
  research: ['listFiles', 'readFile', 'grep', 'readToolOutput', 'fetch'],
  implement: ['listFiles', 'readFile', 'grep', 'readToolOutput', 'editFile', 'replaceLines', 'writeFile', 'bash'],
  validate: ['listFiles', 'readFile', 'grep', 'readToolOutput', 'bash'],
};

export function isMutationMode(mode: WorkerMode) {
  return mode === 'implement' || mode === 'validate';
}

export function resolveExecutionProfile(name: string | undefined, custom: Record<string, unknown> | undefined, concurrency?: number): SubagentExecutionProfile | undefined {
  const selected = name ? BUILT_IN_SUBAGENT_PROFILES[name] : COMPATIBILITY_PROFILE;
  const customValue = name ? custom?.[name] : undefined;
  if (!selected && customValue == null) return undefined;
  const parsed = customValue == null ? {} : customProfileSchema.parse(customValue);
  const base = selected ?? {...COMPATIBILITY_PROFILE, name: name!};
  const merged = {...base, ...parsed, name: name ?? base.name};
  if (concurrency != null) return {...merged, maxConcurrency: z.number().int().min(1).max(SUBAGENT_MAX_CONCURRENCY).parse(concurrency)};
  return merged;
}
