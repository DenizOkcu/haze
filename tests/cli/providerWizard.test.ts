import {describe, expect, it} from 'vitest';
import {chatgptCodexUrlWarning, providerActionResult, providerAppendModels, providerFinishAdd, providerRemove, providerRemoveModels, providerSetImageCapable, providerSetKey} from '../../src/cli/commands/providerWizard.js';

const settings = {
  provider: 'local',
  model: 'old',
  providers: [{name: 'local', url: 'http://localhost:1234/v1', models: ['old', 'keep']}],
};

describe('provider wizard helpers', () => {
  it('appends unique models to a provider', () => {
    const result = providerAppendModels(settings, 'local', 'new, old');
    expect(result.settingsPatch?.providers?.[0].models).toEqual(['old', 'keep', 'new']);
    expect(result.message).toContain('Added 2 models');
  });

  it('preserves unknown fields on every provider when editing one', () => {
    const configured = {providers: [
      {name: 'one', url: 'https://one.example/v1', models: ['a'], customMetadata: {owner: 'team'}},
      {name: 'two', url: 'https://two.example/v1', models: ['b'], customMetadata: {owner: 'other'}},
    ]};
    const result = providerAppendModels(configured, 'one', 'new');
    expect(result.settingsPatch?.providers?.find(provider => provider.name === 'one')).toMatchObject({customMetadata: {owner: 'team'}});
    expect(result.settingsPatch?.providers?.find(provider => provider.name === 'two')).toMatchObject({customMetadata: {owner: 'other'}});
  });

  it('creates a provider from draft and model input', () => {
    const result = providerFinishAdd({}, {name: 'remote', url: 'https://x/v1', key: 'k'}, 'a, a, b');
    expect(result.provider).toEqual({name: 'remote', url: 'https://x/v1', key: 'k', models: ['a', 'b']});
    expect(result.settingsPatch?.provider).toBe('remote');
  });

  it('keeps preset limits separate and never overwrites user limits', () => {
    const created = providerFinishAdd({}, {name: 'DeepSeek', url: 'https://api.deepseek.com/v1', key: 'k'}, 'deepseek-v4-pro, other');
    expect(created.provider?.modelLimits).toBeUndefined();
    expect(created.provider?.discoveredModelLimits).toBeUndefined();

    const withUserLimits = {
      provider: 'DeepSeek',
      providers: [{
        name: 'DeepSeek',
        url: 'https://api.deepseek.com/v1',
        models: ['deepseek-v4-flash'],
        modelLimits: {'deepseek-v4-pro': {contextWindowTokens: 123_456, maxOutputTokens: 1_024}},
      }],
    };
    const appended = providerAppendModels(withUserLimits, 'DeepSeek', 'deepseek-v4-pro');
    expect(appended.settingsPatch?.providers?.[0].modelLimits?.['deepseek-v4-pro']).toEqual({contextWindowTokens: 123_456, maxOutputTokens: 1_024});
    expect(appended.settingsPatch?.providers?.[0].modelLimits).not.toHaveProperty('deepseek-v4-flash');
  });

  it('lets live /models discovery win over the preset catalog, user settings win over both', () => {
    const discovered = {
      // Live value differs from the curated catalog (e.g. provider lowered the cap).
      'deepseek-v4-pro': {contextWindowTokens: 512_000, maxOutputTokens: 65_536},
      // Harvested for a model the caller is not adding: must not be written.
      'unrelated-model': {contextWindowTokens: 99_999},
    };
    const created = providerFinishAdd({}, {name: 'DeepSeek', url: 'https://api.deepseek.com/v1', key: 'k'}, 'deepseek-v4-pro', discovered);
    expect(created.provider?.discoveredModelLimits).toEqual({
      'deepseek-v4-pro': {contextWindowTokens: 512_000, maxOutputTokens: 65_536},
    });

    const withUserValue = {
      provider: 'DeepSeek',
      providers: [{name: 'DeepSeek', url: 'https://api.deepseek.com/v1', models: ['deepseek-v4-pro'], modelLimits: {'deepseek-v4-pro': {contextWindowTokens: 1, maxOutputTokens: 1}}}],
    };
    const appended = providerAppendModels(withUserValue, 'DeepSeek', 'deepseek-v4-pro', discovered);
    expect(appended.settingsPatch?.providers?.[0].modelLimits?.['deepseek-v4-pro']).toEqual({contextWindowTokens: 1, maxOutputTokens: 1});
  });

  it('refreshes discovered values without losing partial fields or user overrides', () => {
    const configured = {providers: [{name: 'custom', url: 'https://example.test/v1', models: ['m'], modelLimits: {m: {maxOutputTokens: 2048}}, discoveredModelLimits: {m: {contextWindowTokens: 200_000, maxOutputTokens: 8192}}}]};
    const result = providerAppendModels(configured, 'custom', 'm', {m: {contextWindowTokens: 16_000}});
    expect(result.settingsPatch?.providers?.[0].discoveredModelLimits?.m).toEqual({contextWindowTokens: 16_000, maxOutputTokens: 8192});
    expect(result.settingsPatch?.providers?.[0].modelLimits?.m).toEqual({maxOutputTokens: 2048});
  });

  it('removes models and updates active model when necessary', () => {
    const result = providerRemoveModels(settings, 'local', 'old, missing');
    expect(result.settingsPatch?.model).toBeUndefined();
    expect(result.message).toContain('selection cleared');
    expect(result.message).toContain('Not found: missing.');
  });

  it('removes providers and switches active provider when needed', () => {
    const result = providerRemove(settings, 'local');
    expect(result.settingsPatch).toEqual({providers: [], provider: undefined, model: undefined});
    expect(result.message).toContain('selection cleared');
  });

  it('clears active selection instead of falling back to another provider', () => {
    const result = providerRemove({provider: 'first', model: 'a', providers: [
      {name: 'first', url: 'https://first.example/v1', models: ['a']},
      {name: 'second', url: 'https://second.example/v1', models: ['b']},
    ]}, 'first');
    expect(result.settingsPatch).toEqual({providers: [{name: 'second', url: 'https://second.example/v1', models: ['b']}], provider: undefined, model: undefined});
  });

  it('preserves selection when removing an inactive provider', () => {
    const result = providerRemove({provider: 'first', model: 'a', providers: [
      {name: 'first', url: 'https://first.example/v1', models: ['a']},
      {name: 'second', url: 'https://second.example/v1', models: ['b']},
    ]}, 'second');
    expect(result.settingsPatch).toEqual({providers: [{name: 'first', url: 'https://first.example/v1', models: ['a']}]});
  });

  it('rejects adding a key to a remote plaintext provider', () => {
    const result = providerSetKey({providers: [{name: 'remote', url: 'http://example.com/v1', models: ['a']}]}, 'remote', 'secret');
    expect(result.settingsPatch).toBeUndefined();
    expect(result.message).toContain('plaintext HTTP');
  });

  it('marks a provider image-capable and clears the flag on toggle', () => {
    const settingsWith = {providers: [{name: 'local', url: 'http://localhost:1234/v1', models: ['m']}]};
    const enable = providerSetImageCapable(settingsWith, 'local', true);
    expect(enable.settingsPatch?.providers?.[0]?.capabilities).toEqual({images: true});
    expect(enable.message).toContain('marked image-capable');

    const settingsCapable = {providers: [{name: 'local', url: 'http://localhost:1234/v1', models: ['m'], capabilities: {images: true}}]};
    const disable = providerSetImageCapable(settingsCapable, 'local', false);
    expect(disable.settingsPatch?.providers?.[0]?.capabilities).toEqual({images: false});
    expect(disable.message).toContain('no longer image-capable');
  });

  it('does nothing when marking image capability on a missing provider', () => {
    const result = providerSetImageCapable({providers: []}, 'missing', true);
    expect(result.settingsPatch).toBeUndefined();
    expect(result.message).toBe('No provider selected.');
  });

  it('maps provider actions to modes and prompts', () => {
    const provider = {name: 'p', url: 'http://x', models: ['a', 'b'], key: 'k'} as const;
    expect(providerActionResult('add models', {...provider, models: ['a', 'b']})).toMatchObject({mode: 'providerAppendModels'});
    expect(providerActionResult('set API key', {...provider, models: ['a', 'b']})).toMatchObject({mode: 'providerSetKey', message: expect.stringContaining('saved')});
    expect(providerActionResult('remove models', {...provider, models: ['a', 'b']})).toMatchObject({mode: 'providerRemoveModels', message: expect.stringContaining('a, b')});
    expect(providerActionResult('remove provider', {...provider, models: ['a', 'b']})).toMatchObject({mode: 'providerConfirmRemove'});
    expect(providerActionResult('bogus', {...provider, models: ['a', 'b']})).toMatchObject({message: 'Unknown provider action: bogus'});
    expect(providerActionResult('use provider', undefined)).toMatchObject({mode: 'provider'});
  });
});

describe('chatgpt-codex URL divergence warning (F-14)', () => {
  it('warns when a ChatGPT sign-in provider points somewhere other than the canonical endpoint', () => {
    const canonical = {name: 'codex', url: 'https://chatgpt.com/backend-api/codex', kind: 'chatgpt-codex' as const, models: ['gpt-5.6-sol']};
    expect(chatgptCodexUrlWarning(canonical)).toBeUndefined();
    const diverged = {...canonical, url: 'https://my-proxy.example/v1'};
    expect(chatgptCodexUrlWarning(diverged)).toContain('always sends requests to https://chatgpt.com/backend-api/codex');
    expect(chatgptCodexUrlWarning(diverged)).toContain('my-proxy.example');
  });

  it('never warns for ordinary OpenAI-compatible providers', () => {
    expect(chatgptCodexUrlWarning({name: 'local', url: 'http://localhost:1234/v1', models: ['m']})).toBeUndefined();
  });

  it('appends the divergence warning when finishing a chatgpt-codex add', () => {
    const result = providerFinishAdd({providers: []}, {name: 'codex', url: 'https://my-proxy.example/v1', kind: 'chatgpt-codex'}, 'gpt-5.6-sol');
    expect(result.message).toContain('always sends requests to');
  });
});
