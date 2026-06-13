import {describe, expect, it} from 'vitest';
import {cacheKeyFor, providerRequestSettings, type ModelRuntimeConfig} from '../../src/llm/client.js';

function config(capabilities: Partial<ModelRuntimeConfig['capabilities']>): ModelRuntimeConfig {
  return {
    providerName: 'test',
    baseURL: 'https://example.test/v1',
    modelName: 'test-model',
    cacheKey: 'stable-cache-key',
    capabilities: {
      reportsCacheUsage: false,
      supportsPromptCacheKey: false,
      supportsExtendedCacheRetention: false,
      supportsStickySessionId: false,
      supportsServerCompaction: false,
      supportsTextVerbosity: false,
      ...capabilities,
    },
  };
}

describe('providerRequestSettings', () => {
  it('adds OpenAI cache and verbosity hints only when supported', () => {
    expect(providerRequestSettings(config({supportsPromptCacheKey: true, supportsTextVerbosity: true}))).toEqual({
      providerOptions: {openai: {promptCacheKey: 'stable-cache-key', textVerbosity: 'low'}},
    });
  });

  it('adds a stable sticky-session header only when supported', () => {
    expect(providerRequestSettings(config({supportsStickySessionId: true}))).toEqual({
      headers: {'x-session-id': 'stable-cache-key'},
    });
  });

  it('does not send unsupported provider options', () => {
    expect(providerRequestSettings(config({}))).toEqual({});
  });
});

describe('cacheKeyFor', () => {
  it('differs when cwd differs and stays stable when cwd is the same', () => {
    const a1 = cacheKeyFor('gpt-4o', '/ws/a');
    const a2 = cacheKeyFor('gpt-4o', '/ws/a');
    const b = cacheKeyFor('gpt-4o', '/ws/b');
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toHaveLength(32);
  });

  it('changes when the model name changes', () => {
    expect(cacheKeyFor('gpt-4o', '/ws')).not.toBe(cacheKeyFor('gpt-4o-mini', '/ws'));
  });
});
