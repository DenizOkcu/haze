import type {HazeSettings} from '../../config/settings.js';
import {configuredProviders, findProvider, modelSelector} from '../../config/providers.js';
import {configuredLspServers, LSP_PRESETS} from '../../config/lspSettings.js';
import {configuredMcpServers, findMcpServer, findMcpPreset, presetIds} from '../../config/mcpSettings.js';
import {isSkillEnabled} from '../../config/skillSettings.js';
import {PROVIDER_PRESETS} from '../../config/providerPresets.js';
import type {LoadedSkill} from '../../skills/types.js';
import type {TextInputSuggestion} from '../../ui/components/TextInput.js';
import {COMMON_ACTIONS, LSP_ACTIONS, MCP_ACTIONS, MCP_TRANSPORTS, PROVIDER_ACTIONS, PROVIDER_CHOICES, SERVER_CHOICES, SKILL_ACTIONS, SKILL_CHOICES} from './wizardActions.js';

/**
 * Pure suggestion builders for the chat wizard pickers (provider / model / LSP /
 * MCP / skills). Extracted from the React component so they are unit-testable
 * and so `ChatScreen` only owns interactive state, not picker content. Each
 * function takes its explicit inputs and returns the suggestion list shown for
 * the corresponding input mode.
 */

export function providerSuggestions(settings: HazeSettings): TextInputSuggestion[] {
  return [
    ...configuredProviders(settings).map(provider => ({
      value: provider.name,
      description: `${provider.url} · ${provider.models.length} model${provider.models.length === 1 ? '' : 's'}`,
      kind: 'provider' as const,
    })),
    {value: PROVIDER_CHOICES.addProvider, description: 'Add a new provider (presets available)', kind: 'provider' as const},
  ];
}

export function providerActionSuggestions(settings: HazeSettings, selectedProviderName: string | undefined): TextInputSuggestion[] {
  const provider = selectedProviderName ? findProvider(settings, selectedProviderName) : undefined;
  return [
    {value: PROVIDER_ACTIONS.useProvider, description: 'Set this provider and choose a model', kind: 'provider' as const},
    {value: PROVIDER_ACTIONS.addModels, description: 'Append comma-separated model names', kind: 'provider' as const},
    {value: PROVIDER_ACTIONS.setApiKey, description: provider?.key ? 'Update the saved API key' : 'Add an API key', kind: 'provider' as const},
    ...(provider?.models?.length ? [{value: PROVIDER_ACTIONS.removeModels, description: 'Remove models from this provider', kind: 'provider' as const}] : []),
    {value: PROVIDER_ACTIONS.removeProvider, description: 'Delete this provider from settings', kind: 'provider' as const},
  ];
}

export function presetSuggestions(): TextInputSuggestion[] {
  const cloudPresets = PROVIDER_PRESETS.filter(p => p.category === 'cloud');
  const localPresets = PROVIDER_PRESETS.filter(p => p.category === 'local');
  return [
    ...cloudPresets.map(preset => ({
      value: preset.id,
      description: `${preset.baseUrl}${preset.suggestedModels?.length ? ' · e.g. ' + preset.suggestedModels.slice(0, 2).join(', ') : ''}`,
      kind: 'provider' as const,
    })),
    ...localPresets.map(preset => ({
      value: preset.id,
      description: `${preset.baseUrl} · local, no API key needed`,
      kind: 'provider' as const,
    })),
    {value: PROVIDER_CHOICES.custom, description: 'Enter provider name, URL, and API key manually', kind: 'provider' as const},
  ];
}

export function modelSuggestions(settings: HazeSettings, modelProviderFilter: string | undefined): TextInputSuggestion[] {
  const providers = configuredProviders(settings).filter(provider => !modelProviderFilter || provider.name === modelProviderFilter);
  return providers.flatMap(provider => provider.models.map(model => ({
    value: modelProviderFilter ? model : modelSelector(provider, model),
    description: provider.name,
    kind: 'model' as const,
  })));
}

export function lspSuggestions(settings: HazeSettings): TextInputSuggestion[] {
  const servers = configuredLspServers(settings);
  return [{value: SERVER_CHOICES.addServer, description: 'add an LSP server (presets available)', kind: 'lsp' as const},
    ...servers.map(server => ({
      value: server.name,
      description: `${server.command}${(server.args ?? []).length ? ` ${(server.args ?? []).join(' ')}` : ''} · ${server.enabled === false ? 'disabled' : 'enabled'}`,
      kind: 'lsp' as const,
    }))];
}

export function lspActionSuggestions(settings: HazeSettings, selectedLspName: string | undefined): TextInputSuggestion[] {
  const server = selectedLspName ? configuredLspServers(settings).find(s => s.name === selectedLspName) : undefined;
  const result: TextInputSuggestion[] = [];
  if (server) result.push({value: server.enabled === false ? COMMON_ACTIONS.enable : COMMON_ACTIONS.disable, description: `${server.enabled === false ? COMMON_ACTIONS.enable : COMMON_ACTIONS.disable} this server`, kind: 'lsp' as const});
  result.push({value: LSP_ACTIONS.removeServer, description: 'remove this server', kind: 'lsp' as const});
  return result;
}

export function lspPresetSuggestions(): TextInputSuggestion[] {
  return [
    ...Object.values(LSP_PRESETS).map(preset => ({
      value: preset.name,
      description: `${preset.command} ${(preset.args ?? []).join(' ')} [${(preset.extensions ?? []).join(', ')}]`,
      kind: 'lsp' as const,
    })),
    {value: SERVER_CHOICES.custom, description: 'enter a name and command manually', kind: 'lsp' as const},
  ];
}

export function mcpSuggestions(settings: HazeSettings): TextInputSuggestion[] {
  const servers = configuredMcpServers(settings);
  return [{value: SERVER_CHOICES.addServer, description: 'add an MCP server (presets available)', kind: 'mcp' as const},
    ...servers.map(server => {
      const location = server.url ?? (server.command ? `${server.command} ${(server.args ?? []).join(' ')}`.trim() : '');
      return {value: server.name, description: `${server.transport}${location ? ` ${location}` : ''} · ${server.enabled === false ? 'disabled' : 'enabled'}`, kind: 'mcp' as const};
    })];
}

export function mcpActionSuggestions(settings: HazeSettings, selectedMcpName: string | undefined): TextInputSuggestion[] {
  const server = selectedMcpName ? findMcpServer(settings, selectedMcpName) : undefined;
  const result: TextInputSuggestion[] = [];
  if (server) {
    result.push({value: server.enabled === false ? COMMON_ACTIONS.enable : COMMON_ACTIONS.disable, description: `${server.enabled === false ? COMMON_ACTIONS.enable : COMMON_ACTIONS.disable} this server`, kind: 'mcp' as const});
    result.push({value: MCP_ACTIONS.setApiKey, description: server.headers?.length ? 'update the saved API key' : 'add an API key', kind: 'mcp' as const});
  }
  result.push({value: MCP_ACTIONS.removeServer, description: 'remove this server', kind: 'mcp' as const});
  return result;
}

export function mcpPresetSuggestions(): TextInputSuggestion[] {
  return [
    ...presetIds().map(presetId => {
      const preset = findMcpPreset(presetId)!;
      return {value: presetId, description: preset.description ?? `${preset.transport} server`, kind: 'mcp' as const};
    }),
    {value: SERVER_CHOICES.custom, description: 'enter name, transport, and URL or command manually', kind: 'mcp' as const},
  ];
}

export function mcpTransportSuggestions(): TextInputSuggestion[] {
  return [
    {value: MCP_TRANSPORTS.http, description: 'Streamable HTTP (remote)', kind: 'mcp' as const},
    {value: MCP_TRANSPORTS.sse, description: 'Server-Sent Events (remote)', kind: 'mcp' as const},
    {value: MCP_TRANSPORTS.stdio, description: 'local process', kind: 'mcp' as const},
  ];
}

export function skillsSuggestions(settings: HazeSettings, skills: LoadedSkill[]): TextInputSuggestion[] {
  return [{value: SKILL_CHOICES.addSkill, description: 'describe a new skill for Haze to generate', kind: 'skill' as const},
    ...skills.map(skill => ({
      value: skill.name,
      description: `${skill.description}${isSkillEnabled(settings, skill.name) ? '' : ' · disabled'}`,
      kind: 'skill' as const,
    }))];
}

export function skillsActionSuggestions(settings: HazeSettings, skills: LoadedSkill[], selectedSkillName: string | undefined): TextInputSuggestion[] {
  const skill = selectedSkillName ? skills.find(candidate => candidate.name === selectedSkillName) : undefined;
  const result: TextInputSuggestion[] = [];
  if (skill) {
    const enabled = isSkillEnabled(settings, skill.name);
    result.push({value: enabled ? COMMON_ACTIONS.disable : COMMON_ACTIONS.enable, description: `${enabled ? COMMON_ACTIONS.disable : COMMON_ACTIONS.enable} this skill`, kind: 'skill' as const});
    result.push({value: SKILL_ACTIONS.showInfo, description: 'show description, references, and path', kind: 'skill' as const});
    result.push({value: SKILL_ACTIONS.validate, description: 're-load and validate SKILL.md', kind: 'skill' as const});
  }
  result.push({value: SKILL_ACTIONS.removeSkill, description: 'delete this skill directory', kind: 'skill' as const});
  return result;
}
