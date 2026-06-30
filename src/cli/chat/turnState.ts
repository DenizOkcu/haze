import type {Task} from '../../core/tasks/taskStorage.js';
import type {TokenUsage} from '../../core/usage/types.js';

export const EMPTY_TOKEN_USAGE: TokenUsage = {inputTokens: undefined, outputTokens: undefined, systemPrompt: 0, messages: 0, toolSchemas: 0, outputEstimate: 0, cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 0, reasoningTokens: 0, logicalInputEstimate: 0, effectiveNonCachedInput: undefined};

export function shouldClearCompletedTasks(tasks: Task[]): boolean {
  return tasks.length > 0 && tasks.every(task => task.status === 'completed');
}

export function accumulateTokenUsage(current: TokenUsage, usage: TokenUsage): TokenUsage {
  return {
    inputTokens: (current.inputTokens ?? 0) + (usage.inputTokens ?? 0) || usage.inputTokens,
    outputTokens: (current.outputTokens ?? 0) + (usage.outputTokens ?? 0) || usage.outputTokens,
    systemPrompt: current.systemPrompt + usage.systemPrompt,
    messages: current.messages + usage.messages,
    toolSchemas: current.toolSchemas + usage.toolSchemas,
    outputEstimate: current.outputEstimate + usage.outputEstimate,
    cacheReadTokens: current.cacheReadTokens + usage.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens + usage.cacheWriteTokens,
    noCacheTokens: current.noCacheTokens + usage.noCacheTokens,
    reasoningTokens: current.reasoningTokens + usage.reasoningTokens,
    logicalInputEstimate: current.logicalInputEstimate + usage.logicalInputEstimate,
    effectiveNonCachedInput: (current.effectiveNonCachedInput ?? 0) + (usage.effectiveNonCachedInput ?? 0) || usage.effectiveNonCachedInput,
  };
}
