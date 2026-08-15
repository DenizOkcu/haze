import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {HazeSettings} from '../../../src/config/settings.js';
import {findPreset} from '../../../src/config/providerPresets.js';
import type {WizardDispatchDeps, WizardUiAction, WizardUiState} from '../../../src/cli/chat/wizardDispatch.js';
import type {Mode} from '../../../src/cli/commands/chatModes.js';

// Keep settings writes in-memory: wizardDispatch calls updateSettings on
// successful steps, and tests must not touch ~/.haze/settings.json.
const mocks = vi.hoisted(() => ({updateSettings: vi.fn(), discoverProviderModels: vi.fn()}));
vi.mock('../../../src/config/settings.js', async () => {
  const actual = await import('../../../src/config/settings.js');
  return {...actual, updateSettings: mocks.updateSettings};
});
vi.mock('../../../src/config/modelDiscovery.js', () => ({
  discoverProviderModels: mocks.discoverProviderModels,
  modelsEndpointUrl: (url: string) => `${url}/models`,
  parseModelsBody: () => [],
  // The wizard save path probes loopback URLs for native Ollama limits; tests
  // run against non-Ollama fakes, so resolve to no enrichment.
  ollamaModelLimits: async () => ({}),
}));

const {createWizardDispatch, initialWizardUiState, wizardUiReducer} = await import('../../../src/cli/chat/wizardDispatch.js');

type TestDeps = Parameters<typeof createWizardDispatch>[0];

const baseSettings = (): HazeSettings => ({
  providers: [{name: 'LM Studio', url: 'http://localhost:1234/v1', models: ['qwen3']}],
});

function makeDeps(overrides: Partial<TestDeps> & {wizard?: Partial<WizardUiState>} = {}): TestDeps {
  const {wizard: wizardOverrides, ...rest} = overrides;
  const deps = {
    settings: baseSettings(),
    skills: [],
    wizard: {...initialWizardUiState(), ...wizardOverrides},
    setMode: vi.fn(),
    setSettings: vi.fn(),
    showMessage: vi.fn(),
    refreshSkills: vi.fn(() => Promise.resolve()),
    setBusyLabel: vi.fn(),
    setBusy: vi.fn(),
    idleBusyLabel: 'Thinking',
    ...rest,
  } as TestDeps;
  // Mirror React state: updateWizard applies the real reducer so later
  // dispatches observe the new values, exactly like the next render would.
  deps.updateWizard = vi.fn((action: WizardUiAction) => { deps.wizard = wizardUiReducer(deps.wizard, action); });
  return deps;
}

const discovered = (models: string[]) => ({status: 'ok' as const, models});
const discoveryFailed = (error: string) => ({status: 'failed' as const, error});

describe('wizardDispatch session picker', () => {
  it('routes the selected session through resume and fork actions (F02)', async () => {
    const resumeSessionById = vi.fn().mockResolvedValue(true);
    const forkSessionById = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({
      sessions: [{id: 'session-1', createdAt: '2026-08-03T10:00:00Z', lastActivityAt: '2026-08-03T10:01:00Z', messageCount: 2, firstUserPreview: 'fix it', sizeBytes: 100, parseErrors: []}],
      resumeSessionById,
      forkSessionById,
    });
    const wizard = createWizardDispatch(deps);

    await wizard.dispatch('sessions', 'session-1');
    expect(deps.wizard.selectedSessionId).toBe('session-1');
    expect(deps.setMode).toHaveBeenLastCalledWith('sessionAction');

    await wizard.dispatch('sessionAction', 'fork');
    expect(forkSessionById).toHaveBeenCalledWith('session-1');
    expect(resumeSessionById).not.toHaveBeenCalled();
    expect(deps.setMode).toHaveBeenLastCalledWith('chat');
  });
});

describe('wizardDispatch provider actions with model discovery', () => {
  beforeEach(() => {
    mocks.updateSettings.mockReset();
    mocks.updateSettings.mockImplementation(async (patch: HazeSettings) => patch);
    mocks.discoverProviderModels.mockReset();
    mocks.discoverProviderModels.mockResolvedValue(discovered(['qwen3-coder', 'llama3.1']));
  });

  it('replaces the add-models prompt with a discovered-model picker', async () => {
    const deps = makeDeps();
    const wizard = createWizardDispatch(deps);

    await wizard.dispatch('provider', 'LM Studio');
    expect(deps.wizard.selectedProviderName).toBe('LM Studio');

    await wizard.dispatch('providerAction', 'add models');
    expect(mocks.discoverProviderModels).toHaveBeenCalledWith({url: 'http://localhost:1234/v1', key: undefined});
    expect(deps.setBusyLabel).toHaveBeenCalledWith('Discovering models on LM Studio');
    expect(deps.setBusy).toHaveBeenLastCalledWith(false);
    expect(deps.setMode).toHaveBeenLastCalledWith('modelPick');
    expect(deps.wizard.discoveredModels).toEqual(['qwen3-coder', 'llama3.1']);
    // Regression: the selected provider must survive action selection.
    expect(deps.wizard.selectedProviderName).toBe('LM Studio');
    expect(deps.showMessage).toHaveBeenLastCalledWith('Found 2 models on LM Studio. Choose one to add, or select "enter model names".');

    await wizard.dispatch('modelPick', 'qwen3-coder');
    const patch = mocks.updateSettings.mock.calls[0]?.[0] as HazeSettings;
    expect(patch.providers?.[0]?.models).toEqual(['qwen3', 'qwen3-coder']);
    expect(patch.provider).toBe('LM Studio');
    expect(deps.setMode).toHaveBeenLastCalledWith('model');
    expect(deps.wizard.modelProviderFilter).toBe('LM Studio');
    expect(deps.wizard.discoveredModels).toEqual([]);
  });

  it('falls back to the comma-separated prompt when discovery fails', async () => {
    mocks.discoverProviderModels.mockResolvedValue(discoveryFailed('timed out'));
    const deps = makeDeps();
    const wizard = createWizardDispatch(deps);

    await wizard.dispatch('provider', 'LM Studio');
    await wizard.dispatch('providerAction', 'add models');
    expect(deps.setMode).toHaveBeenLastCalledWith('providerAppendModels');
    expect(deps.showMessage).toHaveBeenLastCalledWith('Could not list models on LM Studio (timed out).\nComma-separated model names to add to LM Studio?');

    await wizard.dispatch('providerAppendModels', 'qwen3-coder');
    const patch = mocks.updateSettings.mock.calls[0]?.[0] as HazeSettings;
    expect(patch.providers?.[0]?.models).toEqual(['qwen3', 'qwen3-coder']);
  });

  it('offers the manual escape hatch from the discovered-model picker', async () => {
    const deps = makeDeps();
    const wizard = createWizardDispatch(deps);

    await wizard.dispatch('provider', 'LM Studio');
    await wizard.dispatch('providerAction', 'add models');
    await wizard.dispatch('modelPick', 'enter model names');
    expect(deps.setMode).toHaveBeenLastCalledWith('providerAppendModels');
    expect(deps.showMessage).toHaveBeenLastCalledWith('Comma-separated model names to add to LM Studio?');
    expect(deps.wizard.discoveredModels).toEqual([]);
  });

  it('adds free text typed in the picker even when it is not a discovered model', async () => {
    const deps = makeDeps();
    const wizard = createWizardDispatch(deps);

    await wizard.dispatch('provider', 'LM Studio');
    await wizard.dispatch('providerAction', 'add models');
    await wizard.dispatch('modelPick', 'my-finetune:latest');
    const patch = mocks.updateSettings.mock.calls[0]?.[0] as HazeSettings;
    expect(patch.providers?.[0]?.models).toEqual(['qwen3', 'my-finetune:latest']);
  });

  it('keeps the selected provider for set API key and remove provider actions', async () => {
    const deps = makeDeps();
    const wizard = createWizardDispatch(deps);

    await wizard.dispatch('provider', 'LM Studio');
    await wizard.dispatch('providerAction', 'set API key');
    expect(deps.wizard.selectedProviderName).toBe('LM Studio');
    expect(deps.setMode).toHaveBeenLastCalledWith('providerSetKey');

    await wizard.dispatch('providerAction', 'remove provider');
    expect(deps.wizard.selectedProviderName).toBe('LM Studio');
    expect(deps.setMode).toHaveBeenLastCalledWith('providerConfirmRemove');
  });

  it('toggles the image-capable flag and returns to chat (F03)', async () => {
    const deps = makeDeps();
    const wizard = createWizardDispatch(deps);

    await wizard.dispatch('provider', 'LM Studio');
    await wizard.dispatch('providerAction', 'mark image-capable');
    expect(mocks.updateSettings).toHaveBeenCalledWith({providers: [{name: 'LM Studio', url: 'http://localhost:1234/v1', models: ['qwen3'], capabilities: {images: true}}]});
    expect(deps.setMode).toHaveBeenLastCalledWith('chat');
    expect(deps.showMessage).toHaveBeenLastCalledWith(expect.stringContaining('marked image-capable'));
  });
});

describe('wizardDispatch /model add-models flow', () => {
  beforeEach(() => {
    mocks.updateSettings.mockReset();
    mocks.updateSettings.mockImplementation(async (patch: HazeSettings) => patch);
    mocks.discoverProviderModels.mockReset();
    mocks.discoverProviderModels.mockResolvedValue(discovered(['qwen3-coder']));
  });

  it('skips the provider picker when a provider filter is active', async () => {
    const deps = makeDeps({wizard: {modelProviderFilter: 'LM Studio'}});
    const wizard = createWizardDispatch(deps);

    await wizard.dispatch('model', 'add models');
    expect(deps.setMode).toHaveBeenLastCalledWith('modelPick');
    expect(deps.wizard.selectedProviderName).toBe('LM Studio');

    await wizard.dispatch('modelPick', 'qwen3-coder');
    const patch = mocks.updateSettings.mock.calls[0]?.[0] as HazeSettings;
    expect(patch.providers?.[0]?.models).toEqual(['qwen3', 'qwen3-coder']);
  });

  it('routes through the provider picker when no filter is active', async () => {
    const deps = makeDeps();
    const wizard = createWizardDispatch(deps);

    await wizard.dispatch('model', 'add models');
    expect(deps.setMode).toHaveBeenLastCalledWith('modelAddProvider');
    expect(deps.showMessage).toHaveBeenLastCalledWith('Choose a provider to add models to.');

    await wizard.dispatch('modelAddProvider', 'LM Studio');
    expect(deps.setMode).toHaveBeenLastCalledWith('modelPick');

    await wizard.dispatch('modelPick', 'qwen3-coder');
    const patch = mocks.updateSettings.mock.calls[0]?.[0] as HazeSettings;
    expect(patch.providers?.[0]?.models).toEqual(['qwen3', 'qwen3-coder']);
    expect(deps.setMode).toHaveBeenLastCalledWith('model');
  });

  it('reports unknown providers in the add-models provider picker', async () => {
    const deps = makeDeps();
    const wizard = createWizardDispatch(deps);

    await wizard.dispatch('model', 'add models');
    await wizard.dispatch('modelAddProvider', 'nope');
    expect(deps.setMode).toHaveBeenLastCalledWith('chat');
    expect(deps.showMessage).toHaveBeenLastCalledWith('No provider named nope. Use /provider and choose add provider.');
  });

  it('still selects existing models by provider-scoped selector', async () => {
    const deps = makeDeps();
    const wizard = createWizardDispatch(deps);

    await wizard.dispatch('model', 'LM Studio:qwen3');
    expect(mocks.updateSettings).toHaveBeenCalledWith({provider: 'LM Studio', model: 'qwen3'});
    expect(deps.setMode).toHaveBeenLastCalledWith('chat');
  });
});

describe('wizardDispatch provider creation discovery', () => {
  beforeEach(() => {
    mocks.updateSettings.mockReset();
    mocks.updateSettings.mockImplementation(async (patch: HazeSettings) => patch);
    mocks.discoverProviderModels.mockReset();
    mocks.discoverProviderModels.mockResolvedValue(discovered(['llama3.1', 'qwen3']));
  });

  it('lets the user pick the first model when creating a provider', async () => {
    const deps = makeDeps({wizard: {providerDraft: {name: 'lmstudio', url: 'http://localhost:1234/v1'}}});
    const wizard = createWizardDispatch(deps);

    await wizard.discoverProviderModelsForDraft(deps.wizard.providerDraft);
    expect(mocks.discoverProviderModels).toHaveBeenCalledWith({url: 'http://localhost:1234/v1', key: undefined});
    expect(deps.setMode).toHaveBeenLastCalledWith('modelPick');

    await wizard.dispatch('modelPick', 'llama3.1');
    const patch = mocks.updateSettings.mock.calls[0]?.[0] as HazeSettings;
    expect(patch.providers).toContainEqual({name: 'lmstudio', url: 'http://localhost:1234/v1', models: ['llama3.1']});
    expect(patch.provider).toBe('lmstudio');
    expect(deps.setMode).toHaveBeenLastCalledWith('model');
    expect(deps.wizard.modelProviderFilter).toBe('lmstudio');
    expect(deps.wizard.providerDraft).toEqual({});
  });

  it('falls back to the comma-separated prompt when discovery fails during creation', async () => {
    mocks.discoverProviderModels.mockResolvedValue(discoveryFailed('endpoint returned HTTP 404'));
    const deps = makeDeps({wizard: {providerDraft: {name: 'lmstudio', url: 'http://localhost:1234/v1'}}});
    const wizard = createWizardDispatch(deps);

    await wizard.discoverProviderModelsForDraft(deps.wizard.providerDraft);
    expect(deps.setMode).toHaveBeenLastCalledWith('providerAddModels');
    expect(deps.showMessage).toHaveBeenLastCalledWith('Could not list models on lmstudio (endpoint returned HTTP 404).\nComma-separated model names?');

    await wizard.dispatch('providerAddModels', 'llama3.1');
    const patch = mocks.updateSettings.mock.calls[0]?.[0] as HazeSettings;
    expect(patch.providers).toContainEqual({name: 'lmstudio', url: 'http://localhost:1234/v1', models: ['llama3.1']});
  });

  it('keeps the plain prompt when the draft is incomplete', async () => {
    const deps = makeDeps();
    const wizard = createWizardDispatch(deps);

    await wizard.discoverProviderModelsForDraft({});
    expect(deps.setMode).toHaveBeenLastCalledWith('providerAddModels');
    expect(mocks.discoverProviderModels).not.toHaveBeenCalled();
  });

  it('includes preset suggested models in the creation fallback prompt', async () => {
    mocks.discoverProviderModels.mockResolvedValue(discoveryFailed('endpoint returned HTTP 404'));
    const preset = findPreset('ollama')!;
    const deps = makeDeps({wizard: {providerDraft: {name: preset.name, url: preset.baseUrl}}});
    const wizard = createWizardDispatch(deps);

    await wizard.discoverProviderModelsForDraft(deps.wizard.providerDraft);
    expect(deps.setMode).toHaveBeenLastCalledWith('providerAddModels');
    const message = (deps.showMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string;
    expect(message).toContain(`Example: ${preset.suggestedModels!.join(', ')}`);
  });

  it('seeds suggested models from the chosen preset before discovery', async () => {
    const deps = makeDeps();
    const wizard = createWizardDispatch(deps);

    await wizard.dispatch('providerAddPreset', 'ollama');
    const preset = findPreset('ollama')!;
    expect(deps.wizard.suggestedModels).toEqual(preset.suggestedModels);
    expect(mocks.discoverProviderModels).toHaveBeenCalledWith({url: preset.baseUrl, key: undefined});
    expect(deps.setMode).toHaveBeenLastCalledWith('modelPick');
  });

  it('seeds suggested models for cloud presets before the key step', async () => {
    const deps = makeDeps();
    const wizard = createWizardDispatch(deps);

    await wizard.dispatch('providerAddPreset', 'deepseek');
    const preset = findPreset('deepseek')!;
    expect(deps.wizard.suggestedModels).toEqual(preset.suggestedModels);
    expect(deps.setMode).toHaveBeenLastCalledWith('providerAddKey');
  });
});

describe('inputSuggestionsForState modelAddProvider mode', () => {
  it('lists configured providers without an add-provider entry', async () => {
    const {inputSuggestionsForState} = await import('../../../src/cli/chat/inputSuggestions.js');
    const suggestions = inputSuggestionsForState({
      mode: 'modelAddProvider' as Mode,
      settings: baseSettings(),
      skills: [],
    });
    expect(suggestions.map(suggestion => suggestion.value)).toEqual(['LM Studio']);
  });
});
