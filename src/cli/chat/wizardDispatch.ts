import fs from 'fs-extra';
import type {HazeMcpServer, HazeProviderSettings, HazeSettings} from '../../config/settings.js';
import type {HazeLspServer} from '../../config/lspSettings.js';
import {updateSettings} from '../../config/settings.js';
import {removeProviderAuth, setProviderAuth} from '../../config/providerAuth.js';
import {findProvider, modelSelector, resolveModelSelector, upsertProvider} from '../../config/providers.js';
import {discoverProviderModels} from '../../config/modelDiscovery.js';
import {removeLspServer} from '../../config/lspSettings.js';
import {removeMcpServer} from '../../config/mcpSettings.js';
import {findPreset, presetModelLimitsForModels, PROVIDER_PRESETS} from '../../config/providerPresets.js';
import {ollamaModelLimits, type HarvestedModelLimits} from '../../config/modelDiscovery.js';
import {isLocalProviderUrl} from '../../llm/client.js';
import {FALLBACK_LOCAL_CONTEXT_TOKENS} from '../../core/agent/contextBudget.js';
import {loadSkillRegistry} from '../../skills/SkillRegistry.js';
import {createSkill, toSkillDirName} from '../../skills/builder/SkillBuilder.js';
import type {LoadedSkill, SkillSource} from '../../skills/types.js';
import type {SessionSummary} from '../../core/session/sessionStore.js';
import type {Mode} from '../commands/chatModes.js';
import {PROVIDER_ACTIONS, PROVIDER_CHOICES, MODEL_CHOICES, SERVER_CHOICES, captureLspName, captureMcpCommand, captureMcpName, captureMcpTransport, captureMcpUrl, captureProviderName, captureProviderUrl, commaList, isYesConfirmation} from '../commands/wizardFlow.js';
import {finishLspCustomResult, selectLspActionResult, selectLspPresetResult, selectLspServerResult, finishMcpCustomResult, selectMcpActionResult, selectMcpPresetResult, selectMcpServerResult, setMcpServerKeyResult} from '../commands/serverWizard.js';
import {chatgptCodexUrlWarning, providerActionResult, providerAppendModels, providerFinishAdd, providerRemove, providerRemoveModels, providerSetImageCapable, providerSetKey} from '../commands/providerWizard.js';
import {selectSkillActionResult, selectSkillResult, captureSkillDescription as captureSkillDescriptionResult, skillCreationFailure, skillCreationMessage, skillConfirmRemoveResult as skillConfirmRemove} from '../commands/skillsWizard.js';
import {selectThemeResult} from '../commands/themesCommand.js';
import {startupProviderInfo} from './startupInfo.js';
import {SESSION_ACTIONS} from '../commands/sessionPicker.js';
import {openBrowser, startChatGptBrowserLogin} from '../../llm/openaiCodexOAuth.js';

/**
 * Wizard submit engine (CR-006): one table-driven entry point for every
 * picker/wizard mode. Handlers call the pure `*Wizard.ts` result functions and
 * apply the shared settingsPatch/mode/message shape; field-capture steps run
 * through the pure transition functions below, so `chat.tsx` stays
 * orchestration glue instead of a 150-line if-chain.
 */

// ── Pure field-transition steps (provider/MCP add flows) ─────────────────────

type SharedWizardEffect =
  | {type: 'message'; text?: string}
  | {type: 'mode'; mode: Mode};

export type ProviderWizardEffect = SharedWizardEffect
  | {type: 'provider-draft'; patch: Partial<HazeProviderSettings>; replace?: boolean}
  | {type: 'discover-provider-models'; draft: Partial<HazeProviderSettings>};

export type McpWizardEffect = SharedWizardEffect
  | {type: 'mcp-draft'; patch: Partial<HazeMcpServer>}
  | {type: 'finish-mcp-stdio'; draft: Partial<HazeMcpServer>};

export function transitionProviderField(input: {mode: Mode; value: string; settings: HazeSettings; draft: Partial<HazeProviderSettings>}): ProviderWizardEffect[] | undefined {
  if (input.mode === 'providerAddKey') {
    const key = input.value.trim();
    return [
      {type: 'provider-draft', patch: key ? {key} : {}},
      {type: 'discover-provider-models', draft: {...input.draft, ...(key ? {key} : {})}},
    ];
  }
  const result = input.mode === 'providerAddName' ? captureProviderName(input.settings, input.value)
    : input.mode === 'providerAddUrl' ? captureProviderUrl(input.value)
    : undefined;
  if (!result) return undefined;
  if (result.message) return [{type: 'message', text: result.message}];
  const patch = result.draft ?? {};
  return [
    ...(Object.keys(patch).length ? [{type: 'provider-draft' as const, patch, replace: input.mode === 'providerAddName'}] : []),
    ...(result.nextMode ? [{type: 'mode' as const, mode: result.nextMode as Mode}] : []),
    {type: 'message', text: result.systemMessage},
  ];
}

export function transitionMcpField(input: {mode: Mode; value: string; settings: HazeSettings; draft: Partial<HazeMcpServer>}): McpWizardEffect[] | undefined {
  const result = input.mode === 'mcpAddName' ? captureMcpName(input.settings, input.value)
    : input.mode === 'mcpAddTransport' ? captureMcpTransport(input.value)
    : input.mode === 'mcpAddUrl' ? captureMcpUrl(input.value)
    : input.mode === 'mcpAddCommand' ? captureMcpCommand(input.value)
    : undefined;
  if (!result) return undefined;
  if (result.message) return [{type: 'message', text: result.message}];
  const patch = result.draft ?? {};
  const nextDraft = {...input.draft, ...patch};
  if (result.nextMode === 'chat' && input.mode === 'mcpAddCommand') return [{type: 'finish-mcp-stdio', draft: nextDraft}];
  return [
    ...(Object.keys(patch).length ? [{type: 'mcp-draft' as const, patch}] : []),
    ...(result.nextMode ? [{type: 'mode' as const, mode: result.nextMode as Mode}] : []),
    {type: 'message', text: result.systemMessage},
  ];
}

// ── Wizard UI state (one reducer for selection, drafts, model discovery) ────

/**
 * The wizard-related React state that used to live in twelve `useState`
 * hooks in `chat.tsx`. Flat field names match the historical deps names so
 * the dispatch body and its tests read the same way.
 */
export interface WizardUiState {
  selectedSessionId?: string;
  modelProviderFilter?: string;
  discoveredModels: string[];
  suggestedModels: string[];
  selectedProviderName?: string;
  providerDraft: Partial<HazeProviderSettings>;
  skillDraft: {name?: string; scope?: SkillSource};
  selectedSkillName?: string;
  selectedLspName?: string;
  lspDraft: Partial<HazeLspServer>;
  selectedMcpName?: string;
  mcpDraft: Partial<HazeMcpServer>;
}

export type WizardUiAction =
  | {type: 'set'; key: 'selectedSessionId' | 'modelProviderFilter' | 'selectedProviderName' | 'selectedSkillName' | 'selectedLspName' | 'selectedMcpName'; value: string | undefined}
  | {type: 'providerDraft'; value: Partial<HazeProviderSettings>}
  | {type: 'skillDraft'; value: {name?: string; scope?: SkillSource}}
  | {type: 'lspDraft'; value: Partial<HazeLspServer>}
  | {type: 'mcpDraft'; value: Partial<HazeMcpServer>}
  | {type: 'discoveredModels'; value: string[]}
  | {type: 'suggestedModels'; value: string[]}
  | {type: 'reset'};

export function initialWizardUiState(): WizardUiState {
  return {discoveredModels: [], suggestedModels: [], providerDraft: {}, skillDraft: {}, lspDraft: {}, mcpDraft: {}};
}

export function wizardUiReducer(state: WizardUiState, action: WizardUiAction): WizardUiState {
  switch (action.type) {
    case 'set': return {...state, [action.key]: action.value};
    case 'providerDraft': return {...state, providerDraft: action.value};
    case 'skillDraft': return {...state, skillDraft: action.value};
    case 'lspDraft': return {...state, lspDraft: action.value};
    case 'mcpDraft': return {...state, mcpDraft: action.value};
    case 'discoveredModels': return {...state, discoveredModels: action.value};
    case 'suggestedModels': return {...state, suggestedModels: action.value};
    case 'reset': return initialWizardUiState();
  }
}

export interface WizardDispatchDeps {
  settings: HazeSettings;
  skills: LoadedSkill[];
  sessions?: SessionSummary[];
  /** Wizard flow UI state (selection, drafts, model discovery). */
  wizard: WizardUiState;
  updateWizard: (action: WizardUiAction) => void;
  setMode: (mode: Mode) => void;
  setSettings: (next: HazeSettings) => void;
  showMessage: (message: string | undefined) => void;
  resumeSessionById?: (id: string) => Promise<boolean>;
  forkSessionById?: (id: string) => Promise<boolean>;
  refreshSkills: () => Promise<unknown>;
  setBusyLabel: (label: string) => void;
  setBusy: (busy: boolean) => void;
  /** Busy label to restore when a skill creation finishes. */
  idleBusyLabel: string;
}

interface WizardResult {
  settingsPatch?: HazeSettings;
  mode?: Mode;
  message?: string;
}

export interface WizardDispatch {
  /** Handle the value for wizard/picker modes; returns false for non-wizard modes. */
  dispatch: (mode: Mode, value: string) => Promise<boolean>;
  /** Exposed for the MCP field-transition path in submit(). */
  finishMcpCustom: (keyValue?: string, draft?: Partial<HazeMcpServer>) => Promise<void>;
  /** Exposed for the provider field-transition path: discover models for a provider draft after its key step. */
  discoverProviderModelsForDraft: (draft: Partial<HazeProviderSettings>) => Promise<void>;
}

export function createWizardDispatch(deps: WizardDispatchDeps): WizardDispatch {
  const {setMode, setSettings, showMessage} = deps;

  // Setter shims over the single wizard-state reducer, so the handler bodies
  // keep the historical per-field setter vocabulary (minimal diff; the
  // dispatch tests mirror React state through updateWizard).
  const setSelectedProviderName = (value: string | undefined) => deps.updateWizard({type: 'set', key: 'selectedProviderName', value});
  const setSelectedSkillName = (value: string | undefined) => deps.updateWizard({type: 'set', key: 'selectedSkillName', value});
  const setSelectedLspName = (value: string | undefined) => deps.updateWizard({type: 'set', key: 'selectedLspName', value});
  const setSelectedMcpName = (value: string | undefined) => deps.updateWizard({type: 'set', key: 'selectedMcpName', value});
  const setSelectedSessionId = (id: string | undefined) => deps.updateWizard({type: 'set', key: 'selectedSessionId', value: id});
  const setModelProviderFilter = (value: string | undefined) => deps.updateWizard({type: 'set', key: 'modelProviderFilter', value});
  const setProviderDraft = (value: Partial<HazeProviderSettings>) => deps.updateWizard({type: 'providerDraft', value});
  const setSkillDraft = (value: {name?: string; scope?: SkillSource}) => deps.updateWizard({type: 'skillDraft', value});
  const setLspDraft = (value: Partial<HazeLspServer>) => deps.updateWizard({type: 'lspDraft', value});
  const setMcpDraft = (value: Partial<HazeMcpServer>) => deps.updateWizard({type: 'mcpDraft', value});
  const setDiscoveredModels = (value: string[]) => deps.updateWizard({type: 'discoveredModels', value});
  const setSuggestedModels = (value: string[]) => deps.updateWizard({type: 'suggestedModels', value});

  // Limits harvested from the provider's own /models listing during the most
  // recent discovery. Written through with the models being added (provider-
  // specific and fresher than the static preset catalog) and cleared when a
  // flow restarts, so stale harvests never leak into a later add.
  let lastDiscoveredLimits: HarvestedModelLimits = {};

  // Shared applier for the uniform wizard result shape (CR-006 / useSettingsPatch).
  async function applyResult(result: WizardResult) {
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
  }

  async function selectSession(id: string) {
    if (!deps.sessions?.some(session => session.id === id)) {
      showMessage(`No session named ${id} exists for this workspace.`);
      setMode('chat');
      return;
    }
    setSelectedSessionId(id);
    setMode('sessionAction');
    showMessage(`Session ${id}: press Enter to resume, or choose fork.`);
  }

  async function selectSessionAction(action: string) {
    const id = deps.wizard.selectedSessionId;
    if (!id) {
      showMessage('No session selected. Start over with /resume.');
      setMode('chat');
      return;
    }
    if (action === SESSION_ACTIONS.resume) await deps.resumeSessionById?.(id);
    else if (action === SESSION_ACTIONS.fork) await deps.forkSessionById?.(id);
    else {
      showMessage(`Unknown session action: ${action}.`);
      return;
    }
    setSelectedSessionId(undefined);
    setMode('chat');
  }

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
      const next = await updateSettings({providers: upsertProvider(deps.settings, provider), provider: provider.name, model: undefined});
      setSettings(next);
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
    const next = await updateSettings({provider: provider.name});
    setSettings(next);
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
      if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
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

  /**
   * Shared discovery step for every add-models flow: fetch the provider's
   * OpenAI-compatible /models list and let the user pick. Falls back to the
   * manual comma-separated prompt when the endpoint is unavailable.
   */
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
    const next = await updateSettings({provider: resolved.provider.name, model: resolved.model});
    setSettings(next);
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
    const next = await updateSettings(result.settingsPatch);
    setSettings(next);
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
    const next = await updateSettings(result.settingsPatch);
    setSettings(next);
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
    setSettings(await updateSettings(result.settingsPatch));
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
    const next = await updateSettings(result.settingsPatch);
    setSettings(next);
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
    const next = await updateSettings(result.settingsPatch ?? {});
    await removeProviderAuth(provider.name);
    setSettings(next);
    setSelectedProviderName(undefined);
    setMode('chat');
    showMessage(result.message);
  }

  async function selectSkill(name: string) {
    const result = selectSkillResult(deps.skills, name);
    if (result.clearDraft) setSkillDraft({});
    if ('selectedName' in result) setSelectedSkillName(result.selectedName);
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
  }

  async function selectSkillAction(action: string) {
    const result = selectSkillActionResult(deps.settings, deps.skills, deps.wizard.selectedSkillName, action);
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if ('selectedName' in result) setSelectedSkillName(result.selectedName);
    if (result.mode) setMode(result.mode);
    if (result.validate && result.skill) {
      const {loadSkill} = await import('../../skills/SkillLoader.js');
      try {
        const loaded = await loadSkill(result.skill.dir, result.skill.source);
        showMessage(loaded ? `Valid: ${loaded.name}` : 'No SKILL.md found');
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        showMessage(`Invalid skill: ${text}`);
      }
      return;
    }
    showMessage(result.message);
  }

  async function captureSkillName(value: string) {
    const dirName = toSkillDirName(value);
    if (!dirName) {
      showMessage('Skill name must contain at least one letter or number. Try again, or press ESC to cancel.');
      return;
    }
    setSkillDraft({...deps.wizard.skillDraft, name: dirName});
    setMode('skillsAddScope');
    showMessage(`Where should "${dirName}" be created? Choose this project or global explicitly.`);
  }

  async function captureSkillScope(value: string) {
    const scope: SkillSource | undefined = value.trim().toLowerCase() === 'this project' ? 'project'
      : value.trim().toLowerCase() === 'global' ? 'global' : undefined;
    if (!scope) {
      showMessage('Choose "this project" or "global".');
      return;
    }
    const name = deps.wizard.skillDraft.name;
    if (!name) {
      setSkillDraft({});
      setMode('chat');
      showMessage('Skill wizard lost the name. Start over with /skills.');
      return;
    }
    const registry = await loadSkillRegistry();
    if ((registry.candidates ?? [...registry.skills.values()]).some(skill => skill.name === name && skill.source === scope)) {
      showMessage(`A ${scope} skill named "${name}" already exists. Choose another scope or press ESC to cancel.`);
      return;
    }
    setSkillDraft({...deps.wizard.skillDraft, scope});
    setMode('skillsAddDescription');
    showMessage(`Describe what "${name}" should do. This is the work the LLM will expand into the skill body.`);
  }

  async function captureSkillDescription(value: string) {
    const result = captureSkillDescriptionResult(value, deps.wizard.skillDraft.name);
    if (result.message) showMessage(result.message);
    if (result.mode === 'chat') setMode('chat');
    if (result.clearDraft) setSkillDraft({});
    if (result.description && result.draftName) {
      const name = result.draftName;
      const description = result.description;
      deps.setBusyLabel(result.busyLabel ?? 'Creating skill');
      deps.setBusy(true);
      try {
        const created = await createSkill({name, description, scope: deps.wizard.skillDraft.scope ?? 'global'});
        showMessage(skillCreationMessage(created.name, created.file));
        await deps.refreshSkills();
      } catch (error) {
        showMessage(skillCreationFailure(error));
      } finally {
        deps.setBusy(false);
        deps.setBusyLabel(deps.idleBusyLabel);
      }
    }
  }

  async function skillsConfirmRemoveMode(value: string) {
    const result = skillConfirmRemove(deps.settings, deps.skills, deps.wizard.selectedSkillName, value);
    if (result.message) showMessage(result.message);
    if (result.selectedName === undefined) setSelectedSkillName(undefined);
    if (result.mode === 'chat') setMode('chat');
    if (result.removedDir) await fs.remove(result.removedDir);
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if (result.removedDir) await deps.refreshSkills();
  }

  async function selectLspServer(serverName: string) {
    const result = selectLspServerResult(deps.settings, serverName);
    if (result.clearDraft) setLspDraft({});
    if (serverName === SERVER_CHOICES.addServer) setMode('lspAddPreset');
    else if (result.mode) setMode(result.mode);
    if (result.selectedName !== undefined) setSelectedLspName(result.selectedName);
    showMessage(result.message);
  }

  async function selectLspPreset(presetId: string) {
    const result = selectLspPresetResult(deps.settings, presetId);
    if (result.clearDraft) setLspDraft({});
    await applyResult(result);
  }

  async function selectLspAction(action: string) {
    const result = selectLspActionResult(deps.settings, deps.wizard.selectedLspName, action);
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if ('selectedName' in result) setSelectedLspName(result.selectedName);
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
  }

  async function finishLspCustom(commandLine: string) {
    const result = finishLspCustomResult(deps.settings, deps.wizard.lspDraft.name, commandLine);
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if (result.clearDraft) setLspDraft({});
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
  }

  async function lspAddNameMode(value: string) {
    const result = captureLspName(deps.settings, value);
    if (result.message) {
      showMessage(result.message);
      return;
    }
    if (result.draft) setLspDraft({name: result.draft.name});
    if (result.nextMode) setMode(result.nextMode as Mode);
    showMessage(result.systemMessage);
  }

  /**
   * Generic typed-"yes" confirm-remove step shared by the LSP and MCP flows.
   * Cancel and no-selection paths are identical; `remove` applies the domain
   * settings mutation and returns the success message.
   */
  function confirmRemoveStep(input: {selectedName: () => string | undefined; cancelMessage: string; clearSelection: () => void; remove: (name: string) => Promise<string>}) {
    return async (value: string) => {
      const name = input.selectedName();
      if (!name) {
        setMode('chat');
        return;
      }
      if (!isYesConfirmation(value)) {
        showMessage(input.cancelMessage);
        input.clearSelection();
        setMode('chat');
        return;
      }
      showMessage(await input.remove(name));
      input.clearSelection();
      setMode('chat');
    };
  }

  const lspConfirmRemoveMode = confirmRemoveStep({
    selectedName: () => deps.wizard.selectedLspName,
    cancelMessage: 'Cancelled. LSP server not removed.',
    clearSelection: () => setSelectedLspName(undefined),
    remove: async name => {
      const next = await updateSettings({lspServers: removeLspServer(deps.settings, name)});
      setSettings(next);
      return `Removed LSP server ${name}.`;
    },
  });

  const mcpConfirmRemoveMode = confirmRemoveStep({
    selectedName: () => deps.wizard.selectedMcpName,
    cancelMessage: 'Cancelled. MCP server not removed.',
    clearSelection: () => setSelectedMcpName(undefined),
    remove: async name => {
      const next = await updateSettings({mcpServers: removeMcpServer(deps.settings, name)});
      setSettings(next);
      return `Removed MCP server ${name}.`;
    },
  });

  async function selectMcpServer(serverName: string) {
    const result = selectMcpServerResult(deps.settings, serverName);
    if (result.clearDraft) setMcpDraft({});
    if (serverName === SERVER_CHOICES.addServer) setMode('mcpAddPreset');
    else if (result.mode) setMode(result.mode);
    if (result.selectedName !== undefined) setSelectedMcpName(result.selectedName);
    showMessage(result.message);
  }

  async function selectMcpPreset(presetId: string) {
    const result = selectMcpPresetResult(deps.settings, presetId);
    if (result.clearDraft) setMcpDraft({});
    if (result.draft) setMcpDraft(result.draft);
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
  }

  async function selectMcpAction(action: string) {
    const result = selectMcpActionResult(deps.settings, deps.wizard.selectedMcpName, action);
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if ('selectedName' in result) setSelectedMcpName(result.selectedName);
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
  }

  async function finishMcpCustom(keyValue?: string, draft = deps.wizard.mcpDraft) {
    const result = finishMcpCustomResult(deps.settings, draft, keyValue);
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if (result.clearDraft) setMcpDraft({});
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
  }

  async function setMcpServerKey(keyValue: string) {
    const result = setMcpServerKeyResult(deps.settings, deps.wizard.selectedMcpName, keyValue);
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if ('selectedName' in result) setSelectedMcpName(result.selectedName);
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
  }

  async function selectTheme(name: string) {
    const result = selectThemeResult(name);
    if (result.settingsPatch) {
      setSettings(await updateSettings(result.settingsPatch));
      setMode('chat');
    }
    showMessage(result.message);
  }

  const handlers: Partial<Record<Mode, (value: string) => Promise<void>>> = {
    sessions: selectSession,
    sessionAction: selectSessionAction,
    skills: selectSkill,
    skillsAction: selectSkillAction,
    skillsAddName: captureSkillName,
    skillsAddScope: captureSkillScope,
    skillsAddDescription: captureSkillDescription,
    skillsConfirmRemove: skillsConfirmRemoveMode,
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
    lsp: selectLspServer,
    lspAction: selectLspAction,
    lspAddPreset: selectLspPreset,
    lspAddName: lspAddNameMode,
    lspAddCommand: finishLspCustom,
    lspConfirmRemove: lspConfirmRemoveMode,
    mcp: selectMcpServer,
    mcpAction: selectMcpAction,
    mcpAddPreset: selectMcpPreset,
    mcpAddKey: finishMcpCustom,
    mcpSetKey: setMcpServerKey,
    mcpConfirmRemove: mcpConfirmRemoveMode,
    themes: selectTheme,
  };

  /** Apply one field-transition effect at the submit boundary (was chat.tsx inline branching). */
  async function applyProviderEffect(effect: ProviderWizardEffect) {
    if (effect.type === 'message') showMessage(effect.text);
    else if (effect.type === 'mode') setMode(effect.mode);
    else if (effect.type === 'provider-draft') {
      if (effect.replace) setProviderDraft(effect.patch);
      else setProviderDraft({...deps.wizard.providerDraft, ...effect.patch});
    } else if (effect.type === 'discover-provider-models') {
      // The draft patch above is still pending React state, so discovery
      // receives the merged draft explicitly (same pattern as MCP stdio).
      await discoverProviderModelsForDraft(effect.draft);
    }
  }

  async function applyMcpEffect(effect: McpWizardEffect) {
    if (effect.type === 'message') showMessage(effect.text);
    else if (effect.type === 'mode') setMode(effect.mode);
    else if (effect.type === 'mcp-draft') setMcpDraft({...deps.wizard.mcpDraft, ...effect.patch});
    else if (effect.type === 'finish-mcp-stdio') await finishMcpCustom(undefined, effect.draft);
  }

  return {
    async dispatch(mode, value) {
      // Field-capture steps first (same order chat.tsx used), then the submit table.
      const providerEffects = transitionProviderField({mode, value, settings: deps.settings, draft: deps.wizard.providerDraft});
      if (providerEffects) {
        for (const effect of providerEffects) await applyProviderEffect(effect);
        return true;
      }
      const mcpEffects = transitionMcpField({mode, value, settings: deps.settings, draft: deps.wizard.mcpDraft});
      if (mcpEffects) {
        for (const effect of mcpEffects) await applyMcpEffect(effect);
        return true;
      }
      const handler = handlers[mode];
      if (!handler) return false;
      await handler(value);
      return true;
    },
    finishMcpCustom,
    discoverProviderModelsForDraft,
  };
}
