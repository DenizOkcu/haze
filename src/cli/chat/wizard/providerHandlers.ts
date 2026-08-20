import type {HazeProviderSettings} from '../../../config/settings.js';
import {setProviderAuth, removeProviderAuth} from '../../../config/providerAuth.js';
import {findProvider, modelSelector, resolveModelSelector, upsertProvider} from '../../../config/providers.js';
import {discoverProviderModels, ollamaModelLimits, type HarvestedModelLimits} from '../../../config/modelDiscovery.js';
import {findPreset, presetModelLimitsForModels, PROVIDER_PRESETS} from '../../../config/providerPresets.js';
import {isLocalProviderUrl} from '../../../llm/client.js';
import {FALLBACK_LOCAL_CONTEXT_TOKENS} from '../../../core/agent/contextBudget.js';
import type {Mode} from '../../commands/chatModes.js';
import {PROVIDER_ACTIONS, PROVIDER_CHOICES, MODEL_CHOICES, commaList, isYesConfirmation} from '../../commands/wizardFlow.js';
import {chatgptCodexUrlWarning, providerActionResult, providerAppendModels, providerFinishAdd, providerRemove, providerRemoveModels, providerSetImageCapable, providerSetKey} from '../../commands/providerWizard.js';
import {startupProviderInfo} from '../startupInfo.js';
import {openBrowser, startChatGptBrowserLogin} from '../../../llm/openaiCodexOAuth.js';
import type {WizardDispatchDeps, WizardHandler, WizardSetterContext} from './types.js';

/**
 * Provider/model wizard handlers: provider picker and actions, preset-driven
 * add flow (including ChatGPT OAuth), model picker, model discovery, and the
 * add/append/remove-models steps.
 */
export function createProviderWizardHandlers(deps: WizardDispatchDeps, ctx: WizardSetterContext): {handlers: Partial<Record<Mode, WizardHandler>>; discoverProviderModelsForDraft: (draft: Partial<HazeProviderSettings>) => Promise<void>} {
  const {setMode, showMessage} = ctx;
  const setSelectedProviderName = ctx.setSelectedProviderName;
  const setModelProviderFilter = ctx.setModelProviderFilter;
  const setProviderDraft = ctx.setProviderDraft;
  const setDiscoveredModels = ctx.setDiscoveredModels;
  const setSuggestedModels = ctx.setSuggestedModels;

  // Limits harvested from the provider's own /models listing during the most
  // recent discovery. Written through with the models being added (provider-
  // specific and fresher than the static preset catalog) and cleared when a
  // flow restarts, so stale harvests never leak into a later add.
  let lastDiscoveredLimits: HarvestedModelLimits = {};

  async function selectProvider(providerName: string) {
    if (providerName === PROVIDER_CHOICES.addProvider) {
      setProviderDraft({});
      setMode('providerAddPreset');
      showMessage('Choose a provider preset, or select "custom" to enter details manually.');
      return;
    }
    const provider = findProvider(deps.settings, providerName);
    if (!provider) {
      showMessage(`No provider named ${providerName}. Use /provider and choose add provider.`);
      setMode('chat');
      return;
    }
    setSelectedProviderName(provider.name);
    setMode('providerAction');
    // Surface canonical-endpoint divergence for ChatGPT sign-in providers up
    // front: a hand-edited URL is silently ignored by the Codex fetch (F-14).
    const divergence = chatgptCodexUrlWarning(provider);
    showMessage(`${provider.name}: choose an action.${divergence ? `\n${divergence}` : ''}`);
  }

  async function loginWithChatGpt(input: {name: string; url: string; models: string[]; existing?: HazeProviderSettings}) {
    deps.setBusyLabel('Waiting for ChatGPT sign-in');
    deps.setBusy(true);
    let login: Awaited<ReturnType<typeof startChatGptBrowserLogin>> | undefined;
    try {
      login = await startChatGptBrowserLogin();
      showMessage(`Complete ChatGPT sign-in in your browser.\nIf it does not open, visit:\n${login.url}`);
      await openBrowser(login.url);
      const auth = await login.complete();
      await setProviderAuth(input.name, auth);
      if (input.existing) {
        showMessage(`ChatGPT sign-in updated for ${input.name}.`);
        setSelectedProviderName(undefined);
        setMode('chat');
        return;
      }
      const provider: HazeProviderSettings = {name: input.name, url: input.url, kind: 'chatgpt-codex', models: input.models, ...presetModelLimitsForModels({name: input.name, url: input.url}, input.models)};
      await ctx.applySettings({providers: upsertProvider(deps.settings, provider), provider: provider.name, model: undefined});
      setProviderDraft({});
      setSuggestedModels([]);
      setModelProviderFilter(provider.name);
      setMode('model');
      showMessage(`ChatGPT connected as ${provider.name}. Choose a model explicitly.`);
    } catch (error) {
      await login?.close().catch(() => undefined);
      showMessage(`ChatGPT sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
      setProviderDraft({});
      setMode('chat');
    } finally {
      deps.setBusy(false);
      deps.setBusyLabel(deps.idleBusyLabel);
    }
  }

  async function discoverModelsFor(target: {name?: string; url?: string; key?: string; kind?: HazeProviderSettings['kind']}, fallbackPrompt: string) {
    if (!target.name || !target.url) {
      showMessage('Provider name and URL are required to discover models.');
      setMode('chat');
      return;
    }
    const existing = findProvider(deps.settings, target.name);
    if (target.kind === 'chatgpt-codex' || existing?.kind === 'chatgpt-codex') {
      setSelectedProviderName(target.name);
      setMode(existing ? 'providerAppendModels' : 'providerAddModels');
      showMessage(fallbackPrompt);
      return;
    }
    deps.setBusyLabel(`Discovering models on ${target.name}`);
    deps.setBusy(true);
    let result: Awaited<ReturnType<typeof discoverProviderModels>>;
    try {
      result = await discoverProviderModels({url: target.url, key: target.key});
    } finally {
      deps.setBusy(false);
      deps.setBusyLabel(deps.idleBusyLabel);
    }
    if (result.status === 'ok') {
      setDiscoveredModels(result.models);
      lastDiscoveredLimits = result.modelLimits ?? {};
      setMode('modelPick');
      showMessage(`Found ${result.models.length} model${result.models.length === 1 ? '' : 's'} on ${target.name}. Choose one to add, or select "${MODEL_CHOICES.enterModelNames}".`);
      return;
    }
    lastDiscoveredLimits = {};
    setMode(existing ? 'providerAppendModels' : 'providerAddModels');
    showMessage(`Could not list models on ${target.name} (${result.error}).\n${fallbackPrompt}`);
  }

  async function selectPreset(presetId: string) {
    if (presetId === PROVIDER_CHOICES.custom) {
      setProviderDraft({});
      setMode('providerAddName');
      showMessage('Provider name? Example: openrouter, local, lmstudio.');
      return;
    }

    const preset = findPreset(presetId);
    if (!preset) {
      showMessage(`Unknown preset: ${presetId}.`);
      return;
    }

    // Check if a provider with this name already exists
    const existingName = deps.settings.providers?.some(p => p.name === preset.name) ? preset.id : preset.name;
    const nameConflict = deps.settings.providers?.some(p => p.name === existingName);
    if (nameConflict) {
      showMessage(`Provider ${existingName} already exists. Use /provider to manage existing providers.`);
      setMode('chat');
      setProviderDraft({});
      return;
    }

    setProviderDraft({name: existingName, url: preset.baseUrl, ...(preset.auth === 'chatgpt-oauth' ? {kind: 'chatgpt-codex' as const} : {})});
    setSuggestedModels(preset.suggestedModels ?? []);

    if (preset.auth === 'chatgpt-oauth') {
      await loginWithChatGpt({name: existingName, url: preset.baseUrl, models: preset.suggestedModels ?? []});
    } else if (preset.needsApiKey) {
      setMode('providerAddKey');
      const keyHint = preset.apiKeyHint ?? (preset.apiKeyEnvVar ? `commonly ${preset.apiKeyEnvVar}` : undefined);
      showMessage(`${preset.name} (${preset.baseUrl})\nAPI key${keyHint ? ` (${keyHint})` : ''}?`);
    } else {
      // Local/keyless: no API key step — jump straight to model discovery
      const hint = preset.suggestedModels?.length ? ` Example: ${preset.suggestedModels.join(', ')}` : '';
      await discoverModelsFor({name: existingName, url: preset.baseUrl}, `Comma-separated model names?${hint}`);
    }
  }

  async function useProvider(providerName: string) {
    const provider = findProvider(deps.settings, providerName);
    if (!provider) {
      showMessage(`No provider named ${providerName}.`);
      setMode('chat');
      setSelectedProviderName(undefined);
      return;
    }
    await ctx.applySettings({provider: provider.name});
    setSelectedProviderName(undefined);
    setModelProviderFilter(provider.name);
    setMode('model');
    showMessage(`Provider set to ${provider.name}. Choose a model.`);
  }

  async function selectProviderAction(action: string) {
    if (!deps.wizard.selectedProviderName) {
      setMode('provider');
      return;
    }
    const provider = findProvider(deps.settings, deps.wizard.selectedProviderName);
    if (!provider) {
      showMessage(`Provider ${deps.wizard.selectedProviderName} not found.`);
      setMode('chat');
      setSelectedProviderName(undefined);
      return;
    }
    if (action === PROVIDER_ACTIONS.useProvider) {
      await useProvider(deps.wizard.selectedProviderName);
      return;
    }
    if (action === PROVIDER_ACTIONS.markImageCapable || action === PROVIDER_ACTIONS.clearImageCapable) {
      const result = providerSetImageCapable(deps.settings, deps.wizard.selectedProviderName, action === PROVIDER_ACTIONS.markImageCapable);
      if (result.settingsPatch) await ctx.applySettings(result.settingsPatch);
      setSelectedProviderName(undefined);
      setMode('chat');
      showMessage(result.message);
      return;
    }
    if (action === PROVIDER_ACTIONS.addModels) {
      setSelectedProviderName(provider.name);
      if (provider.kind === 'chatgpt-codex') {
        setMode('providerAppendModels');
        showMessage(`Comma-separated supported Codex model names to add to ${provider.name}?`);
      } else await discoverModelsFor(provider, `Comma-separated model names to add to ${provider.name}?`);
      return;
    }
    if (action === PROVIDER_ACTIONS.signInChatGpt && provider.kind === 'chatgpt-codex') {
      await loginWithChatGpt({name: provider.name, url: provider.url, models: provider.models, existing: provider});
      return;
    }
    const actionResult = providerActionResult(action, provider);
    if ('selectedName' in actionResult) setSelectedProviderName(actionResult.selectedName);
    if (actionResult.mode) setMode(actionResult.mode);
    showMessage(actionResult.message);
  }

  async function selectModel(selector: string) {
    if (selector === MODEL_CHOICES.addModels) {
      const filteredProvider = deps.wizard.modelProviderFilter ? findProvider(deps.settings, deps.wizard.modelProviderFilter) : undefined;
      if (filteredProvider) {
        setSelectedProviderName(filteredProvider.name);
        await discoverModelsFor(filteredProvider, `Comma-separated model names to add to ${filteredProvider.name}?`);
        return;
      }
      setMode('modelAddProvider');
      showMessage('Choose a provider to add models to.');
      return;
    }
    const scopedSelector = deps.wizard.modelProviderFilter ? `${deps.wizard.modelProviderFilter}:${selector}` : selector;
    const resolved = resolveModelSelector(deps.settings, scopedSelector);
    if (resolved.status === 'ambiguous') {
      showMessage(`Model ${resolved.model} exists on multiple providers: ${resolved.providers.map(provider => modelSelector(provider, resolved.model)).join(', ')}`);
      return;
    }
    if (resolved.status === 'missing') {
      showMessage(`No configured model named ${selector}. Select "add models" in /model to fetch and add it from a provider.`);
      return;
    }
    const next = await ctx.applySettings({provider: resolved.provider.name, model: resolved.model});
    setModelProviderFilter(undefined);
    setMode('chat');
    showMessage(`Model set to ${resolved.model} on ${resolved.provider.name}.\n\n${startupProviderInfo(next)}`);
  }

  async function selectProviderForAddModels(providerName: string) {
    const provider = findProvider(deps.settings, providerName);
    if (!provider) {
      showMessage(`No provider named ${providerName}. Use /provider and choose add provider.`);
      setMode('chat');
      return;
    }
    setSelectedProviderName(provider.name);
    await discoverModelsFor(provider, `Comma-separated model names to add to ${provider.name}?`);
  }

  async function pickModelToAdd(value: string) {
    const provider = deps.wizard.selectedProviderName ? findProvider(deps.settings, deps.wizard.selectedProviderName) : undefined;
    if (value === MODEL_CHOICES.enterModelNames) {
      setDiscoveredModels([]);
      setSuggestedModels([]);
      lastDiscoveredLimits = {};
      if (provider) {
        setMode('providerAppendModels');
        showMessage(`Comma-separated model names to add to ${provider.name}?`);
        return;
      }
      setMode('providerAddModels');
      showMessage('Comma-separated model names?');
      return;
    }
    // Anything typed — picked suggestion or free text — is added as model
    // names, so the flow never dead-ends when the list is incomplete.
    if (provider) {
      await appendModelsToProvider(value);
      return;
    }
    await finishProviderAdd(value);
  }

  async function discoverProviderModelsForDraft(draft: Partial<HazeProviderSettings>) {
    if (!draft.name || !draft.url) {
      setMode('providerAddModels');
      showMessage('Comma-separated model names?');
      return;
    }
    // Preset match by URL restores curated hints on the cloud key-step path.
    const preset = PROVIDER_PRESETS.find(candidate => draft.url === candidate.baseUrl);
    const hint = preset?.suggestedModels?.length ? ` Example: ${preset.suggestedModels.join(', ')}` : '';
    await discoverModelsFor({name: draft.name, url: draft.url, key: draft.key, kind: draft.kind}, `Comma-separated model names?${hint}`);
  }

  /**
   * Native Ollama enrichment at save time (the one place that knows the exact
   * model ids being added): /v1/models reports nothing for Ollama, but /api/ps
   * exposes the actually-loaded runtime context and /api/show the model's
   * declared maximum. Probed only for the user's loopback server; the cap for
   * a declared maximum (which may exceed the VRAM-sized effective window) is
   * the user's own local fallback setting, defaulting to 32K. Failures are
   * ignored — providers that are not Ollama simply 404 the /api/* paths.
   */
  async function localNativeLimits(url: string | undefined, models: readonly string[]): Promise<HarvestedModelLimits> {
    if (!url || !isLocalProviderUrl(url) || models.length === 0) return {};
    const conservativeCap = deps.settings.localContextWindowFallbackTokens ?? FALLBACK_LOCAL_CONTEXT_TOKENS;
    return await ollamaModelLimits({baseUrl: url, models, conservativeCap}).catch(() => ({}));
  }

  async function appendModelsToProvider(modelsValue: string) {
    const provider = deps.wizard.selectedProviderName ? findProvider(deps.settings, deps.wizard.selectedProviderName) : undefined;
    if (provider) {
      const native = await localNativeLimits(provider.url, commaList(modelsValue));
      if (Object.keys(native).length > 0) lastDiscoveredLimits = {...lastDiscoveredLimits, ...native};
    }
    const result = providerAppendModels(deps.settings, deps.wizard.selectedProviderName, modelsValue, lastDiscoveredLimits);
    if (!result.provider) {
      setDiscoveredModels([]);
      setSuggestedModels([]);
      lastDiscoveredLimits = {};
      showMessage(result.message);
      setMode('chat');
      return;
    }
    if (!result.settingsPatch) {
      showMessage(result.message);
      return;
    }
    await ctx.applySettings(result.settingsPatch);
    setSelectedProviderName(undefined);
    setDiscoveredModels([]);
    setSuggestedModels([]);
    lastDiscoveredLimits = {};
    setModelProviderFilter(result.provider.name);
    setMode('model');
    showMessage(result.message);
  }

  async function finishProviderAdd(modelsValue: string) {
    const native = await localNativeLimits(deps.wizard.providerDraft.url, commaList(modelsValue));
    if (Object.keys(native).length > 0) lastDiscoveredLimits = {...lastDiscoveredLimits, ...native};
    const result = providerFinishAdd(deps.settings, deps.wizard.providerDraft, modelsValue, lastDiscoveredLimits);
    if (!result.provider || !result.settingsPatch) {
      showMessage(result.message);
      setMode('chat');
      setProviderDraft({});
      setDiscoveredModels([]);
      setSuggestedModels([]);
      lastDiscoveredLimits = {};
      return;
    }
    await ctx.applySettings(result.settingsPatch);
    setProviderDraft({});
    setDiscoveredModels([]);
    setSuggestedModels([]);
    lastDiscoveredLimits = {};
    setModelProviderFilter(result.provider.name);
    setMode('model');
    showMessage(result.message);
  }

  async function providerSetKeyMode(value: string) {
    const result = providerSetKey(deps.settings, deps.wizard.selectedProviderName, value);
    if (!result.provider) {
      showMessage(result.message);
      setMode('chat');
      return;
    }
    if (!result.settingsPatch) {
      showMessage(result.message);
      return;
    }
    await ctx.applySettings(result.settingsPatch);
    setSelectedProviderName(undefined);
    setMode('chat');
    showMessage(result.message);
  }

  async function providerRemoveModelsMode(value: string) {
    const result = providerRemoveModels(deps.settings, deps.wizard.selectedProviderName, value);
    if (!result.provider) {
      showMessage(result.message);
      setMode('chat');
      return;
    }
    if (!result.settingsPatch) {
      showMessage(result.message);
      return;
    }
    await ctx.applySettings(result.settingsPatch);
    setSelectedProviderName(undefined);
    setMode('chat');
    showMessage(result.message);
  }

  async function providerConfirmRemoveMode(value: string) {
    const provider = deps.wizard.selectedProviderName ? findProvider(deps.settings, deps.wizard.selectedProviderName) : undefined;
    if (!provider) {
      showMessage('No provider selected.');
      setMode('chat');
      return;
    }
    if (!isYesConfirmation(value)) {
      showMessage('Cancelled. Provider not removed.');
      setSelectedProviderName(undefined);
      setMode('chat');
      return;
    }
    const result = providerRemove(deps.settings, deps.wizard.selectedProviderName);
    await ctx.applySettings(result.settingsPatch ?? {});
    await removeProviderAuth(provider.name);
    setSelectedProviderName(undefined);
    setMode('chat');
    showMessage(result.message);
  }

  return {
    handlers: {
      provider: selectProvider,
      providerAction: selectProviderAction,
      providerAddPreset: selectPreset,
      model: selectModel,
      modelAddProvider: selectProviderForAddModels,
      modelPick: pickModelToAdd,
      providerAddModels: finishProviderAdd,
      providerAppendModels: appendModelsToProvider,
      providerSetKey: providerSetKeyMode,
      providerRemoveModels: providerRemoveModelsMode,
      providerConfirmRemove: providerConfirmRemoveMode,
    },
    discoverProviderModelsForDraft,
  };
}
