import {describe, expect, it} from 'vitest';
import {activeModel, activeProvider, configuredProviders, providerImageCapable, resolveModelSelector} from '../../src/config/providers.js';

describe('providers', () => {
  it('turns legacy OpenRouter settings into a provider', () => {
    const providers = configuredProviders({provider: 'openrouter', apiKey: 'key', model: 'x-ai/grok-build-0.1'});
    expect(providers[0]).toMatchObject({
      name: 'openrouter',
      url: 'https://openrouter.ai/api/v1',
      key: 'key',
      models: ['x-ai/grok-build-0.1'],
    });
  });

  it('resolves active provider and model from provider array', () => {
    const settings = {
      provider: 'local',
      model: 'llama3.1',
      providers: [
        {name: 'openrouter', url: 'https://openrouter.ai/api/v1', key: 'key', models: ['gpt-4o']},
        {name: 'local', url: 'http://localhost:1234/v1', models: ['llama3.1']},
      ],
    };
    expect(activeProvider(settings).name).toBe('local');
    expect(activeModel(settings)).toMatchObject({provider: {name: 'local'}, model: 'llama3.1'});
  });

  it('resolves unique model selectors to their provider', () => {
    const settings = {
      providers: [
        {name: 'remote', url: 'https://example.com/v1', models: ['gpt-4o']},
        {name: 'local', url: 'http://localhost:1234/v1', models: ['llama3.1']},
      ],
    };
    expect(resolveModelSelector(settings, 'llama3.1')).toMatchObject({status: 'found', provider: {name: 'local'}, model: 'llama3.1'});
  });

  it('marks duplicate model selectors as ambiguous', () => {
    const settings = {
      providers: [
        {name: 'remote', url: 'https://example.com/v1', models: ['shared']},
        {name: 'local', url: 'http://localhost:1234/v1', models: ['shared']},
      ],
    };
    expect(resolveModelSelector(settings, 'shared')).toMatchObject({status: 'ambiguous', model: 'shared'});
  });

  it('resolves provider-qualified selectors', () => {
    const settings = {
      providers: [
        {name: 'remote', url: 'https://example.com/v1', models: ['shared']},
        {name: 'local', url: 'http://localhost:1234/v1', models: ['shared']},
      ],
    };
    expect(resolveModelSelector(settings, 'local:shared')).toMatchObject({status: 'found', provider: {name: 'local'}, model: 'shared'});
  });

  it('returns no providers and no active model when nothing is configured', () => {
    const empty = {};
    expect(configuredProviders(empty)).toEqual([]);
    expect(activeProvider(empty)).toBeUndefined();
    expect(activeModel(empty)).toBeUndefined();
  });

  it('returns no active model when the saved model is stale for the active provider', () => {
    const settings = {
      provider: 'local',
      model: 'stale-model',
      providers: [{name: 'local', url: 'http://localhost:1234/v1', models: ['llama3.1']}],
    };
    expect(activeModel(settings)).toBeUndefined();
  });

  it('returns no active provider or model when selection is not explicit', () => {
    const settings = {providers: [{name: 'remote', url: 'https://example.com/v1', models: ['gpt-4o']}]};
    expect(activeProvider(settings)).toBeUndefined();
    expect(activeModel(settings)).toBeUndefined();
  });

  it('returns no active model when a provider has no models', () => {
    const settings = {provider: 'remote', providers: [{name: 'remote', url: 'https://example.com/v1', models: []}]};
    expect(activeModel(settings)).toBeUndefined();
  });

  it('defaults image capability to false and honors an explicit true flag', () => {
    const capable = {name: 'cloud', url: 'https://x/v1', models: ['m'], capabilities: {images: true}};
    const notCapable = {name: 'local', url: 'http://localhost:1234/v1', models: ['m']};
    const explicitFalse = {name: 'other', url: 'https://y/v1', models: ['m'], capabilities: {images: false}};
    expect(providerImageCapable(capable)).toBe(true);
    expect(providerImageCapable(notCapable)).toBe(false);
    expect(providerImageCapable(explicitFalse)).toBe(false);
  });

  it('preserves an explicit provider kind through normalization', () => {
    const providers = configuredProviders({providers: [{name: 'chatgpt', url: 'https://chatgpt.com/backend-api/codex', kind: 'chatgpt-codex', models: ['gpt-5.4']}]});
    expect(providers[0]?.kind).toBe('chatgpt-codex');
  });

  it('preserves capability flags through provider normalization', () => {
    const settings = {providers: [
      {name: 'cloud', url: 'https://x/v1', models: ['m'], capabilities: {images: true}},
      {name: 'local', url: 'http://localhost:1234/v1', models: ['m']},
    ]};
    const providers = configuredProviders(settings);
    expect(providers[0]?.capabilities).toEqual({images: true});
    expect(providers[1]?.capabilities).toBeUndefined();
  });

  it('preserves user-configured modelLimits through provider normalization', () => {
    // Regression: normalizeProvider used to whitelist fields without modelLimits,
    // so limits configured in settings were silently dropped before model
    // resolution ever saw them.
    const settings = {providers: [
      {name: 'cloud', url: 'https://x/v1', models: ['m'], modelLimits: {m: {contextWindowTokens: 65_536, maxOutputTokens: 8_192}}},
      {name: 'local', url: 'http://localhost:1234/v1', models: ['m']},
    ]};
    const providers = configuredProviders(settings);
    expect(providers[0]?.modelLimits).toEqual({m: {contextWindowTokens: 65_536, maxOutputTokens: 8_192}});
    expect(providers[1]?.modelLimits).toBeUndefined();
  });
});
