import {describe, expect, it, vi} from 'vitest';
import {costForUsage, DEFAULT_PRICING, priceForModel} from '../../../src/core/usage/pricing.js';

vi.mock('../../../src/config/settings.js', () => ({
  readSettings: vi.fn(async () => ({})),
}));

describe('pricing', () => {
  it('calculates cost from per-1K token prices', () => {
    expect(costForUsage({inputTokens: 1000, outputTokens: 500}, {input: 2, output: 6})).toBe(5);
  });

  it('returns a default price for a known model', async () => {
    const price = await priceForModel('openai', 'gpt-4o-mini');
    expect(price).toBeDefined();
    expect(price!.input).toBeGreaterThan(0);
  });

  it('returns undefined for an unknown model', async () => {
    const price = await priceForModel('local', 'some-unknown-model');
    expect(price).toBeUndefined();
  });

  it('allows per-model price overrides from settings', async () => {
    const {readSettings} = await import('../../../src/config/settings.js');
    readSettings.mockResolvedValue({
      priceOverrides: {'gpt-4o-mini': {input: 0.1, output: 0.4}},
    });
    const price = await priceForModel('openai', 'gpt-4o-mini');
    expect(price).toEqual({input: 0.1, output: 0.4});
  });

  it('merges partial overrides with bundled defaults', async () => {
    const {readSettings} = await import('../../../src/config/settings.js');
    readSettings.mockResolvedValue({
      priceOverrides: {'gpt-4o-mini': {output: 0.4}},
    });
    const price = await priceForModel('openai', 'gpt-4o-mini');
    expect(price).toEqual({input: DEFAULT_PRICING['gpt-4o-mini'].input, output: 0.4});
  });

  it('returns undefined when a partial override has no bundled default for the missing field', async () => {
    const {readSettings} = await import('../../../src/config/settings.js');
    readSettings.mockResolvedValue({
      priceOverrides: {'unknown-model': {input: 1}},
    });
    const price = await priceForModel('local', 'unknown-model');
    expect(price).toBeUndefined();
  });
});
