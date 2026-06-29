import {readSettings} from '../../config/settings.js';

export interface TokenPricing {
  input: number; // $ per 1K tokens
  output: number;
}

export const DEFAULT_PRICING: Record<string, TokenPricing> = {
  'gpt-4o': {input: 2.5, output: 10},
  'gpt-4o-mini': {input: 0.15, output: 0.6},
  'claude-sonnet-4-6': {input: 3, output: 15},
  'claude-opus-4-8': {input: 15, output: 75},
};

export function pricingKey(providerName: string, modelName: string) {
  return `${providerName}:${modelName}`;
}

export async function priceForModel(providerName: string, modelName: string): Promise<TokenPricing | undefined> {
  const settings = await readSettings();
  const overrides = settings.priceOverrides;
  const qualified = pricingKey(providerName, modelName);
  const override = overrides?.[qualified] ?? overrides?.[modelName];
  if (override) {
    if (override.input == null || override.output == null) {
      return undefined;
    }
    return {input: override.input, output: override.output};
  }
  return DEFAULT_PRICING[modelName] ?? DEFAULT_PRICING[qualified] ?? undefined;
}

export function costForUsage(
  usage: {inputTokens?: number; outputTokens?: number},
  price: TokenPricing,
): number {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return Math.round(((input * price.input + output * price.output) / 1000) * 1_000_000) / 1_000_000;
}
