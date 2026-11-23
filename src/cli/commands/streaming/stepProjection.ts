import {agentEvent, type AgentEvent} from '../../../core/agent/events.js';
import {stepCacheMetrics} from './turnRuntime.js';

/** Provider usage shape accepted by `stepCacheMetrics`, plus output tokens. */
export type StepUsage = Parameters<typeof stepCacheMetrics>[0] & {outputTokens?: number};

/**
 * Pure "what happened this epoch" projection (ARCH-06), extracted from
 * `streamLoop.ts`'s `onStepEnd` so the counter/usage/event math is unit-testable
 * outside the SDK. The caller owns the side effects (loop/turn state, callbacks,
 * logs); this function only computes values.
 */

export interface StepEndInput {
  /** Completed-step count AFTER this step is recorded. */
  completedSteps: number;
  /** 1-based retry attempt number. */
  attempt: number;
  text: string;
  toolCallCount: number;
  toolResultCount: number;
  finishReason: string;
  /** Raw provider usage object for this step (may be an empty shape). */
  usage: StepUsage | undefined;
  responseModel: string | undefined;
  /** Last valid per-step usage before this step (usage-overflow detection). */
  previousLastUsage: LastStepUsage | undefined;
  /** Turn-wide counters before this step. */
  stepsUsed: number;
  toolCallsUsed: number;
}

export interface LastStepUsage {
  inputTokens: number | undefined;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StepEndProjection {
  /** step_end agent event payload. */
  event: AgentEvent;
  /** --debug LLM log entry payload (without the log sink). */
  log: {at: string; type: 'step'; stream: 'main'; step: number; text: string; finishReason: string | undefined; usage: Record<string, number | undefined>};
  /** Usage to remember for usage-overflow detection (unchanged when this step reported nothing). */
  lastUsage: LastStepUsage | undefined;
  /** Turn-wide counters after this step. */
  stepsUsed: number;
  toolCallsUsed: number;
  /** Whether this step was tool-only (tool calls with no text). */
  toolOnlyStep: boolean;
  debugLine: string;
}

export function projectStepEnd(input: StepEndInput, now: () => Date = () => new Date()): StepEndProjection {
  const stepUsage = stepCacheMetrics(input.usage);
  const outputTokens = input.usage?.outputTokens;
  const hasUsage = stepUsage.inputTokens != null || outputTokens != null
    || stepUsage.cacheReadTokens > 0 || stepUsage.cacheWriteTokens > 0;
  const lastUsage: LastStepUsage | undefined = hasUsage
    ? {inputTokens: stepUsage.inputTokens, outputTokens: outputTokens ?? 0, cacheReadTokens: stepUsage.cacheReadTokens, cacheWriteTokens: stepUsage.cacheWriteTokens}
    : input.previousLastUsage;
  const toolOnlyStep = input.toolCallCount > 0 && input.text.trim().length === 0;
  const publicUsage = {
    inputTokens: stepUsage.inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: stepUsage.cacheReadTokens,
    cacheWriteTokens: stepUsage.cacheWriteTokens,
    reasoningTokens: stepUsage.reasoningTokens,
  };
  const event = agentEvent({
    type: 'step_end',
    attempt: input.attempt,
    step: input.completedSteps,
    finishReason: input.finishReason,
    toolCallCount: input.toolCallCount,
    usage: publicUsage,
    ...(input.responseModel ? {responseModel: input.responseModel} : {}),
  });
  const log = {
    at: now().toISOString(),
    type: 'step' as const,
    stream: 'main' as const,
    step: input.completedSteps - 1,
    text: input.text,
    finishReason: input.finishReason as string | undefined,
    usage: {
      inputTokens: stepUsage.inputTokens,
      outputTokens,
      cacheReadTokens: stepUsage.cacheReadTokens || undefined,
      cacheWriteTokens: stepUsage.cacheWriteTokens || undefined,
      noCacheTokens: stepUsage.noCacheTokens || undefined,
      reasoningTokens: stepUsage.reasoningTokens || undefined,
      cacheHitRatio: stepUsage.cacheHitRatio,
    },
  };
  return {
    event,
    log,
    lastUsage,
    stepsUsed: input.stepsUsed + 1,
    toolCallsUsed: input.toolCallsUsed,
    toolOnlyStep,
    debugLine: `step ${input.completedSteps - 1} finished: ${String(input.finishReason)}; text=${input.text.length}; toolCalls=${input.toolCallCount}; toolResults=${input.toolResultCount}`,
  };
}
