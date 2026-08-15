import {describe, expect, it} from 'vitest';
import {PROVIDER_PRESETS, findPreset, presetModelLimitsForModels} from '../../src/config/providerPresets.js';
describe('providerPresets', () => {
  it('has at least one cloud and one local preset', () => {
    expect(PROVIDER_PRESETS.some(p => p.category === 'cloud')).toBe(true);
    expect(PROVIDER_PRESETS.some(p => p.category === 'local')).toBe(true);
  });

  it('every preset has a valid URL', () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(() => new URL(preset.baseUrl)).not.toThrow();
    }
  });

  it('cloud presets require an API key unless they have an explicit OAuth flow', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.category === 'cloud') {
        expect(preset.needsApiKey || preset.auth === 'chatgpt-oauth').toBe(true);
      }
    }
  });

  it('separates OpenAI API-key and subscription provider data', () => {
    expect(findPreset('openai-api-key')).toMatchObject({name: 'OpenAI API Key', needsApiKey: true});
    expect(findPreset('openai-subscription')).toMatchObject({
      name: 'OpenAI Subscription',
      auth: 'chatgpt-oauth',
      needsApiKey: false,
      suggestedModels: expect.arrayContaining(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']),
    });
  });

  it('local presets do not require an API key', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.category === 'local') {
        expect(preset.needsApiKey).toBe(false);
      }
    }
  });

  it('every preset has a unique id and no duplicate model entries', () => {
    const ids = PROVIDER_PRESETS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of PROVIDER_PRESETS) {
      expect(new Set(preset.suggestedModels ?? []).size).toBe(preset.suggestedModels?.length ?? 0);
    }
  });

  it('finds OpenAI-compatible presets by id', () => {
    expect(findPreset('openrouter')).toMatchObject({name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1'});
    expect(findPreset('google-gemini')).toMatchObject({baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai'});
  });

  it('excludes providers that need an unsupported native or OAuth adapter', () => {
    const ids = PROVIDER_PRESETS.map(preset => preset.id);
    expect(ids).not.toContain('anthropic');
    expect(ids).not.toContain('minimax-coding');
    expect(ids).not.toContain('github-models');
    expect(ids).not.toContain('github-copilot');
  });

  it('keeps former OpenAI preset ids as lookup aliases without duplicate entries', () => {
    expect(findPreset('openai')).toMatchObject({id: 'openai-api-key'});
    expect(findPreset('chatgpt-codex')).toMatchObject({id: 'openai-subscription'});
  });

  it('returns undefined for unknown preset id', () => {
    expect(findPreset('nonexistent')).toBeUndefined();
  });

  it('includes key providers', () => {
    const ids = PROVIDER_PRESETS.map(p => p.id);
    // Cloud
    expect(ids).toContain('openrouter');
    expect(ids).toContain('openai-api-key');
    expect(ids).toContain('google-gemini');
    expect(ids).toContain('mistral');
    expect(ids).toContain('deepseek');
    expect(ids).toContain('xai');
    expect(ids).toContain('z-ai');
    expect(ids).toContain('z-ai-coding');
    expect(ids).toContain('kimi-code');
    expect(ids).toContain('moonshot');
    expect(ids).toContain('groq');
    expect(ids).toContain('cerebras');
    expect(ids).toContain('together');
    expect(ids).toContain('fireworks');
    expect(ids).toContain('huggingface');
    expect(ids).toContain('nvidia');
    expect(ids).toContain('qwen-token-plan');
    expect(ids).toContain('opencode-zen');
    expect(ids).toContain('requesty');
    expect(ids).toContain('thesean');
    expect(ids).toContain('atlas-cloud');
    expect(ids).toContain('openai-subscription');
    expect(ids).toContain('poe');
    // Curated multi-model gateways added from the models.dev catalog.
    expect(ids).toContain('kilo');
    expect(ids).toContain('novita');
    expect(ids).toContain('deep-infra');
    expect(ids).toContain('siliconflow');
    expect(ids).toContain('nebius');
    // Local
    expect(ids).toContain('ollama');
    expect(ids).toContain('llamacpp');
    expect(ids).toContain('mlx-server');
    expect(ids).toContain('lmstudio');
  });

  it('uses SCREAMING_SNAKE_CASE env var names for apiKeyEnvVar', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.apiKeyEnvVar) {
        expect(preset.apiKeyEnvVar).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });
});

describe('preset model limits', () => {
  // The curated catalog is only useful while it stays complete. Local presets
  // are exempt (their context depends on the local server, not the model);
  // Thesean has no models.dev data yet and is the only allowed cloud gap.
  const LIMIT_EXEMPT = new Set(['ollama', 'llamacpp', 'mlx-server', 'lmstudio', 'thesean']);

  it('every suggested model on every non-exempt preset carries limits', () => {
    const missing: string[] = [];
    for (const preset of PROVIDER_PRESETS) {
      if (LIMIT_EXEMPT.has(preset.id)) continue;
      for (const model of preset.suggestedModels ?? []) {
        if (!preset.modelLimits?.[model]) missing.push(`${preset.id}:${model}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('carries no limit entries for models not in suggestedModels', () => {
    for (const preset of PROVIDER_PRESETS) {
      const suggested = new Set(preset.suggestedModels ?? []);
      for (const model of Object.keys(preset.modelLimits ?? {})) {
        expect(suggested.has(model), `${preset.id}:${model}`).toBe(true);
      }
    }
  });

  it('limit values are plausible tokens', () => {
    for (const preset of PROVIDER_PRESETS) {
      for (const [model, limits] of Object.entries(preset.modelLimits ?? {})) {
        expect(limits.contextWindowTokens, `${preset.id}:${model} context`).toBeGreaterThan(0);
        expect(limits.contextWindowTokens, `${preset.id}:${model} context ceiling`).toBeLessThanOrEqual(10_000_000);
        expect(limits.maxOutputTokens, `${preset.id}:${model} output`).toBeGreaterThan(0);
        // Output may exceed the provider's context cap upstream (e.g. Poe routes
        // that clamp context but not output, or reasoning models with max output
        // marginally above their context figure), so only bound it absolutely.
        expect(limits.maxOutputTokens, `${preset.id}:${model} output ceiling`).toBeLessThanOrEqual(1_048_576);
      }
    }
  });

  it('resolves limits by provider URL and name without cross-preset leakage', () => {
    const byUrl = presetModelLimitsForModels({url: 'https://api.deepseek.com/v1'}, ['deepseek-v4-pro', 'kimi-k3']);
    expect(byUrl).toEqual({'deepseek-v4-pro': {contextWindowTokens: 1_000_000, maxOutputTokens: 384_000}});
    // The same model id on a different provider resolves to that provider's cap.
    const byRouter = presetModelLimitsForModels({url: 'https://api.together.ai/v1'}, ['deepseek-ai/DeepSeek-V4-Pro']);
    expect(byRouter['deepseek-ai/DeepSeek-V4-Pro']?.contextWindowTokens).toBe(512_000);
    const byName = presetModelLimitsForModels({name: 'OpenAI Subscription'}, ['gpt-5.5']);
    expect(byName).toEqual({'gpt-5.5': {contextWindowTokens: 1_050_000, maxOutputTokens: 128_000}});
    expect(presetModelLimitsForModels({url: 'http://localhost:8080/v1'}, ['qwen3-coder'])).toEqual({});
    expect(presetModelLimitsForModels({url: 'https://unknown.example/v1'}, ['gpt-5.5'])).toEqual({});
  });
});
