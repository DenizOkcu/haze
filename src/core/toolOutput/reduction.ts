export type ReductionPressure = 'conservative' | 'normal' | 'aggressive';
export type ReductionContentKind = 'validation' | 'log' | 'search' | 'diff' | 'json' | 'table' | 'web' | 'source-outline' | 'generic';
export type ReductionParseTier = 'full' | 'degraded' | 'passthrough';

export interface ReductionMetrics {
  rawChars: number;
  returnedChars: number;
  rawTokensEstimate: number;
  returnedTokensEstimate: number;
  estimatedSavedTokens: number;
  savingsPct: number;
}

export interface ToolOutputReductionMetadata extends ReductionMetrics {
  reducerName: string;
  contentKind: ReductionContentKind;
  lossy: boolean;
  parseTier: ReductionParseTier;
  rawHandle?: string;
  handle?: string;
  omittedChars: number;
  warning?: string;
}

export function estimateReductionTokens(text: string) {
  return Math.ceil(text.length / 4);
}

export function reductionMetrics(raw: string, returned: string): ReductionMetrics {
  const rawTokensEstimate = estimateReductionTokens(raw);
  const returnedTokensEstimate = estimateReductionTokens(returned);
  const estimatedSavedTokens = Math.max(0, rawTokensEstimate - returnedTokensEstimate);
  const savingsPct = rawTokensEstimate === 0 ? 0 : Number(((estimatedSavedTokens / rawTokensEstimate) * 100).toFixed(1));
  return {
    rawChars: raw.length,
    returnedChars: returned.length,
    rawTokensEstimate,
    returnedTokensEstimate,
    estimatedSavedTokens,
    savingsPct,
  };
}

export function retrievalHint(handle: string) {
  return `Use readToolOutput with handle ${handle} for the original output.`;
}

export function isInflating(raw: string, returned: string) {
  return raw.trim().length > 0 && returned.length > raw.length;
}
