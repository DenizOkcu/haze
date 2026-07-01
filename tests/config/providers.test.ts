import {describe, expect, it} from 'vitest';
import {activeModel, activeProvider, configuredProviders, resolveModelSelector, resolveModelSlot, type ModelSlotName} from '../../src/config/providers.js';

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

  it('falls back to the provider default when the saved model is stale for the active provider', () => {
    const settings = {
      provider: 'local',
      model: 'stale-model',
      providers: [{name: 'local', url: 'http://localhost:1234/v1', models: ['llama3.1']}],
    };
    expect(activeModel(settings)).toMatchObject({provider: {name: 'local'}, model: 'llama3.1'});
  });

  it('returns no active model when a provider has no models', () => {
    const settings = {providers: [{name: 'remote', url: 'https://example.com/v1', models: []}]};
    expect(activeModel(settings)).toBeUndefined();
  });
});

const baseSettings = {
  provider: 'openai',
  model: 'gpt-4o',
  providers: [
    {name: 'openai', url: 'https://api.openai.com/v1', key: 'k', models: ['gpt-4o', 'gpt-4o-mini']},
    {name: 'local', url: 'http://localhost:1234/v1', models: ['llama3.1']},
  ],
};

describe('resolveModelSlot', () => {
  it('resolves primary to the flat provider/model when no models.primary is set', () => {
    const resolved = resolveModelSlot(baseSettings, 'primary');
    expect(resolved).toMatchObject({status: 'found', provider: {name: 'openai'}, model: 'gpt-4o'});
  });

  it('lets models.primary override the flat provider/model', () => {
    const settings = {...baseSettings, models: {primary: 'local:llama3.1'}};
    const resolved = resolveModelSlot(settings, 'primary');
    expect(resolved).toMatchObject({status: 'found', provider: {name: 'local'}, model: 'llama3.1'});
  });

  it('falls back lightweight to primary when unset', () => {
    const resolved = resolveModelSlot(baseSettings, 'lightweight');
    expect(resolved).toMatchObject({status: 'found', provider: {name: 'openai'}, model: 'gpt-4o'});
  });

  it('resolves lightweight to its configured selector', () => {
    const settings = {...baseSettings, models: {lightweight: 'openai:gpt-4o-mini'}};
    const resolved = resolveModelSlot(settings, 'lightweight');
    expect(resolved).toMatchObject({status: 'found', provider: {name: 'openai'}, model: 'gpt-4o-mini'});
  });

  it('falls back fallback to primary when unset', () => {
    const resolved = resolveModelSlot(baseSettings, 'fallback');
    expect(resolved).toMatchObject({status: 'found', provider: {name: 'openai'}, model: 'gpt-4o'});
  });

  it('returns missing when primary itself is missing', () => {
    expect(resolveModelSlot({providers: []}, 'primary')).toMatchObject({status: 'missing'});
  });

  it('returns missing for an invalid slot selector', () => {
    const settings = {...baseSettings, models: {lightweight: 'no-such-model'}};
    expect(resolveModelSlot(settings, 'lightweight')).toMatchObject({status: 'missing'});
  });

  it('returns ambiguous for a slot selector that matches multiple providers', () => {
    const settings = {
      ...baseSettings,
      providers: [
        ...baseSettings.providers,
        {name: 'proxy', url: 'https://proxy.example.com/v1', key: 'k', models: ['gpt-4o-mini']},
      ],
      models: {lightweight: 'gpt-4o-mini'},
    };
    expect(resolveModelSlot(settings, 'lightweight')).toMatchObject({status: 'ambiguous', model: 'gpt-4o-mini'});
  });
});
