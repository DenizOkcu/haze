import {describe, expect, it} from 'vitest';
import type {HazeSettings} from '../../src/config/settings.js';
import type {LoadedSkill} from '../../src/skills/types.js';
import {
  providerSuggestions,
  providerActionSuggestions,
  presetSuggestions,
  modelSuggestions,
  lspSuggestions,
  lspActionSuggestions,
  mcpSuggestions,
  mcpActionSuggestions,
  mcpTransportSuggestions,
  skillsSuggestions,
  skillsActionSuggestions,
} from '../../src/cli/commands/wizardSuggestions.js';

const settings = (overrides: Partial<HazeSettings> = {}): HazeSettings => ({...overrides});

describe('providerSuggestions', () => {
  it('lists configured providers plus the add-provider entry', () => {
    const s = settings({providers: [{name: 'openrouter', url: 'https://openrouter.ai/api/v1', models: ['a', 'b']}]});
    const result = providerSuggestions(s);
    expect(result.map(r => r.value)).toEqual(['openrouter', 'add provider']);
    expect(result[0]?.description).toContain('2 models');
    expect(result[0]?.kind).toBe('provider');
  });

  it('singularizes the model count for a single model', () => {
    const s = settings({providers: [{name: 'local', url: 'http://x/v1', models: ['only']}]});
    expect(providerSuggestions(s)[0]?.description).toContain('1 model');
  });
});

describe('providerActionSuggestions', () => {
  it('offers remove-models only when the provider has models', () => {
    const withModels = settings({providers: [{name: 'p', url: 'u', models: ['m']}]});
    const empty = settings({providers: [{name: 'p', url: 'u', models: []}]});
    expect(providerActionSuggestions(withModels, 'p').map(r => r.value)).toContain('remove models');
    expect(providerActionSuggestions(empty, 'p').map(r => r.value)).not.toContain('remove models');
  });

  it('adapts the API-key label to whether a key is saved', () => {
    const withKey = settings({providers: [{name: 'p', url: 'u', key: 'k', models: []}]});
    const noKey = settings({providers: [{name: 'p', url: 'u', models: []}]});
    expect(providerActionSuggestions(withKey, 'p').find(r => r.value === 'set API key')?.description).toBe('Update the saved API key');
    expect(providerActionSuggestions(noKey, 'p').find(r => r.value === 'set API key')?.description).toBe('Add an API key');
  });
});

describe('presetSuggestions', () => {
  it('always includes the manual custom entry', () => {
    expect(presetSuggestions().map(r => r.value)).toContain('custom');
  });
});

describe('modelSuggestions', () => {
  it('scopes to a provider filter when provided', () => {
    const s = settings({providers: [
      {name: 'a', url: 'ua', models: ['m1']},
      {name: 'b', url: 'ub', models: ['m2']},
    ]});
    expect(modelSuggestions(s, 'a').map(r => r.value)).toEqual(['m1']);
    // Unfiltered: model values are provider-scoped selectors.
    expect(modelSuggestions(s, undefined).map(r => r.value)).toEqual(['a:m1', 'b:m2']);
  });
});

describe('lspSuggestions / lspActionSuggestions', () => {
  it('reports enabled/disabled state and toggles the action label', () => {
    const s = settings({lspServers: [{name: 'typescript', command: 'tsls', args: ['--stdio'], enabled: false}]});
    expect(lspSuggestions(s).find(r => r.value === 'typescript')?.description).toContain('disabled');
    expect(lspActionSuggestions(s, 'typescript').find(r => r.value === 'enable')).toBeTruthy();
    expect(lspActionSuggestions(s, 'unknown').some(r => r.value === 'enable')).toBe(false);
  });
});

describe('mcpSuggestions / mcpActionSuggestions', () => {
  it('adapts the set-API-key label to whether headers exist', () => {
    const withHeaders = settings({mcpServers: [{name: 'c7', transport: 'http', url: 'https://x', headers: [{name: 'Authorization', value: 'Bearer y'}]}]});
    const bare = settings({mcpServers: [{name: 'c7', transport: 'http', url: 'https://x'}]});
    expect(mcpActionSuggestions(withHeaders, 'c7').find(r => r.value === 'set API key')?.description).toBe('update the saved API key');
    expect(mcpActionSuggestions(bare, 'c7').find(r => r.value === 'set API key')?.description).toBe('add an API key');
  });
});

describe('mcpTransportSuggestions', () => {
  it('lists the three transports', () => {
    expect(mcpTransportSuggestions().map(r => r.value).sort()).toEqual(['http', 'sse', 'stdio']);
  });
});

describe('skillsSuggestions / skillsActionSuggestions', () => {
  const skills: LoadedSkill[] = [
    {name: 'review', description: 'code review', dir: '/tmp/review', references: [], body: ''} as LoadedSkill,
  ];

  it('flags disabled skills in the list', () => {
    const s = settings({skills: [{name: 'review', enabled: false}]});
    expect(skillsSuggestions(s, skills).find(r => r.value === 'review')?.description).toContain('disabled');
  });

  it('toggles enable/disable based on state and always offers remove', () => {
    const enabled = settings({});
    const disabled = settings({skills: [{name: 'review', enabled: false}]});
    expect(skillsActionSuggestions(enabled, skills, 'review').map(r => r.value)).toContain('disable');
    expect(skillsActionSuggestions(disabled, skills, 'review').map(r => r.value)).toContain('enable');
    expect(skillsActionSuggestions(enabled, skills, 'review').map(r => r.value)).toContain('remove skill');
  });
});
