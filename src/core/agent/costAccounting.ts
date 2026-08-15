/**
 * USD cost accounting for token usage (F-12). Pricing is optional per-model
 * metadata (settings `modelLimits.<model>.pricing`, auto-populated from the
 * curated preset catalog when a suggested model is added); every surfaced
 * amount is an estimate derived from provider-reported usage and may differ
 * from the invoice when a provider reports usage imprecisely or prices by
 * tier (e.g. long-context surcharges), which the catalog does not model.
 */
export interface ModelPricing {
  /** USD per 1M input (non-cached) tokens. */
  inputPerMillionTokens: number;
  /** USD per 1M output tokens. */
  outputPerMillionTokens: number;
  /** USD per 1M cached-input (cache read) tokens, when priced separately. */
  cacheReadPerMillionTokens?: number;
  /** USD per 1M cache-write tokens, when priced separately. */
  cacheWritePerMillionTokens?: number;
}

export interface UsageForCost {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

const MILLION = 1_000_000;

/** Estimated USD cost of one usage report under the given pricing. */
export function usageCostUsd(usage: UsageForCost, pricing: ModelPricing): number {
  const input = (usage.inputTokens ?? 0) - (usage.cacheReadTokens ?? 0);
  const cost = Math.max(0, input) * pricing.inputPerMillionTokens / MILLION
    + (usage.outputTokens ?? 0) * pricing.outputPerMillionTokens / MILLION
    + (usage.cacheReadTokens ?? 0) * (pricing.cacheReadPerMillionTokens ?? pricing.inputPerMillionTokens) / MILLION
    + (usage.cacheWriteTokens ?? 0) * (pricing.cacheWritePerMillionTokens ?? 0) / MILLION;
  return Math.round(cost * 1e6) / 1e6;
}

/** Compact human rendering: `$1.24`, `$0.013`, `$0.00042`. Undefined stays undefined. */
export function formatCostUsd(cost: number | undefined): string | undefined {
  if (cost == null || !Number.isFinite(cost)) return undefined;
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(3)}`;
  if (cost >= 0.0001) return `$${cost.toFixed(4)}`;
  return `$${cost.toExponential(1)}`;
}
