import {configuredLspServers, lspPreset, upsertLspServer, setLspServerEnabled, type HazeLspServer} from '../../config/lspSettings.js';
import {findMcpPreset, findMcpServer, toggleMcpServer, upsertMcpServer} from '../../config/mcpSettings.js';
import type {HazeMcpServer, HazeSettings} from '../../config/settings.js';
import {assertCredentialedEndpointSecure} from '../../config/endpointSecurity.js';
import {COMMON_ACTIONS, LSP_ACTIONS, MCP_ACTIONS, MCP_TRANSPORTS, SERVER_CHOICES, commandParts} from './wizardFlow.js';

/**
 * Pure result functions for the LSP and MCP server wizard flows. The
 * corresponding steps (placeholders, kinds, suggestions) live in
 * `wizardFlow.ts`; the submit orchestration lives in
 * `chat/wizardDispatch.ts`.
 */

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

export type McpWizardResult = {
  message?: string;
  mode?: 'chat' | 'mcp' | 'mcpAction' | 'mcpAddName' | 'mcpAddKey' | 'mcpSetKey' | 'mcpConfirmRemove';
  selectedName?: string;
  draft?: Partial<HazeMcpServer>;
  settingsPatch?: Partial<HazeSettings>;
  server?: HazeMcpServer;
  clearDraft?: boolean;
};

export function selectMcpServerResult(settings: HazeSettings, serverName: string): McpWizardResult {
  if (serverName === SERVER_CHOICES.addServer) return {mode: 'mcpAddName', clearDraft: true, message: 'Choose an MCP preset, or select "custom" to enter details manually.'};
  const server = findMcpServer(settings, serverName);
  if (!server) return {mode: 'chat', message: `No MCP server named ${serverName}. Use /mcp and choose add server.`};
  return {mode: 'mcpAction', selectedName: server.name, message: `${server.name}: choose an action.`};
}

export function selectMcpPresetResult(settings: HazeSettings, presetId: string): McpWizardResult {
  if (presetId === SERVER_CHOICES.custom) return {mode: 'mcpAddName', clearDraft: true, message: 'MCP server name? Example: context7, github, filesystem.'};
  const preset = findMcpPreset(presetId);
  if (!preset) return {message: `Unknown preset: ${presetId}.`};
  if (findMcpServer(settings, presetId)) return {mode: 'chat', message: `MCP server ${presetId} already exists. Use /mcp to manage existing servers.`};
  return {
    mode: 'mcpAddKey',
    draft: {name: presetId, transport: preset.transport, ...(preset.url ? {url: preset.url} : {})},
    message: `Adding ${presetId} (${preset.transport}${preset.url ? `, ${preset.url}` : ''}).\nOptional API key or auth header value? (Leave blank to skip — Enter works.)`,
  };
}

export function selectMcpActionResult(settings: HazeSettings, selectedName: string | undefined, action: string): McpWizardResult {
  if (!selectedName) return {mode: 'mcp'};
  const server = findMcpServer(settings, selectedName);
  if (!server) return {mode: 'chat', selectedName: undefined, message: `MCP server ${selectedName} not found.`};
  if (action === COMMON_ACTIONS.enable || action === COMMON_ACTIONS.disable) {
    const enabled = action === COMMON_ACTIONS.enable;
    return {mode: 'chat', selectedName: undefined, settingsPatch: {mcpServers: toggleMcpServer(settings, selectedName, enabled) ?? []}, message: `MCP server ${selectedName} ${enabled ? 'enabled' : 'disabled'}.`};
  }
  if (action === MCP_ACTIONS.manageAccess) {
    if (server.transport === 'stdio') return {mode: 'chat', selectedName: undefined, message: 'Stdio MCP authentication must be handled by its command or wrapper; HTTP headers do not apply.'};
    return {mode: 'mcpSetKey', message: `New API key for ${selectedName}? (current: ${server.headers?.length ? 'saved' : 'not set'}) Sent as Authorization: Bearer <value>.`};
  }
  if (action === MCP_ACTIONS.removeServer) return {mode: 'mcpConfirmRemove', message: `Remove MCP server ${selectedName}? Type "yes" to confirm. Esc to cancel.`};
  return {message: `Unknown MCP action: ${action}`};
}

export function finishMcpCustomResult(settings: HazeSettings, draft: Partial<HazeMcpServer>, keyValue?: string): McpWizardResult {
  const name = draft.name?.trim();
  const transport = draft.transport;
  if (!name || !transport) return {mode: 'chat', clearDraft: true, message: 'MCP server name and transport are required.'};
  const headers = keyValue?.trim() ? [{name: 'Authorization', value: `Bearer ${keyValue.trim()}`}] : undefined;
  const server: HazeMcpServer = transport === MCP_TRANSPORTS.stdio
    ? {name, transport, command: draft.command, args: draft.args, enabled: true}
    : {name, transport, url: draft.url, ...(headers ? {headers} : {}), enabled: true};
  if (transport === MCP_TRANSPORTS.stdio && !server.command) return {mode: 'chat', clearDraft: true, message: 'Command is required for stdio transport.'};
  if (transport !== MCP_TRANSPORTS.stdio && !server.url) return {mode: 'chat', clearDraft: true, message: `URL is required for ${transport} transport.`};
  if (server.url) {
    try { assertCredentialedEndpointSecure(server.url, server.headers); } catch (error) {
      return {mode: 'chat', clearDraft: true, message: error instanceof Error ? error.message : String(error)};
    }
  }
  const location = transport === MCP_TRANSPORTS.stdio ? `${server.command}${(server.args ?? []).length ? ` ${(server.args ?? []).join(' ')}` : ''}` : server.url;
  return {mode: 'chat', clearDraft: true, server, settingsPatch: {mcpServers: upsertMcpServer(settings, server)}, message: `Added MCP server ${name} (${transport}, ${location}). Tools load on the next turn.`};
}

export function setMcpServerKeyResult(settings: HazeSettings, selectedName: string | undefined, keyValue: string): McpWizardResult {
  if (!selectedName) return {mode: 'mcp'};
  const server = findMcpServer(settings, selectedName);
  if (!server) return {mode: 'chat', selectedName: undefined, message: `MCP server ${selectedName} not found.`};
  if (server.transport === 'stdio') return {mode: 'chat', selectedName: undefined, message: 'Stdio MCP authentication must be handled by its command or wrapper.'};
  const key = keyValue.trim();
  if (!key) return {message: 'API key cannot be empty. Esc to cancel.'};
  const headers = (server.headers ?? []).filter(header => header.name !== 'Authorization');
  headers.push({name: 'Authorization', value: `Bearer ${key}`});
  if (server.url) {
    try { assertCredentialedEndpointSecure(server.url, headers); } catch (error) {
      return {mode: 'chat', selectedName: undefined, message: error instanceof Error ? error.message : String(error)};
    }
  }
  return {mode: 'chat', selectedName: undefined, settingsPatch: {mcpServers: upsertMcpServer(settings, {...server, headers})}, message: `API key updated for ${server.name}.`};
}
