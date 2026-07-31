import type {JSONValue, LanguageModel} from 'ai';
import {z} from 'zod';
import {
  SUBAGENT_ACCEPTANCE_CHARS,
  SUBAGENT_ACCEPTANCE_ITEMS,
  SUBAGENT_DELIVERABLE_CHARS,
  SUBAGENT_OBJECTIVE_CHARS,
  SUBAGENT_SCOPE_CHARS,
  SUBAGENT_SCOPE_ITEMS,
} from '../agent/budgets.js';

export const workerModes = ['inspect', 'research', 'implement', 'validate'] as const;
export type WorkerMode = typeof workerModes[number];

export const subagentTaskInputV2Schema = z.object({
  objective: z.string().trim().min(1).max(SUBAGENT_OBJECTIVE_CHARS).describe('Self-contained outcome for the worker. Keep it under 1000 characters; do not paste conversation history or file contents.'),
  deliverable: z.string().trim().min(1).max(SUBAGENT_DELIVERABLE_CHARS).describe('Exact compact result the worker must return to the main agent.'),
  mode: z.enum(workerModes).describe('inspect/research are read-only; implement may edit; validate may run commands.'),
  scope: z.array(z.string().trim().min(1).max(SUBAGENT_SCOPE_CHARS)).max(SUBAGENT_SCOPE_ITEMS).optional().describe('Optional workspace-relative paths that bound the task. Prefer at most 12 concise directory/file hints.'),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(SUBAGENT_ACCEPTANCE_CHARS)).max(SUBAGENT_ACCEPTANCE_ITEMS).optional().describe('Optional concise conditions the deliverable must satisfy.'),
}).describe('A single self-contained task capsule for a disposable subagent.');

// Keep the model-facing schema flat and unambiguous. In particular, do not
// union it with the pre-capsule {task, tools, maxSteps} shape: several local
// OpenAI-compatible models respond to union tool schemas with an empty object.
export const subagentInputSchema = subagentTaskInputV2Schema;
export type SubagentToolInput = z.infer<typeof subagentInputSchema>;

export interface SubagentTaskCapsule {
  id: string;
  objective: string;
  deliverable: string;
  mode: WorkerMode;
  scope: string[];
  acceptanceCriteria: string[];
  legacyMaxSteps?: number;
}

export type WorkerTermination = 'completed' | 'no_output' | 'step_limit' | 'tool_limit' | 'deadline_exceeded' | 'cancelled' | 'provider_error' | 'policy_blocked';

export interface SubagentResultCapsule {
  id: string;
  termination: WorkerTermination;
  usable: boolean;
  deliverable: string;
  changedPaths: string[];
  validation: Array<{command: string; ok: boolean}>;
  coverageGaps: string[];
  truncated: boolean;
  resultHandle?: string;
}

export interface SubagentTelemetry {
  modelSelector: string;
  profile: string;
  durationMs: number;
  queueMs: number;
  toolCallCount: number;
  toolCalls: Array<{name: string; summary: string; durationMs: number}>;
  usage: {inputTokens?: number; outputTokens?: number};
  estimates: {
    taskCapsuleTokens: number;
    initialInputTokens: number;
    privateContextTokens: number;
    resultCapsuleTokens: number;
    mainContextTokensAvoided: number;
  };
}

export interface SubagentExecutionResult {
  capsule: SubagentResultCapsule;
  telemetry: SubagentTelemetry;
  status: 'ok' | 'error' | 'timeout' | 'cancelled';
  summary: string;
  toolCalls: SubagentTelemetry['toolCalls'];
  toolCallCount: number;
  tokens: {in?: number; out?: number};
  durationMs: number;
  error?: string;
}

export interface ProviderCapabilities {
  reportsCacheUsage: boolean;
  supportsPromptCacheKey: boolean;
  supportsExtendedCacheRetention: boolean;
  supportsStickySessionId: boolean;
  supportsServerCompaction: boolean;
  supportsTextVerbosity: boolean;
}

export interface ProviderRequestOptions {
  providerOptions?: Record<string, Record<string, JSONValue | undefined>>;
  headers?: Record<string, string>;
}

export interface WorkerRuntime {
  model: LanguageModel;
  selector: string;
  providerName: string;
  capabilities: ProviderCapabilities;
  requestOptions: ProviderRequestOptions;
}

export function normalizeSubagentInput(input: SubagentToolInput, id: string): SubagentTaskCapsule {
  return {id, objective: input.objective, deliverable: input.deliverable, mode: input.mode, scope: input.scope ?? [], acceptanceCriteria: input.acceptanceCriteria ?? []};
}

export function legacyStatus(termination: WorkerTermination): SubagentExecutionResult['status'] {
  if (termination === 'completed' || termination === 'no_output') return 'ok';
  if (termination === 'cancelled') return 'cancelled';
  if (termination === 'step_limit' || termination === 'tool_limit' || termination === 'deadline_exceeded') return 'timeout';
  return 'error';
}

export function withLegacyProjection(capsule: SubagentResultCapsule, telemetry: SubagentTelemetry, error?: string): SubagentExecutionResult {
  return {
    capsule,
    telemetry,
    status: legacyStatus(capsule.termination),
    summary: capsule.deliverable,
    toolCalls: telemetry.toolCalls,
    toolCallCount: telemetry.toolCallCount,
    tokens: {in: telemetry.usage.inputTokens, out: telemetry.usage.outputTokens},
    durationMs: telemetry.durationMs,
    ...(error ? {error} : {}),
  };
}
