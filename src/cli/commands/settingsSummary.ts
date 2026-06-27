import {contextFileDiagnostics, summarizeContextDiagnostics} from '../../config/contextFiles.js';
import type {ContextFile} from '../../config/contextFiles.js';
import {configuredLspServers} from '../../config/lspSettings.js';
import {configuredMcpServers} from '../../config/mcpSettings.js';
import {activeProvider as resolveActiveProvider, configuredProviders, providerHasKey, resolveModelSlot, type ModelSlotName} from '../../config/providers.js';
import {isSkillEnabled} from '../../config/skillSettings.js';
import type {HazeSettings} from '../../config/settings.js';
import {loadSkillRegistry} from '../../skills/SkillRegistry.js';

export async function formatSettingsSummary(settings: HazeSettings, contextFiles: ContextFile[]): Promise<string> {
  const providers = configuredProviders(settings);
  const activeProvider = resolveActiveProvider(settings);
  const contextDiagnostics = contextFileDiagnostics(contextFiles);
  const contextTokens = contextDiagnostics.reduce((sum, file) => sum + file.estimatedTokens, 0);
  const summary = summarizeContextDiagnostics(contextFiles);
  const notes: string[] = [];
  if (summary.exceedsBudget === true && summary.windowSize) {
    const sharePct = Math.round((summary.budgetShare ?? 0) * 100);
    const thresholdPct = Math.round(summary.budgetThreshold * 100);
    notes.push(`project context exceeds ${thresholdPct}% budget (${sharePct}% of ${Math.round(summary.windowSize / 1000)}k window)`);
  }
  if (summary.duplicateGroups.length > 0) {
    const duplicateTotal = summary.duplicateFileCount;
    notes.push(`${summary.duplicateGroups.length} duplicate group${summary.duplicateGroups.length === 1 ? '' : 's'} (${duplicateTotal} file${duplicateTotal === 1 ? '' : 's'} with identical content)`);
  }
  const lspServers = configuredLspServers(settings);
  const installedSkills = [...(await loadSkillRegistry()).skills.values()];
  const skillNames = installedSkills.map(skill => `${skill.name}${isSkillEnabled(settings, skill.name) ? '' : ' (disabled)'}`).join(', ');
  const slotLine = (label: string, slot: ModelSlotName) => {
    const configured = settings.models?.[slot]?.trim();
    if (!configured) return `${label}: not set (inherits primary)`;
    const resolved = resolveModelSlot(settings, slot);
    return resolved.status === 'found'
      ? `${label}: ${resolved.provider.name}:${resolved.model}`
      : `${label}: ${configured} (not found)`;
  };
  const lines = [
    `Provider: ${activeProvider?.name ?? 'not configured'}`,
    `Model: ${settings.model ?? 'not set'}`,
    slotLine('Lightweight slot', 'lightweight'),
    slotLine('Fallback slot', 'fallback'),
    `Base URL: ${activeProvider?.url ?? settings.baseURL ?? 'not configured'}`,
    `API key: ${activeProvider && providerHasKey(settings, activeProvider) ? 'saved' : 'missing'}`,
    `Configured providers: ${providers.map(provider => provider.name).join(', ') || 'none'}`,
    `LSP servers: ${lspServers.map(server => `${server.name}${server.enabled === false ? ' (disabled)' : ''}`).join(', ') || 'none'}`,
    `MCP servers: ${configuredMcpServers(settings).map(server => `${server.name}${server.enabled === false ? ' (disabled)' : ''}`).join(', ') || 'none'}`,
    `Skills: ${skillNames || 'none'}`,
    `Context files: ${contextFiles.length ? `${contextFiles.map(file => file.path).join(', ')} (~${contextTokens} tokens)` : 'none'}`,
  ];
  if (notes.length > 0) lines.push(`Context note: ${notes.join('; ')}`);
  return lines.join(' | ');
}
