import {configuredLspServers, lspPreset, upsertLspServer, setLspServerEnabled, type HazeLspServer} from '../../config/lspSettings.js';
import type {HazeSettings} from '../../config/settings.js';
import {COMMON_ACTIONS, LSP_ACTIONS, SERVER_CHOICES} from './wizardActions.js';
import {commandParts} from './wizardInput.js';

export type LspWizardResult = {
  message?: string;
  mode?: 'chat' | 'lsp' | 'lspAction' | 'lspAddName' | 'lspConfirmRemove';
  selectedName?: string;
  settingsPatch?: Partial<HazeSettings>;
  server?: HazeLspServer;
  clearDraft?: boolean;
};

export function selectLspServerResult(settings: HazeSettings, serverName: string): LspWizardResult {
  if (serverName === SERVER_CHOICES.addServer) return {mode: 'lspAddName', clearDraft: true, message: 'Choose an LSP preset, or select "custom" to enter a name and command manually.'};
  const server = configuredLspServers(settings).find(candidate => candidate.name === serverName);
  if (!server) return {mode: 'chat', message: `No LSP server named ${serverName}. Use /lsp and choose add server.`};
  return {mode: 'lspAction', selectedName: server.name, message: `${server.name}: choose an action.`};
}

export function selectLspPresetResult(settings: HazeSettings, presetId: string): LspWizardResult {
  if (presetId === SERVER_CHOICES.custom) return {mode: 'lspAddName', clearDraft: true, message: 'LSP server name? Example: typescript, rust, my-lsp.'};
  const preset = lspPreset(presetId);
  if (!preset) return {message: `Unknown preset: ${presetId}.`};
  if (configuredLspServers(settings).some(server => server.name === preset.name)) return {mode: 'chat', message: `LSP server ${preset.name} already exists. Use /lsp to manage existing servers.`};
  return {mode: 'chat', server: preset, settingsPatch: {lspServers: upsertLspServer(settings, preset)}, message: `Added LSP preset ${preset.name}. Ensure ${preset.command} is installed and on PATH; tools appear once it is.`};
}

export function selectLspActionResult(settings: HazeSettings, selectedName: string | undefined, action: string): LspWizardResult {
  if (!selectedName) return {mode: 'lsp'};
  const server = configuredLspServers(settings).find(candidate => candidate.name === selectedName);
  if (!server) return {mode: 'chat', selectedName: undefined, message: `LSP server ${selectedName} not found.`};
  if (action === COMMON_ACTIONS.enable || action === COMMON_ACTIONS.disable) {
    const enabled = action === COMMON_ACTIONS.enable;
    return {mode: 'chat', selectedName: undefined, settingsPatch: {lspServers: setLspServerEnabled(settings, selectedName, enabled)}, message: `LSP server ${selectedName} ${enabled ? 'enabled' : 'disabled'}.`};
  }
  if (action === LSP_ACTIONS.removeServer) return {mode: 'lspConfirmRemove', message: `Remove LSP server ${selectedName}? Type "yes" to confirm. Esc to cancel.`};
  return {message: `Unknown LSP action: ${action}`};
}

export function finishLspCustomResult(settings: HazeSettings, draftName: string | undefined, commandLine: string): LspWizardResult {
  const name = draftName?.trim();
  const parts = commandParts(commandLine);
  const command = parts[0];
  if (!name || !command) return {mode: 'chat', clearDraft: true, message: 'LSP server name and command are required.'};
  const server: HazeLspServer = {name, command, args: parts.slice(1), extensions: [], rootPatterns: ['.git'], enabled: true};
  return {mode: 'chat', clearDraft: true, server, settingsPatch: {lspServers: upsertLspServer(settings, server)}, message: `Added LSP server ${name} (${command}${parts.length > 1 ? ` ${parts.slice(1).join(' ')}` : ''}). Add extensions in ~/.haze/settings.json so tools can auto-select it.`};
}
