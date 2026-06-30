import type {ModelMessage} from 'ai';
import type {ContextFile} from '../../../config/contextFiles.js';
import {cacheHitRatio, contextBreakdown, effectiveNonCachedInput, estimateValueTokens} from '../../../core/agent/contextBudget.js';
export type {TokenUsage} from '../../../core/usage/types.js';

export function retryDelayMs(attempt: number) {
  return Math.min(4000, 1000 * 2 ** attempt);
}

export async function abortableDelay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, {once: true});
  });
}

export function estimateInputBreakdown(input: {system: string; contextFiles: ContextFile[]; messages: ModelMessage[]; tools?: Record<string, unknown>}) {
  const breakdown = contextBreakdown(input);
  return {
    breakdown,
    systemPrompt: breakdown.system,
    messages: Object.values(breakdown.messagesByRole).reduce((sum, value) => sum + value, 0),
    toolSchemas: breakdown.toolSchemas.reduce((sum, value) => sum + value.tokens, 0),
    logicalInputEstimate: breakdown.logicalInputEstimate,
  };
}

export function responseCompletionMetrics(text: string, generationStartedAt: number) {
  const finishedAt = Date.now();
  const elapsedSeconds = Math.max((finishedAt - generationStartedAt) / 1000, 0.001);
  const outputTokens = estimateValueTokens(text);
  return {
    finishedAt,
    tokensPerSecond: outputTokens > 0 ? outputTokens / elapsedSeconds : undefined,
  };
}

export function extractUsage(event: {usage?: {inputTokens?: number; outputTokens?: number; inputTokenDetails?: {cacheReadTokens?: number; cacheWriteTokens?: number; noCacheTokens?: number}; outputTokenDetails?: {reasoningTokens?: number}}}) {
  const cacheReadTokens = event.usage?.inputTokenDetails?.cacheReadTokens ?? 0;
  const computedNonCachedInput = effectiveNonCachedInput(event.usage?.inputTokens, cacheReadTokens);
  return {
    inputTokens: event.usage?.inputTokens,
    outputTokens: event.usage?.outputTokens,
    cacheReadTokens,
    cacheWriteTokens: event.usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
    noCacheTokens: event.usage?.inputTokenDetails?.noCacheTokens ?? computedNonCachedInput ?? 0,
    effectiveNonCachedInput: computedNonCachedInput,
    reasoningTokens: event.usage?.outputTokenDetails?.reasoningTokens ?? 0,
  };
}

export function stepCacheMetrics(usage: {inputTokens?: number; inputTokenDetails?: {cacheReadTokens?: number; cacheWriteTokens?: number}; outputTokenDetails?: {reasoningTokens?: number}} | undefined) {
  const inputTokens = usage?.inputTokens;
  const cacheReadTokens = usage?.inputTokenDetails?.cacheReadTokens ?? 0;
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
    reasoningTokens: usage?.outputTokenDetails?.reasoningTokens ?? 0,
    noCacheTokens: effectiveNonCachedInput(inputTokens, cacheReadTokens) ?? 0,
    cacheHitRatio: cacheHitRatio(inputTokens, cacheReadTokens || undefined),
  };
}

export function subagentTokenEstimate(output: unknown) {
  if (typeof output !== 'object' || output == null || !('tokens' in output)) return undefined;
  const tokens = (output as {tokens?: {in?: unknown; out?: unknown}}).tokens;
  const input = typeof tokens?.in === 'number' ? tokens.in : 0;
  const outputTokens = typeof tokens?.out === 'number' ? tokens.out : 0;
  return input > 0 || outputTokens > 0 ? {input, output: outputTokens} : undefined;
}

export function rememberContextFilesFromToolOutput(activeContextFiles: ContextFile[], output: unknown) {
  if (typeof output !== 'object' || output == null) return activeContextFiles;
  const files = (output as {applicableProjectInstructions?: unknown}).applicableProjectInstructions;
  if (!Array.isArray(files)) return activeContextFiles;
  const seen = new Set(activeContextFiles.map(file => file.path));
  const next = [...activeContextFiles];
  for (const file of files) {
    if (typeof file !== 'object' || file == null) continue;
    const candidate = file as {path?: unknown; content?: unknown};
    if (typeof candidate.path !== 'string' || typeof candidate.content !== 'string' || seen.has(candidate.path)) continue;
    next.push({path: candidate.path, content: candidate.content});
    seen.add(candidate.path);
  }
  return next;
}
