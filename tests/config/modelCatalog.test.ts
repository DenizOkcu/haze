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

  it.each([
    ['gpt-6.1-sol', 1_050_000, 128_000],
    ['OPENAI/GPT-6-ASTRA', 1_050_000, 128_000],
    ['subscription:gpt-6-luna', 1_050_000, 128_000],
    ['gpt-6-sol', 1_050_000, 128_000],
    ['gpt-5.6-sol', 1_050_000, 128_000],
    ['gpt-5.4', 1_050_000, 128_000],
    ['gpt-5.4-mini', 400_000, 128_000],
    ['gpt-5.4-nano', 400_000, 128_000],
    ['gpt-5.3-codex-spark', 128_000, 32_000],
    ['anthropic/claude-opus-5.5', 1_000_000, 128_000],
    ['claude-sonnet-5-5', 1_000_000, 128_000],
    ['claude-fable-5-1', 1_000_000, 128_000],
    ['google/gemini-3.8-flash', 1_048_576, 65_536],
    ['x-ai/grok-4.7', 500_000, 450_000],
    ['deepseek/deepseek-v4.1-flash', 1_000_000, 384_000],
    ['deepseek-ai/DeepSeek-V4-Pro', 512_000, 384_000],
    ['deepseek-flash', 1_000_000, 393_216],
    ['qwen/qwen3.8-max-prime', 262_144, 131_072],
    ['moonshotai/kimi-k3', 1_048_576, 131_072],
    ['z-ai/glm-5.3-prime', 1_000_000, 131_072],
    ['z-ai/glm-5.2', 262_144, 131_072],
  ])('resolves refreshed limits for %s', (model, contextWindowTokens, maxOutputTokens) => {
    expect(catalogLimitsFor(model)).toEqual({contextWindowTokens, maxOutputTokens});
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
