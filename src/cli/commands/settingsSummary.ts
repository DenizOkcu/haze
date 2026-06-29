import {contextFileDiagnostics, summarizeContextDiagnostics} from '../../config/contextFiles.js';
import type {ContextFile} from '../../config/contextFiles.js';
import {configuredLspServers} from '../../config/lspSettings.js';
import {configuredMcpServers} from '../../config/mcpSettings.js';
import {configuredProviders, formatModelSlot, providerHasKey, resolveModelSlot} from '../../config/providers.js';
import {isSkillEnabled} from '../../config/skillSettings.js';
import type {HazeSettings} from '../../config/settings.js';
import {loadSkillRegistry} from '../../skills/SkillRegistry.js';

export async function formatSettingsSummary(settings: HazeSettings, contextFiles: ContextFile[]): Promise<string> {
  const providers = configuredProviders(settings);
  const primary = resolveModelSlot(settings, 'primary');
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
  const lines = [
    `Provider: ${primary.status === 'found' ? primary.provider.name : 'not configured'}`,
    `Model: ${primary.status === 'found' ? primary.model : 'not set'}`,
    formatModelSlot(settings, 'Lightweight slot', 'lightweight'),
    formatModelSlot(settings, 'Fallback slot', 'fallback'),
    `Base URL: ${primary.status === 'found' ? primary.provider.url : settings.baseURL ?? 'not configured'}`,
    `API key: ${primary.status === 'found' && providerHasKey(settings, primary.provider) ? 'saved' : 'missing'}`,
    `Configured providers: ${providers.map(provider => provider.name).join(', ') || 'none'}`,
    `LSP servers: ${lspServers.map(server => `${server.name}${server.enabled === false ? ' (disabled)' : ''}`).join(', ') || 'none'}`,
    `MCP servers: ${configuredMcpServers(settings).map(server => `${server.name}${server.enabled === false ? ' (disabled)' : ''}`).join(', ') || 'none'}`,
    `Skills: ${skillNames || 'none'}`,
    `Context files: ${contextFiles.length ? `${contextFiles.map(file => file.path).join(', ')} (~${contextTokens} tokens)` : 'none'}`,
  ];
  if (notes.length > 0) lines.push(`Context note: ${notes.join('; ')}`);
  return lines.join(' | ');
}
