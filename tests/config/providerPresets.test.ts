import {describe, expect, it} from 'vitest';
import {PROVIDER_PRESETS, presetModelLimitsForModels, findPreset} from '../../src/config/providerPresets.js';
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
        expect(preset.needsApiKey || Boolean(preset.auth)).toBe(true);
      }
    }
  });

  it('offers a separate browser sign-in for Mistral Vibe', () => {
    expect(findPreset('mistral-vibe')).toMatchObject({auth: 'mistral-vibe', needsApiKey: false, suggestedModels: ['mistral-vibe-cli-latest', 'mistral-large-4']});
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

  it('exposes the selected hosted and local providers', () => {
    const ids = PROVIDER_PRESETS.map(p => p.id);
    expect(ids).toEqual(expect.arrayContaining(['haze.build', 'openrouter', 'openai-api-key', 'openai-subscription', 'google-gemini', 'mistral-api', 'mistral-vibe', 'deepseek', 'xai', 'z-ai-api', 'z-ai-coding', 'moonshot', 'kimi-code', 'groq', 'together', 'ollama', 'lmstudio', 'llamacpp', 'mlx-server', 'vllm']));
    expect(ids).not.toContain('opencode-zen');
    expect(findPreset('z-ai')?.id).toBe('z-ai-api');
  });

  it('leaves model discovery and manual entry to every local server', () => {
    for (const preset of PROVIDER_PRESETS.filter(p => p.category === 'local')) {
      expect(preset.suggestedModels).toBeUndefined();
      expect(preset.modelLimits).toBeUndefined();
    }
  });

  it('uses the subscription endpoint rather than the OpenAI API-key endpoint', () => {
    expect(findPreset('openai-subscription')?.baseUrl).toBe('https://chatgpt.com/backend-api/codex');
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
  it.each([
    ['openai-api-key', 'gpt-6.1-sol', 922_000, 128_000],
    ['openai-subscription', 'gpt-6.1-sol', 500_000, 128_000],
    ['openrouter', 'anthropic/claude-sonnet-5.5', 1_000_000, 128_000],
    ['openrouter', 'deepseek/deepseek-v4.1-flash', 1_048_576, 393_216],
    ['google-gemini', 'gemini-3.8-flash', 1_048_576, 65_536],
    ['z-ai-api', 'glm-5.3-flash', 1_000_000, 131_072],
    ['xai', 'grok-4.7', 500_000, 500_000],
    ['groq', 'openai/gpt-oss-120b', 131_072, 65_536],
  ])('includes provider-specific limits for %s:%s', (presetId, model, contextWindowTokens, maxOutputTokens) => {
    const preset = findPreset(presetId)!;
    expect(preset.suggestedModels).toContain(model);
    expect(preset.modelLimits?.[model]).toEqual({contextWindowTokens, maxOutputTokens});
  });

  it('does not invent limits for moving model aliases', () => {
    expect(findPreset('mistral-api')?.modelLimits).not.toHaveProperty('mistral-small-latest');
    expect(findPreset('mistral-vibe')?.modelLimits).not.toHaveProperty('mistral-vibe-cli-latest');
    expect(findPreset('mistral-vibe')?.modelLimits?.['mistral-large-4']).toEqual(findPreset('mistral-api')?.modelLimits?.['mistral-large-4']);
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

  it('resolves only selected models by endpoint without leaking across providers', () => {
    const byUrl = presetModelLimitsForModels({url: 'https://api.deepseek.com/v1/'}, ['deepseek-v4-pro', 'kimi-k3']);
    expect(byUrl).toEqual({'deepseek-v4-pro': {contextWindowTokens: 1_048_576, maxOutputTokens: 393_216}});
    expect(presetModelLimitsForModels({name: 'OpenAI Subscription', url: 'https://chatgpt.com/backend-api/codex'}, ['gpt-6.1-sol'])).toEqual({'gpt-6.1-sol': {contextWindowTokens: 500_000, maxOutputTokens: 128_000}});
    expect(presetModelLimitsForModels({name: 'OpenAI Subscription', url: 'https://unknown.example/v1'}, ['gpt-6.1-sol'])).toEqual({});
    expect(presetModelLimitsForModels({url: 'https://api.mistral.ai/v1'}, ['mistral-large-4'])).toEqual({'mistral-large-4': {contextWindowTokens: 1_048_576, maxOutputTokens: 262_144}});
    expect(presetModelLimitsForModels({url: 'http://localhost:8080/v1'}, ['qwen3-coder'])).toEqual({});
  });
});
