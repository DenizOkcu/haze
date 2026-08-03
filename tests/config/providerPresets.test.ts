import {describe, expect, it} from 'vitest';
import {PROVIDER_PRESETS, findPreset} from '../../src/config/providerPresets.js';

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
    expect(ids).toContain('deepseek');
    expect(ids).toContain('xai');
    expect(ids).toContain('z-ai');
    expect(ids).toContain('z-ai-coding');
    expect(ids).toContain('kimi-code');
    expect(ids).toContain('moonshot');
    expect(ids).toContain('minimax-coding');
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
    expect(ids).toContain('github-models');
    expect(ids).toContain('github-copilot');
    expect(ids).toContain('chatgpt-codex');
    expect(ids).toContain('poe');
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
