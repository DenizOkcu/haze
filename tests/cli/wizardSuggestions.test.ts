import {describe, expect, it} from 'vitest';
import type {HazeSettings} from '../../src/config/settings.js';
import type {LoadedSkill} from '../../src/skills/types.js';
import {BUILT_IN_THEME_SPECS} from '../../src/ui/theme.js';
import {
  providerSuggestions,
  providerActionSuggestions,
  presetSuggestions,
  modelSuggestions,
  modelAddProviderSuggestions,
  modelPickSuggestions,
  lspSuggestions,
  lspActionSuggestions,
  mcpSuggestions,
  mcpActionSuggestions,
  mcpTransportSuggestions,
  skillsSuggestions,
  skillsActionSuggestions,
  skillScopeSuggestions,
  themeSuggestions,
} from '../../src/cli/commands/wizardFlow.js';

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

  it('offers ChatGPT sign-in instead of an API-key prompt for Codex OAuth providers', () => {
    const codex = settings({providers: [{name: 'chatgpt', url: 'https://chatgpt.com/backend-api/codex', kind: 'chatgpt-codex', models: ['gpt-5.4']}]});
    const actions = providerActionSuggestions(codex, 'chatgpt').map(result => result.value);
    expect(actions).toContain('sign in with ChatGPT');
    expect(actions).not.toContain('set API key');
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

  it('labels the ChatGPT preset as browser sign-in', () => {
    expect(presetSuggestions().find(result => result.value === 'openai-subscription')?.description).toContain('browser sign-in');
  });
});

describe('modelSuggestions', () => {
  it('scopes to a provider filter when provided', () => {
    const s = settings({providers: [
      {name: 'a', url: 'ua', models: ['m1']},
      {name: 'b', url: 'ub', models: ['m2']},
    ]});
    expect(modelSuggestions(s, 'a').map(r => r.value)).toEqual(['m1', 'add models']);
    // Unfiltered: model values are provider-scoped selectors.
    expect(modelSuggestions(s, undefined).map(r => r.value)).toEqual(['a:m1', 'b:m2', 'add models']);
  });

  it('adapts the add-models description to the provider filter', () => {
    const s = settings({providers: [{name: 'lmstudio', url: 'http://localhost:1234/v1', models: ['m1']}]});
    expect(modelSuggestions(s, 'lmstudio').find(r => r.value === 'add models')?.description).toContain('Add models to lmstudio');
    expect(modelSuggestions(s, undefined).find(r => r.value === 'add models')?.description).toContain('Add models to a provider');
  });
});

describe('modelAddProviderSuggestions', () => {
  it('lists configured providers without the add-provider entry', () => {
    const s = settings({providers: [
      {name: 'openrouter', url: 'https://openrouter.ai/api/v1', models: ['a', 'b']},
      {name: 'lmstudio', url: 'http://localhost:1234/v1', models: ['m']},
    ]});
    const result = modelAddProviderSuggestions(s);
    expect(result.map(r => r.value)).toEqual(['openrouter', 'lmstudio']);
    expect(result[0]?.description).toBe('2 models configured');
    expect(result[1]?.description).toBe('1 model configured');
  });
});

describe('modelPickSuggestions', () => {
  const s = settings({providers: [{name: 'lmstudio', url: 'http://localhost:1234/v1', models: ['qwen3']}]});

  it('offers discovered models minus the configured ones, plus the manual escape hatch', () => {
    const result = modelPickSuggestions(s, 'lmstudio', ['qwen3', 'llama3.1', 'mistral']);
    expect(result.map(r => r.value)).toEqual(['llama3.1', 'mistral', 'enter model names']);
    expect(result[0]?.kind).toBe('model');
    expect(result.at(-1)?.description).toContain('comma-separated');
  });

  it('supports provider drafts that are not saved yet', () => {
    const result = modelPickSuggestions({}, 'new-provider', ['a', 'b']);
    expect(result.map(r => r.value)).toEqual(['a', 'b', 'enter model names']);
  });

  it('pins curated suggestions that the endpoint actually serves', () => {
    const result = modelPickSuggestions(s, 'lmstudio', ['alpha', 'beta', 'gamma'], ['gamma', 'alpha']);
    expect(result.map(r => r.value)).toEqual(['gamma', 'alpha', 'beta', 'enter model names']);
    expect(result[0]?.description).toBe('suggested');
    expect(result[2]?.description).toBe('lmstudio');
  });

  it('drops stale suggestions the endpoint no longer serves', () => {
    const result = modelPickSuggestions(s, 'lmstudio', ['alpha', 'beta'], ['retired-model', 'beta']);
    expect(result.map(r => r.value)).toEqual(['beta', 'alpha', 'enter model names']);
  });

  it('does not pin suggestions that are already configured', () => {
    const result = modelPickSuggestions(s, 'lmstudio', ['qwen3', 'alpha'], ['qwen3', 'alpha']);
    expect(result.map(r => r.value)).toEqual(['alpha', 'enter model names']);
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

describe('themeSuggestions', () => {
  it('lists every built-in theme and marks the active one', () => {
    const suggestions = themeSuggestions({theme: 'robbyrussell'});
    expect(suggestions.map(suggestion => suggestion.value)).toEqual(Object.keys(BUILT_IN_THEME_SPECS));
    expect(suggestions.find(suggestion => suggestion.value === 'robbyrussell')?.description).toContain('active');
    expect(suggestions.find(suggestion => suggestion.value === 'purple')?.description).not.toContain('active');
    expect(suggestions[0]?.kind).toBe('theme');
  });

  it('treats the default theme as active when none is set', () => {
    expect(themeSuggestions({}).find(suggestion => suggestion.value === 'purple')?.description).toContain('active');
  });

  it('labels light and dark palettes', () => {
    const suggestions = themeSuggestions({});
    expect(suggestions.find(suggestion => suggestion.value === 'light')?.description).toContain('light palette');
    expect(suggestions.find(suggestion => suggestion.value === 'solarized-light')?.description).toContain('light palette');
    expect(suggestions.find(suggestion => suggestion.value === 'purple')?.description).toContain('dark palette');
    expect(suggestions.find(suggestion => suggestion.value === 'solarized-dark')?.description).toContain('dark palette');
  });
});

describe('skillsSuggestions / skillsActionSuggestions', () => {
  it('offers an explicit project or global creation scope', () => {
    expect(skillScopeSuggestions().map(item => item.value)).toEqual(['this project', 'global']);
  });

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
