import {describe, expect, it} from 'vitest';
import {catalogLimitsFor, getModelCatalog} from '../../src/config/modelCatalog.js';

describe('model catalog', () => {
  it('resolves known model families case-insensitively by prefix', () => {
    expect(catalogLimitsFor('gpt-5.2')).toMatchObject({contextWindowTokens: 400_000});
    expect(catalogLimitsFor('GPT-4o-mini')).toMatchObject({contextWindowTokens: 128_000});
    expect(catalogLimitsFor('claude-sonnet-4-6')).toMatchObject({contextWindowTokens: 200_000});
    expect(catalogLimitsFor('gemini-3-pro-preview')).toMatchObject({contextWindowTokens: 1_048_576});
    expect(catalogLimitsFor('deepseek/deepseek-r1')).toMatchObject({contextWindowTokens: 128_000});
    expect(catalogLimitsFor('openrouter/qwen3-coder')).toMatchObject({contextWindowTokens: 262_144});
  });

  it('keeps specific entries before broader family prefixes (first match wins)', () => {
    // qwen3-coder (256K) must win over the qwen3 family entry.
    expect(catalogLimitsFor('qwen3-coder-480b')?.contextWindowTokens).toBeGreaterThan(catalogLimitsFor('qwen3-32b')!.contextWindowTokens);
    // gpt-5.1-codex entries precede the gpt-5 family.
    const entries = getModelCatalog().map(entry => entry.match);
    expect(entries.indexOf('gpt-5.1-codex')).toBeLessThan(entries.indexOf('gpt-5'));
  });

  it('returns undefined for unknown or empty names', () => {
    expect(catalogLimitsFor('totally-unknown-model')).toBeUndefined();
    expect(catalogLimitsFor('')).toBeUndefined();
    expect(catalogLimitsFor('  ')).toBeUndefined();
  });

  it('keeps every entry a plausible window with optional output cap', () => {
    for (const entry of getModelCatalog()) {
      expect(entry.contextWindowTokens, entry.match).toBeGreaterThanOrEqual(32_768);
      expect(entry.contextWindowTokens, entry.match).toBeLessThanOrEqual(2_000_000);
      if (entry.maxOutputTokens !== undefined) expect(entry.maxOutputTokens, entry.match).toBeGreaterThan(0);
    }
  });

  it('stays conservative for families whose variants differ (input-safe halves)', () => {
    // kimi-k2 advertises a 256K total window; the catalog pins the input-safe half.
    expect(catalogLimitsFor('kimi-k2-instruct')?.contextWindowTokens).toBe(131_072);
    // qwen3 without YaRN: native 128K window (131072).
    expect(catalogLimitsFor('qwen3-235b-a22b')?.contextWindowTokens).toBe(131_072);
  });
});
