import {activeModel, configuredProviders, providerHasKey} from '../../config/providers.js';
import {configuredLspServers} from '../../config/lspSettings.js';
import {configuredMcpServers} from '../../config/mcpSettings.js';
import type {HazeSettings} from '../../config/settings.js';
import type {ContextFile} from '../../config/contextFiles.js';
import {chatgptCodexUrlWarning} from '../commands/providerWizard.js';

export function startupContextInfo(contextFiles: ContextFile[]) {
  const lines = contextFiles.map(file => `- ${file.path}`);
  return [
    'Context files included with the first request:',
    ...(lines.length > 0 ? lines : ['- none']),
    'Nested AGENTS.md and CLAUDE.md files load when haze works in their subfolders.',
  ].join('\n');
}

export function startupProviderInfo(settings: HazeSettings) {
  const selection = activeModel(settings);
  const configuredCount = configuredProviders(settings).length;
  const lspServers = configuredLspServers(settings);
  const enabledLsp = lspServers.filter(server => server.enabled !== false);
  const lspLine = enabledLsp.length > 0
    ? `- LSP: ${enabledLsp.length} configured (${enabledLsp.map(server => server.name).join(', ')}; tools appear only when the command is installed)`
    : '- LSP: not configured (optional: use /lsp presets, then /lsp add typescript)';
  const mcpServers = configuredMcpServers(settings);
  const enabledMcp = mcpServers.filter(server => server.enabled !== false);
  const mcpLine = enabledMcp.length > 0
    ? `- MCP: ${enabledMcp.length} configured (${enabledMcp.map(server => server.name).join(', ')}; tools load each turn)`
    : '- MCP: not configured (optional: use /mcp add context7 for current library docs)';
  if (!selection) {
    return [
      'Provider configuration',
      '- Provider: not configured',
      '- Model: not set',
      '- Base URL: not configured',
      '- API key: missing',
      `- Configured providers: ${configuredCount}`,
      lspLine,
      mcpLine,
      '',
      'Run /provider to choose or add a provider, then select a model.',
    ].join('\n');
  }
  const model = selection.model;
  const modelSource = settings.model ? 'settings' : 'provider default';
  const baseURL = selection.provider.url;
  const apiKeySource = providerHasKey(settings, selection.provider) ? `provider ${selection.provider.name}` : 'missing';
  const provider = selection.provider.name;
  const authLine = selection.provider.kind === 'chatgpt-codex'
    ? '- Authentication: ChatGPT OAuth credentials stored separately'
    : `- API key: ${apiKeySource === 'missing' ? 'not configured; local providers may not need one' : `configured via ${apiKeySource}`}`;
  const divergence = chatgptCodexUrlWarning(selection.provider);

  return [
    'Provider configuration',
    `- Provider: ${provider}`,
    `- Model: ${model} (${modelSource})`,
    `- Base URL: ${baseURL} (settings)`,
    ...(divergence ? [divergence] : []),
    authLine,
    `- Configured providers: ${configuredCount}`,
    lspLine,
    mcpLine,
  ].join('\n');
}
