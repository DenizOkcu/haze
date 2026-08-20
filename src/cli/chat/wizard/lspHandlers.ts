import type {HazeSettings} from '../../../config/settings.js';
import {removeLspServer} from '../../../config/lspSettings.js';
import type {Mode} from '../../commands/chatModes.js';
import {SERVER_CHOICES, captureLspName} from '../../commands/wizardFlow.js';
import {finishLspCustomResult, selectLspActionResult, selectLspPresetResult, selectLspServerResult} from '../../commands/serverWizard.js';
import {confirmRemoveStep, type WizardDispatchDeps, type WizardHandler, type WizardSetterContext} from './types.js';

/** LSP wizard handlers: server picker, presets, actions, custom add, and confirm-remove. */
export function createLspWizardHandlers(deps: WizardDispatchDeps, ctx: WizardSetterContext): Partial<Record<Mode, WizardHandler>> {
  const {setMode, showMessage} = ctx;
  const setLspDraft = ctx.setLspDraft;
  const setSelectedLspName = ctx.setSelectedLspName;

  /** Shared applier for the uniform wizard result shape (CR-006 / useSettingsPatch). */
  async function applyResult(result: {settingsPatch?: HazeSettings; mode?: Mode; message?: string}) {
    if (result.settingsPatch) await ctx.applySettings(result.settingsPatch);
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
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
    if (result.settingsPatch) await ctx.applySettings(result.settingsPatch);
    if ('selectedName' in result) setSelectedLspName(result.selectedName);
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
  }

  async function finishLspCustom(commandLine: string) {
    const result = finishLspCustomResult(deps.settings, deps.wizard.lspDraft.name, commandLine);
    if (result.settingsPatch) await ctx.applySettings(result.settingsPatch);
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

  const lspConfirmRemoveMode = confirmRemoveStep(ctx, {
    selectedName: () => deps.wizard.selectedLspName,
    cancelMessage: 'Cancelled. LSP server not removed.',
    clearSelection: () => setSelectedLspName(undefined),
    remove: async name => {
      await ctx.applySettings({lspServers: removeLspServer(deps.settings, name)});
      return `Removed LSP server ${name}.`;
    },
  });

  return {
    lsp: selectLspServer,
    lspAction: selectLspAction,
    lspAddPreset: selectLspPreset,
    lspAddName: lspAddNameMode,
    lspAddCommand: finishLspCustom,
    lspConfirmRemove: lspConfirmRemoveMode,
  };
}
