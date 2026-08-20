import type {HazeMcpServer} from '../../../config/settings.js';
import {removeMcpServer} from '../../../config/mcpSettings.js';
import type {Mode} from '../../commands/chatModes.js';
import {SERVER_CHOICES} from '../../commands/wizardFlow.js';
import {finishMcpCustomResult, selectMcpActionResult, selectMcpPresetResult, selectMcpServerResult, setMcpServerKeyResult} from '../../commands/serverWizard.js';
import {confirmRemoveStep, type WizardDispatchDeps, type WizardHandler, type WizardSetterContext} from './types.js';

/** MCP wizard handlers: server picker, presets, actions, key steps, and confirm-remove. */
export function createMcpWizardHandlers(deps: WizardDispatchDeps, ctx: WizardSetterContext): {handlers: Partial<Record<Mode, WizardHandler>>; finishMcpCustom: (keyValue?: string, draft?: Partial<HazeMcpServer>) => Promise<void>} {
  const {setMode, showMessage} = ctx;
  const setMcpDraft = ctx.setMcpDraft;
  const setSelectedMcpName = ctx.setSelectedMcpName;

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
    if (result.settingsPatch) await ctx.applySettings(result.settingsPatch);
    if ('selectedName' in result) setSelectedMcpName(result.selectedName);
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
  }

  async function finishMcpCustom(keyValue?: string, draft = deps.wizard.mcpDraft) {
    const result = finishMcpCustomResult(deps.settings, draft, keyValue);
    if (result.settingsPatch) await ctx.applySettings(result.settingsPatch);
    if (result.clearDraft) setMcpDraft({});
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
  }

  async function setMcpServerKey(keyValue: string) {
    const result = setMcpServerKeyResult(deps.settings, deps.wizard.selectedMcpName, keyValue);
    if (result.settingsPatch) await ctx.applySettings(result.settingsPatch);
    if ('selectedName' in result) setSelectedMcpName(result.selectedName);
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
  }

  const mcpConfirmRemoveMode = confirmRemoveStep(ctx, {
    selectedName: () => deps.wizard.selectedMcpName,
    cancelMessage: 'Cancelled. MCP server not removed.',
    clearSelection: () => setSelectedMcpName(undefined),
    remove: async name => {
      await ctx.applySettings({mcpServers: removeMcpServer(deps.settings, name)});
      return `Removed MCP server ${name}.`;
    },
  });

  return {
    handlers: {
      mcp: selectMcpServer,
      mcpAction: selectMcpAction,
      mcpAddPreset: selectMcpPreset,
      mcpAddKey: finishMcpCustom,
      mcpSetKey: setMcpServerKey,
      mcpConfirmRemove: mcpConfirmRemoveMode,
    },
    finishMcpCustom,
  };
}
