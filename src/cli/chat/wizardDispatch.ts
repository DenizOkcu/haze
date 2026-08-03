import fs from 'fs-extra';
import type {HazeMcpServer, HazeProviderSettings, HazeSettings} from '../../config/settings.js';
import type {HazeLspServer} from '../../config/lspSettings.js';
import {updateSettings} from '../../config/settings.js';
import {findProvider, modelSelector, resolveModelSelector} from '../../config/providers.js';
import {discoverProviderModels} from '../../config/modelDiscovery.js';
import {removeLspServer} from '../../config/lspSettings.js';
import {removeMcpServer} from '../../config/mcpSettings.js';
import {findPreset, PROVIDER_PRESETS} from '../../config/providerPresets.js';
import {loadSkillRegistry} from '../../skills/SkillRegistry.js';
import {createSkill, toSkillDirName} from '../../skills/builder/SkillBuilder.js';
import type {LoadedSkill} from '../../skills/types.js';
import type {Mode} from '../commands/chatModes.js';
import {PROVIDER_ACTIONS, PROVIDER_CHOICES, MODEL_CHOICES, SERVER_CHOICES} from '../commands/wizardActions.js';
import {captureLspName} from '../commands/wizardPrompts.js';
import {finishLspCustomResult, selectLspActionResult, selectLspPresetResult, selectLspServerResult} from '../commands/lspWizard.js';
import {finishMcpCustomResult, selectMcpActionResult, selectMcpPresetResult, selectMcpServerResult, setMcpServerKeyResult} from '../commands/mcpWizard.js';
import {providerActionResult, providerAppendModels, providerFinishAdd, providerRemove, providerRemoveModels, providerSetImageCapable, providerSetKey} from '../commands/providerWizard.js';
import {selectSkillActionResult, selectSkillResult} from '../commands/skillWizard.js';
import {captureSkillDescription as captureSkillDescriptionResult, skillCreationFailure, skillCreationMessage} from '../commands/skillCreation.js';
import {skillConfirmRemoveResult as skillConfirmRemove} from '../commands/skillConfirmRemove.js';
import {isYesConfirmation} from '../commands/wizardInput.js';
import {startupProviderInfo} from './startupInfo.js';

/**
 * Wizard submit dispatch (CR-006): one table-driven entry point for every
 * picker/wizard mode. Handlers call the pure `*Wizard.ts` result functions and
 * apply the shared settingsPatch/mode/message shape, so `chat.tsx` stays
 * orchestration glue instead of a 150-line if-chain.
 */
export interface WizardDispatchDeps {
  settings: HazeSettings;
  skills: LoadedSkill[];
  modelProviderFilter: string | undefined;
  selectedProviderName: string | undefined;
  selectedSkillName: string | undefined;
  selectedLspName: string | undefined;
  selectedMcpName: string | undefined;
  providerDraft: Partial<HazeProviderSettings>;
  lspDraft: Partial<HazeLspServer>;
  mcpDraft: Partial<HazeMcpServer>;
  skillDraft: {name?: string};
  setMode: (mode: Mode) => void;
  setSettings: (next: HazeSettings) => void;
  setSelectedProviderName: (name: string | undefined) => void;
  setSelectedSkillName: (name: string | undefined) => void;
  setSelectedLspName: (name: string | undefined) => void;
  setSelectedMcpName: (name: string | undefined) => void;
  setModelProviderFilter: (filter: string | undefined) => void;
  setProviderDraft: (draft: Partial<HazeProviderSettings>) => void;
  setSkillDraft: (draft: {name?: string}) => void;
  setLspDraft: (draft: Partial<HazeLspServer>) => void;
  setMcpDraft: (draft: Partial<HazeMcpServer>) => void;
  setDiscoveredModels: (models: string[]) => void;
  /** Curated preset models pinned atop discovered ones; cleared with discovered models. */
  setSuggestedModels: (models: string[]) => void;
  showMessage: (message: string | undefined) => void;
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

  // Shared applier for the uniform wizard result shape (CR-006 / useSettingsPatch).
  async function applyResult(result: WizardResult) {
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
  }

  async function selectProvider(providerName: string) {
    if (providerName === PROVIDER_CHOICES.addProvider) {
      deps.setProviderDraft({});
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
    deps.setSelectedProviderName(provider.name);
    setMode('providerAction');
    showMessage(`${provider.name}: choose an action.`);
  }

  async function selectPreset(presetId: string) {
    if (presetId === PROVIDER_CHOICES.custom) {
      deps.setProviderDraft({});
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
      deps.setProviderDraft({});
      return;
    }

    deps.setProviderDraft({name: existingName, url: preset.baseUrl});
    deps.setSuggestedModels(preset.suggestedModels ?? []);

    if (preset.needsApiKey) {
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
      deps.setSelectedProviderName(undefined);
      return;
    }
    const next = await updateSettings({provider: provider.name});
    setSettings(next);
    deps.setSelectedProviderName(undefined);
    deps.setModelProviderFilter(provider.name);
    setMode('model');
    showMessage(`Provider set to ${provider.name}. Choose a model.`);
  }

  async function selectProviderAction(action: string) {
    if (!deps.selectedProviderName) {
      setMode('provider');
      return;
    }
    const provider = findProvider(deps.settings, deps.selectedProviderName);
    if (!provider) {
      showMessage(`Provider ${deps.selectedProviderName} not found.`);
      setMode('chat');
      deps.setSelectedProviderName(undefined);
      return;
    }
    if (action === PROVIDER_ACTIONS.useProvider) {
      await useProvider(deps.selectedProviderName);
      return;
    }
    if (action === PROVIDER_ACTIONS.markImageCapable || action === PROVIDER_ACTIONS.clearImageCapable) {
      const result = providerSetImageCapable(deps.settings, deps.selectedProviderName, action === PROVIDER_ACTIONS.markImageCapable);
      if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
      deps.setSelectedProviderName(undefined);
      setMode('chat');
      showMessage(result.message);
      return;
    }
    if (action === PROVIDER_ACTIONS.addModels) {
      deps.setSelectedProviderName(provider.name);
      await discoverModelsFor(provider, `Comma-separated model names to add to ${provider.name}?`);
      return;
    }
    const actionResult = providerActionResult(action, provider);
    if ('selectedName' in actionResult) deps.setSelectedProviderName(actionResult.selectedName);
    if (actionResult.mode) setMode(actionResult.mode);
    showMessage(actionResult.message);
  }

  /**
   * Shared discovery step for every add-models flow: fetch the provider's
   * OpenAI-compatible /models list and let the user pick. Falls back to the
   * manual comma-separated prompt when the endpoint is unavailable.
   */
  async function discoverModelsFor(target: {name?: string; url?: string; key?: string}, fallbackPrompt: string) {
    if (!target.name || !target.url) {
      showMessage('Provider name and URL are required to discover models.');
      setMode('chat');
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
      deps.setDiscoveredModels(result.models);
      setMode('modelPick');
      showMessage(`Found ${result.models.length} model${result.models.length === 1 ? '' : 's'} on ${target.name}. Choose one to add, or select "${MODEL_CHOICES.enterModelNames}".`);
      return;
    }
    const existing = findProvider(deps.settings, target.name);
    setMode(existing ? 'providerAppendModels' : 'providerAddModels');
    showMessage(`Could not list models on ${target.name} (${result.error}).\n${fallbackPrompt}`);
  }

  async function selectModel(selector: string) {
    if (selector === MODEL_CHOICES.addModels) {
      const filteredProvider = deps.modelProviderFilter ? findProvider(deps.settings, deps.modelProviderFilter) : undefined;
      if (filteredProvider) {
        deps.setSelectedProviderName(filteredProvider.name);
        await discoverModelsFor(filteredProvider, `Comma-separated model names to add to ${filteredProvider.name}?`);
        return;
      }
      setMode('modelAddProvider');
      showMessage('Choose a provider to add models to.');
      return;
    }
    const scopedSelector = deps.modelProviderFilter ? `${deps.modelProviderFilter}:${selector}` : selector;
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
    deps.setModelProviderFilter(undefined);
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
    deps.setSelectedProviderName(provider.name);
    await discoverModelsFor(provider, `Comma-separated model names to add to ${provider.name}?`);
  }

  async function pickModelToAdd(value: string) {
    const provider = deps.selectedProviderName ? findProvider(deps.settings, deps.selectedProviderName) : undefined;
    if (value === MODEL_CHOICES.enterModelNames) {
      deps.setDiscoveredModels([]);
      deps.setSuggestedModels([]);
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
    await discoverModelsFor({name: draft.name, url: draft.url, key: draft.key}, `Comma-separated model names?${hint}`);
  }

  async function appendModelsToProvider(modelsValue: string) {
    const result = providerAppendModels(deps.settings, deps.selectedProviderName, modelsValue);
    if (!result.provider) {
      deps.setDiscoveredModels([]);
      deps.setSuggestedModels([]);
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
    deps.setSelectedProviderName(undefined);
    deps.setDiscoveredModels([]);
    deps.setSuggestedModels([]);
    deps.setModelProviderFilter(result.provider.name);
    setMode('model');
    showMessage(result.message);
  }

  async function finishProviderAdd(modelsValue: string) {
    const result = providerFinishAdd(deps.settings, deps.providerDraft, modelsValue);
    if (!result.provider || !result.settingsPatch) {
      showMessage(result.message);
      setMode('chat');
      deps.setProviderDraft({});
      deps.setDiscoveredModels([]);
      deps.setSuggestedModels([]);
      return;
    }
    const next = await updateSettings(result.settingsPatch);
    setSettings(next);
    deps.setProviderDraft({});
    deps.setDiscoveredModels([]);
    deps.setSuggestedModels([]);
    deps.setModelProviderFilter(result.provider.name);
    setMode('model');
    showMessage(result.message);
  }

  async function providerSetKeyMode(value: string) {
    const result = providerSetKey(deps.settings, deps.selectedProviderName, value);
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
    deps.setSelectedProviderName(undefined);
    setMode('chat');
    showMessage(result.message);
  }

  async function providerRemoveModelsMode(value: string) {
    const result = providerRemoveModels(deps.settings, deps.selectedProviderName, value);
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
    deps.setSelectedProviderName(undefined);
    setMode('chat');
    showMessage(result.message);
  }

  async function providerConfirmRemoveMode(value: string) {
    const provider = deps.selectedProviderName ? findProvider(deps.settings, deps.selectedProviderName) : undefined;
    if (!provider) {
      showMessage('No provider selected.');
      setMode('chat');
      return;
    }
    if (!isYesConfirmation(value)) {
      showMessage('Cancelled. Provider not removed.');
      deps.setSelectedProviderName(undefined);
      setMode('chat');
      return;
    }
    const result = providerRemove(deps.settings, deps.selectedProviderName);
    const next = await updateSettings(result.settingsPatch ?? {});
    setSettings(next);
    deps.setSelectedProviderName(undefined);
    setMode('chat');
    showMessage(result.message);
  }

  async function selectSkill(name: string) {
    const result = selectSkillResult(deps.skills, name);
    if (result.clearDraft) deps.setSkillDraft({});
    if ('selectedName' in result) deps.setSelectedSkillName(result.selectedName);
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
  }

  async function selectSkillAction(action: string) {
    const result = selectSkillActionResult(deps.settings, deps.skills, deps.selectedSkillName, action);
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if ('selectedName' in result) deps.setSelectedSkillName(result.selectedName);
    if (result.mode) setMode(result.mode);
    if (result.validate && result.skill) {
      const {loadSkill} = await import('../../skills/SkillLoader.js');
      try {
        const loaded = await loadSkill(result.skill.dir, 'global');
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
    const registry = await loadSkillRegistry();
    if (registry.skills.has(dirName)) {
      showMessage(`A skill named "${dirName}" already exists. Pick another name, or press ESC to cancel.`);
      return;
    }
    deps.setSkillDraft({...deps.skillDraft, name: dirName});
    setMode('skillsAddDescription');
    showMessage(`Describe what "${dirName}" should do. This is the work the LLM will expand into the skill body.`);
  }

  async function captureSkillDescription(value: string) {
    const result = captureSkillDescriptionResult(value, deps.skillDraft.name);
    if (result.message) showMessage(result.message);
    if (result.mode === 'chat') setMode('chat');
    if (result.clearDraft) deps.setSkillDraft({});
    if (result.description && result.draftName) {
      const name = result.draftName;
      const description = result.description;
      deps.setBusyLabel(result.busyLabel ?? 'Creating skill');
      deps.setBusy(true);
      try {
        const created = await createSkill({name, description});
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
    const result = skillConfirmRemove(deps.settings, deps.skills, deps.selectedSkillName, value);
    if (result.message) showMessage(result.message);
    if (result.selectedName === undefined) deps.setSelectedSkillName(undefined);
    if (result.mode === 'chat') setMode('chat');
    if (result.removedDir) await fs.remove(result.removedDir);
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if (result.removedDir) await deps.refreshSkills();
  }

  async function selectLspServer(serverName: string) {
    const result = selectLspServerResult(deps.settings, serverName);
    if (result.clearDraft) deps.setLspDraft({});
    if (serverName === SERVER_CHOICES.addServer) setMode('lspAddPreset');
    else if (result.mode) setMode(result.mode);
    if (result.selectedName !== undefined) deps.setSelectedLspName(result.selectedName);
    showMessage(result.message);
  }

  async function selectLspPreset(presetId: string) {
    const result = selectLspPresetResult(deps.settings, presetId);
    if (result.clearDraft) deps.setLspDraft({});
    await applyResult(result);
  }

  async function selectLspAction(action: string) {
    const result = selectLspActionResult(deps.settings, deps.selectedLspName, action);
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if ('selectedName' in result) deps.setSelectedLspName(result.selectedName);
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
  }

  async function finishLspCustom(commandLine: string) {
    const result = finishLspCustomResult(deps.settings, deps.lspDraft.name, commandLine);
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if (result.clearDraft) deps.setLspDraft({});
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
  }

  async function lspAddNameMode(value: string) {
    const result = captureLspName(deps.settings, value);
    if (result.message) {
      showMessage(result.message);
      return;
    }
    if (result.draft) deps.setLspDraft({name: result.draft.name});
    if (result.nextMode) setMode(result.nextMode as Mode);
    showMessage(result.systemMessage);
  }

  async function lspConfirmRemoveMode(value: string) {
    if (!deps.selectedLspName) {
      setMode('chat');
      return;
    }
    if (!isYesConfirmation(value)) {
      showMessage('Cancelled. LSP server not removed.');
      deps.setSelectedLspName(undefined);
      setMode('chat');
      return;
    }
    const next = await updateSettings({lspServers: removeLspServer(deps.settings, deps.selectedLspName)});
    setSettings(next);
    showMessage(`Removed LSP server ${deps.selectedLspName}.`);
    deps.setSelectedLspName(undefined);
    setMode('chat');
  }

  async function selectMcpServer(serverName: string) {
    const result = selectMcpServerResult(deps.settings, serverName);
    if (result.clearDraft) deps.setMcpDraft({});
    if (serverName === SERVER_CHOICES.addServer) setMode('mcpAddPreset');
    else if (result.mode) setMode(result.mode);
    if (result.selectedName !== undefined) deps.setSelectedMcpName(result.selectedName);
    showMessage(result.message);
  }

  async function selectMcpPreset(presetId: string) {
    const result = selectMcpPresetResult(deps.settings, presetId);
    if (result.clearDraft) deps.setMcpDraft({});
    if (result.draft) deps.setMcpDraft(result.draft);
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
  }

  async function selectMcpAction(action: string) {
    const result = selectMcpActionResult(deps.settings, deps.selectedMcpName, action);
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if ('selectedName' in result) deps.setSelectedMcpName(result.selectedName);
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
  }

  async function finishMcpCustom(keyValue?: string, draft = deps.mcpDraft) {
    const result = finishMcpCustomResult(deps.settings, draft, keyValue);
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if (result.clearDraft) deps.setMcpDraft({});
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
  }

  async function setMcpServerKey(keyValue: string) {
    const result = setMcpServerKeyResult(deps.settings, deps.selectedMcpName, keyValue);
    if (result.settingsPatch) setSettings(await updateSettings(result.settingsPatch));
    if ('selectedName' in result) deps.setSelectedMcpName(result.selectedName);
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
  }

  async function mcpConfirmRemoveMode(value: string) {
    if (!deps.selectedMcpName) {
      setMode('chat');
      return;
    }
    if (!isYesConfirmation(value)) {
      showMessage('Cancelled. MCP server not removed.');
      deps.setSelectedMcpName(undefined);
      setMode('chat');
      return;
    }
    const next = await updateSettings({mcpServers: removeMcpServer(deps.settings, deps.selectedMcpName)});
    setSettings(next);
    showMessage(`Removed MCP server ${deps.selectedMcpName}.`);
    deps.setSelectedMcpName(undefined);
    setMode('chat');
  }

  const handlers: Partial<Record<Mode, (value: string) => Promise<void>>> = {
    skills: selectSkill,
    skillsAction: selectSkillAction,
    skillsAddName: captureSkillName,
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
  };

  return {
    async dispatch(mode, value) {
      const handler = handlers[mode];
      if (!handler) return false;
      await handler(value);
      return true;
    },
    finishMcpCustom,
    discoverProviderModelsForDraft,
  };
}
