import {configuredProviders, formatModelSlot, providerHasKey, resolveModelSlot} from '../../config/providers.js';
import {configuredLspServers} from '../../config/lspSettings.js';
import {configuredMcpServers} from '../../config/mcpSettings.js';
import type {HazeSettings} from '../../config/settings.js';
import type {ContextFile} from '../../config/contextFiles.js';

export function startupContextInfo(contextFiles: ContextFile[]) {
  const lines = contextFiles.map(file => `- ${file.path}`);
  return [
    'Context files sent with the system prompt',
    ...(lines.length > 0 ? lines : ['- none']),
  ].join('\n');
}

export function startupProviderInfo(settings: HazeSettings) {
  const primary = resolveModelSlot(settings, 'primary');
  const configuredCount = configuredProviders(settings).length;
  const lspServers = configuredLspServers(settings);
  const enabledLsp = lspServers.filter(server => server.enabled !== false);
  const lspLine = enabledLsp.length > 0
    ? `- LSP: ${enabledLsp.length} configured (${enabledLsp.map(server => server.name).join(', ')}; tools appear only when the command is installed)`
    : '- LSP: none configured (optional: install a language server, then /lsp presets and /lsp add typescript for semantic code navigation)';
  const mcpServers = configuredMcpServers(settings);
  const enabledMcp = mcpServers.filter(server => server.enabled !== false);
  const mcpLine = enabledMcp.length > 0
    ? `- MCP: ${enabledMcp.length} configured (${enabledMcp.map(server => server.name).join(', ')}; tools load each turn)`
    : '- MCP: none configured (optional: /mcp add context7 for up-to-date library docs)';
  if (primary.status !== 'found') {
    return [
      'Provider configuration',
      '- Provider: not configured',
      '- Model: not set',
      `- ${formatModelSlot(settings, 'Lightweight slot', 'lightweight')}`,
      `- ${formatModelSlot(settings, 'Fallback slot', 'fallback')}`,
      '- Base URL: not configured',
      '- API key: missing',
      `- Configured providers: ${configuredCount}`,
      lspLine,
      mcpLine,
      '',
      'Run /provider to choose or add a provider, then select a model.',
    ].join('\n');
  }
  const provider = primary.provider.name;
  const model = primary.model;
  const modelSource = settings.models?.primary ? 'slot' : (settings.model ? 'settings' : 'provider default');
  const baseURL = primary.provider.url;
  const apiKeySource = providerHasKey(settings, primary.provider) ? `provider ${primary.provider.name}` : 'missing';
  return [
    'Provider configuration',
    `- Provider: ${provider}`,
    `- Model: ${model} (${modelSource})`,
    `- ${formatModelSlot(settings, 'Lightweight slot', 'lightweight')}`,
    `- ${formatModelSlot(settings, 'Fallback slot', 'fallback')}`,
    `- Base URL: ${baseURL} (settings)`,
    `- API key: ${apiKeySource === 'missing' ? 'not configured; local providers may not need one' : `configured via ${apiKeySource}`}`,
    `- Configured providers: ${configuredCount}`,
    lspLine,
    mcpLine,
  ].join('\n');
}
