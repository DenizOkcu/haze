import {describe, expect, it} from 'vitest';
import {formatCostUsd, usageCostUsd, type ModelPricing} from '../../../src/core/agent/costAccounting.js';

const pricing: ModelPricing = {inputPerMillionTokens: 5, outputPerMillionTokens: 30, cacheReadPerMillionTokens: 0.5, cacheWritePerMillionTokens: 6.25};

describe('usageCostUsd', () => {
  it('prices non-cached input and output at the per-million rate', () => {
    // 100k input @ $5/M = $0.50; 10k output @ $30/M = $0.30.
    expect(usageCostUsd({inputTokens: 100_000, outputTokens: 10_000}, pricing)).toBeCloseTo(0.8, 6);
  });

  it('prices cache reads at the cache rate, not the full input rate', () => {
    // 1M cached reads @ $0.5/M = $0.50; 1M more input tokens are the cached ones, so no extra input cost.
    expect(usageCostUsd({inputTokens: 1_000_000, cacheReadTokens: 1_000_000}, pricing)).toBeCloseTo(0.5, 6);
  });

  it('prices cache writes when a rate is configured and ignores them when not', () => {
    const readWrite = usageCostUsd({inputTokens: 0, cacheWriteTokens: 200_000}, pricing);
    expect(readWrite).toBeCloseTo(1.25, 6);
    const noWriteRate = usageCostUsd({inputTokens: 0, cacheWriteTokens: 200_000}, {inputPerMillionTokens: 5, outputPerMillionTokens: 30});
    expect(noWriteRate).toBe(0);
  });

  it('falls back to the input rate for cache reads when no cache rate is configured', () => {
    expect(usageCostUsd({inputTokens: 100_000, cacheReadTokens: 100_000}, {inputPerMillionTokens: 2, outputPerMillionTokens: 4})).toBeCloseTo(0.2, 6);
  });

  it('treats missing usage fields as zero', () => {
    expect(usageCostUsd({}, pricing)).toBe(0);
  });

  it('never goes negative when cache reads exceed reported input', () => {
    expect(usageCostUsd({inputTokens: 10, cacheReadTokens: 1_000_000, outputTokens: 0}, pricing)).toBeGreaterThanOrEqual(0);
  });
});

describe('formatCostUsd', () => {
  it('renders compact human amounts and keeps undefined absent', () => {
    expect(formatCostUsd(undefined)).toBeUndefined();
    expect(formatCostUsd(1.238)).toBe('$1.24');
    expect(formatCostUsd(0.0123)).toBe('$0.012');
    expect(formatCostUsd(0.000423)).toBe('$0.0004');
    expect(formatCostUsd(0.00000423)).toBe('$4.2e-6');
    expect(formatCostUsd(Number.NaN)).toBeUndefined();
  });
});
