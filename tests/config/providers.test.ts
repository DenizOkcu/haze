import {describe, expect, it} from 'vitest';
import {activeModel, activeProvider, configuredProviders, resolveModelSelector} from '../../src/config/providers.js';

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

  it('returns no active model when a provider has no models', () => {
    const settings = {providers: [{name: 'remote', url: 'https://example.com/v1', models: []}]};
    expect(activeModel(settings)).toBeUndefined();
  });
});
