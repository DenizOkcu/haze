import type {HazeMcpServer, HazeSettings} from '../../config/settings.js';
import {configuredLspServers} from '../../config/lspSettings.js';
import {findMcpServer} from '../../config/mcpSettings.js';
import {MCP_TRANSPORTS} from './wizardActions.js';
import {commandParts, isValidUrl} from './wizardInput.js';

export type NameCaptureResult = {
  nextMode?: string;
  draft?: {name?: string};
  message?: string;
  systemMessage?: string;
};

export function captureProviderName(settings: HazeSettings, value: string): NameCaptureResult {
  const name = value.trim();
  if (!name) return {message: 'Provider name is required.'};
  if (settings.providers?.some(provider => provider.name === name)) return {message: `Provider ${name} already exists. Choose a unique name.`};
  return {nextMode: 'providerAddUrl', draft: {name}, systemMessage: 'OpenAI-compatible base URL? Example: https://openrouter.ai/api/v1 or http://localhost:1234/v1'};
}

export function captureLspName(settings: HazeSettings, value: string): NameCaptureResult {
  const name = value.trim();
  if (!name) return {message: 'LSP server name is required.'};
  if (configuredLspServers(settings).some(server => server.name === name)) return {message: `LSP server ${name} already exists. Choose a unique name.`};
  return {nextMode: 'lspAddCommand', draft: {name}, systemMessage: 'Command to run? Example: typescript-language-server --stdio'};
}

export function captureMcpName(settings: HazeSettings, value: string): NameCaptureResult {
  const name = value.trim();
  if (!name) return {message: 'MCP server name is required.'};
  if (findMcpServer(settings, name)) return {message: `MCP server ${name} already exists. Choose a unique name.`};
  return {nextMode: 'mcpAddTransport', draft: {name}, systemMessage: 'Transport type? http (Streamable HTTP), sse (Server-Sent Events), or stdio (local process).'};
}

export type FieldCaptureResult = {
  draft?: Partial<HazeMcpServer>;
  message?: string;
  nextMode?: string;
  systemMessage?: string;
};

export function captureProviderUrl(value: string): FieldCaptureResult {
  if (!isValidUrl(value)) return {message: 'Enter a valid URL, for example http://localhost:1234/v1.'};
  return {draft: {url: value.trim()}, nextMode: 'providerAddKey', systemMessage: 'API key? Leave blank for local/keyless providers.'};
}

export function captureMcpUrl(value: string): FieldCaptureResult {
  if (!isValidUrl(value)) return {message: 'Enter a valid URL, for example https://mcp.context7.com/mcp.'};
  return {draft: {url: value.trim()}, nextMode: 'mcpAddKey', systemMessage: 'Optional API key or auth header value? (Leave blank to skip — Enter works.) Sent as Authorization: Bearer <value>.'};
}

export function captureMcpTransport(value: string): FieldCaptureResult {
  const transport = value.trim().toLowerCase();
  if (transport !== MCP_TRANSPORTS.http && transport !== MCP_TRANSPORTS.sse && transport !== MCP_TRANSPORTS.stdio) return {message: 'Enter http, sse, or stdio.'};
  if (transport === MCP_TRANSPORTS.stdio) return {draft: {transport}, nextMode: 'mcpAddCommand', systemMessage: 'Command to run? Example: npx -y @modelcontextprotocol/server-filesystem .'};
  return {draft: {transport}, nextMode: 'mcpAddUrl', systemMessage: `MCP server URL? Example: https://mcp.context7.com/mcp for ${transport}.`};
}

export function captureMcpCommand(value: string): FieldCaptureResult {
  const parts = commandParts(value);
  if (parts.length === 0) return {message: 'Command is required.'};
  return {draft: {command: parts[0], args: parts.slice(1)}, nextMode: 'mcpAddKey', systemMessage: 'Optional API key or auth header value? (Leave blank to skip — Enter works.) Sent as Authorization: Bearer <value>.'};
}