import {describe, expect, it} from 'vitest';
import {PROVIDER_PRESETS, findPreset} from '../../src/config/providerPresets.js';

describe('providerPresets', () => {
  it('has at least one cloud and one local preset', () => {
    expect(PROVIDER_PRESETS.some(p => p.category === 'cloud')).toBe(true);
    expect(PROVIDER_PRESETS.some(p => p.category === 'local')).toBe(true);
  });

  it('every preset with a baseUrl has a valid URL', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.baseUrl) {
        expect(() => new URL(preset.baseUrl)).not.toThrow();
      }
    }
  });

  it('cloud presets require an API key', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.category === 'cloud') {
        expect(preset.needsApiKey).toBe(true);
      }
    }
  });

  it('local presets do not require an API key', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.category === 'local') {
        expect(preset.needsApiKey).toBe(false);
      }
    }
  });

  it('every preset has a unique id', () => {
    const ids = PROVIDER_PRESETS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('finds a preset by id', () => {
    expect(findPreset('openrouter')).toMatchObject({name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1'});
    expect(findPreset('anthropic')).toMatchObject({name: 'Anthropic Claude'});
    expect(findPreset('anthropic')).not.toHaveProperty('baseUrl');
  });

  it('returns undefined for unknown preset id', () => {
    expect(findPreset('nonexistent')).toBeUndefined();
  });

  it('includes key providers', () => {
    const ids = PROVIDER_PRESETS.map(p => p.id);
    // Cloud
    expect(ids).toContain('openrouter');
    expect(ids).toContain('openai');
    expect(ids).toContain('anthropic');
    expect(ids).toContain('google-gemini');
    expect(ids).toContain('mistral');
    expect(ids).toContain('z-ai');
    expect(ids).toContain('z-ai-coding');
    expect(ids).toContain('github-models');
    expect(ids).toContain('github-copilot');
    expect(ids).toContain('chatgpt-codex');
    expect(ids).toContain('kimi-code');
    expect(ids).toContain('minimax-coding');
    expect(ids).toContain('poe');
    // Local
    expect(ids).toContain('ollama');
    expect(ids).toContain('llamacpp');
    expect(ids).toContain('mlx-server');
    expect(ids).toContain('lmstudio');
  });
});
