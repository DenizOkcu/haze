import {describe, expect, it} from 'vitest';
import {providerActionResult, providerAppendModels, providerFinishAdd, providerRemove, providerRemoveModels} from '../../src/cli/commands/providerWizard.js';

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

  it('creates a provider from draft and model input', () => {
    const result = providerFinishAdd({}, {name: 'remote', url: 'https://x/v1', key: 'k'}, 'a, a, b');
    expect(result.provider).toEqual({name: 'remote', url: 'https://x/v1', key: 'k', models: ['a', 'b']});
    expect(result.settingsPatch?.provider).toBe('remote');
  });

  it('removes models and updates active model when necessary', () => {
    const result = providerRemoveModels(settings, 'local', 'old, missing');
    expect(result.settingsPatch?.model).toBe('keep');
    expect(result.message).toContain('Not found: missing.');
  });

  it('removes providers and switches active provider when needed', () => {
    const result = providerRemove(settings, 'local');
    expect(result.settingsPatch).toEqual({providers: [], provider: undefined, model: undefined});
    expect(result.message).toContain('Switched to no provider');
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
