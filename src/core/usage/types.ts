/** Token usage counters tracked per turn/subagent and surfaced in the UI. */
export interface TokenUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  systemPrompt: number;
  messages: number;
  toolSchemas: number;
  outputEstimate: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  noCacheTokens: number;
  reasoningTokens: number;
  logicalInputEstimate: number;
  effectiveNonCachedInput: number | undefined;
}
