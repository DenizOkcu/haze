import {spawn} from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';
import {buildInitPrompt} from '../../llm/initPrompt.js';
import type {ContextFile} from '../../config/contextFiles.js';
import {contextFileDiagnostics, summarizeContextDiagnostics, MAX_CONTEXT_FILE_CHARS} from '../../config/contextFiles.js';
import {SETTINGS_FILE, writeSettings, type HazeSettings} from '../../config/settings.js';
import {activeProvider, configuredProviders, modelSelector, providerHasKey, resolveModelSelector, upsertProvider} from '../../config/providers.js';
import {configuredLspServers} from '../../config/lspSettings.js';
import {configuredMcpServers} from '../../config/mcpSettings.js';
import {isSkillEnabled} from '../../config/skillSettings.js';
import type {Mode} from './chatModes.js';
import {clearTasks} from '../../core/tasks/taskStorage.js';
import {listLogs, readLogEntries} from '../../core/log/llmLog.js';

export type CommandContext = {
  settings: HazeSettings;
  contextFiles: ContextFile[];
  setMode: (mode: Mode) => void;
  setModelProviderFilter?: (providerName: string | undefined) => void;
  addSystemMessage: (text: string) => void;
  clearConversation: () => void;
  newSession?: () => Promise<void>;
  resumeSession?: () => Promise<void>;
  sessionInfo?: () => string;
  compactConversation?: (instructions?: string) => boolean;
  runAgentTurn: (prompt: string, displayValue?: string) => Promise<void>;
  refreshContextFiles: () => Promise<ContextFile[]>;
  updateSettings: (patch: Partial<HazeSettings>) => Promise<HazeSettings>;
  getContextReport?: () => Promise<string>;
};

export type CommandResult = 'handled' | 'unhandled' | 'exit';

async function ensureSettingsFile(settings: HazeSettings) {
  if (!await fs.pathExists(SETTINGS_FILE)) await writeSettings(settings);
  return SETTINGS_FILE;
}

function openPath(filePath: string) {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', filePath] : [filePath];
  const child = spawn(command, args, {stdio: 'ignore', detached: true});
  child.on('error', () => undefined);
  child.unref();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function handleLogsCommand(args: string, ctx: CommandContext): Promise<CommandResult> {
  const id = args.trim();

  if (!id) {
    // List recent logs
    const logs = await listLogs();
    if (logs.length === 0) {
      ctx.addSystemMessage('No log files found.');
      return 'handled';
    }
    const lines = logs.slice(0, 20).map(log => {
      const date = log.modified.slice(0, 19).replace('T', ' ');
      return `  ${log.id}  ${formatBytes(log.size).padStart(8)}  ${date}`;
    });
    ctx.addSystemMessage(['Recent logs:', '  ID                                 Size       Modified', ...lines].join('\n'));
    return 'handled';
  }

  // Show summary for a specific log
  const entries = await readLogEntries(id);
  if (entries.length === 0) {
    ctx.addSystemMessage(`No log found with id ${id}.`);
    return 'handled';
  }

  const typeCounts: Record<string, number> = {};
  let totalInput = 0;
  let totalOutput = 0;
  const toolCallCounts: Record<string, number> = {};

  for (const entry of entries) {
    typeCounts[entry.type] = (typeCounts[entry.type] ?? 0) + 1;
    if (entry.usage) {
      totalInput += entry.usage.inputTokens ?? 0;
      totalOutput += entry.usage.outputTokens ?? 0;
    }
    if (entry.type === 'tool_call' && entry.toolCall) {
      toolCallCounts[entry.toolCall.name] = (toolCallCounts[entry.toolCall.name] ?? 0) + 1;
    }
  }

  const typeLines = Object.entries(typeCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `  ${type}: ${count}`);

  const toolLines = Object.entries(toolCallCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => `  ${name}: ${count}`);

  const parts = [
    `Log: ${id}`,
    `Entries: ${entries.length}`,
    '',
    'Entry counts by type:',
    ...typeLines,
    '',
    `Total token usage: in=${totalInput} out=${totalOutput}`,
  ];

  if (toolLines.length > 0) {
    parts.push('', 'Tool call counts:', ...toolLines);
  }

  ctx.addSystemMessage(parts.join('\n'));
  return 'handled';
}

export async function handleSlashCommand(
  value: string,
  ctx: CommandContext
): Promise<CommandResult> {
  if (value === '/exit' || value === '/quit') return 'exit';
  if (value === '/help') {
    ctx.addSystemMessage([
      'Commands:',
      '/help',
      '  Show all available slash commands and what they do.',
      '/provider',
      '  Choose a provider, then use it, add/remove models, set API key, or remove it.',
      '/model',
      '  Choose a model from all configured providers.',
      '/model <name-or-provider:name>',
      '  Set a model directly. Selecting a model also sets its provider.',
      '/settings',
      '  Show the configured provider, model, API key status, LSP/MCP servers, skills, and loaded context files.',
      '/settings open',
      '  Open ~/.haze/settings.json with the OS default app.',
      '/skills',
      '  Manage Markdown skills: generate a custom skill, show info, enable/disable, validate, or remove.',
      '/init',
      '  Inspect the current workspace and create or update AGENTS.md project instructions.',
      '/context',
      '  Show a token breakdown of the current request: system prompt, project context, tools (incl. MCP), and chat messages.',
      '/session',
      '  Show the current durable session file.',
      '/resume',
      '  Resume the latest saved session for this workspace.',
      '/new',
      '  Start a fresh durable session.',
      '/logs',
      '  List recent log files with sizes and dates.',
      '/lsp',
      '  Configure Language Server Protocol navigation tools (interactive picker).',
      '/mcp',
      '  Configure Model Context Protocol servers like Context7 (interactive picker).',
      '/logs <id>',
      '  Show summary of a specific log: entry counts by type, total tokens, tool calls.',
      '/compact [instructions]',
      '  Summarize older model context and keep recent messages.',
      '/clear',
      '  Clear the current chat conversation history.',
      '/exit',
      '  Exit Haze.',
      '/quit',
      '  Exit Haze.',
    ].join('\n'));
    return 'handled';
  }
  if (value === '/context') {
    if (ctx.getContextReport) ctx.addSystemMessage(await ctx.getContextReport());
    else ctx.addSystemMessage('Context overview is unavailable.');
    return 'handled';
  }
  if (value === '/session') {
    ctx.addSystemMessage(ctx.sessionInfo?.() ?? 'Session persistence is unavailable.');
    return 'handled';
  }
  if (value === '/resume') {
    if (ctx.resumeSession) await ctx.resumeSession();
    else ctx.addSystemMessage('Session persistence is unavailable.');
    return 'handled';
  }
  if (value === '/new') {
    if (ctx.newSession) await ctx.newSession();
    else ctx.addSystemMessage('Session persistence is unavailable.');
    return 'handled';
  }
  if (value === '/compact' || value.startsWith('/compact ')) {
    if (ctx.compactConversation) ctx.compactConversation(value.slice('/compact'.length).trim() || undefined);
    else ctx.addSystemMessage('Compaction is unavailable.');
    return 'handled';
  }
  if (value === '/clear') {
    ctx.clearConversation();
    await clearTasks();
    ctx.addSystemMessage('Cleared. The void is productive.');
    return 'handled';
  }
  if (value === '/logs' || value.startsWith('/logs ')) {
    const args = value.slice('/logs'.length).trim();
    return await handleLogsCommand(args, ctx);
  }
  if (value === '/lsp' || value.startsWith('/lsp ')) {
    ctx.setMode('lsp');
    ctx.addSystemMessage('Choose an LSP server to enable, disable, or remove it. Choose "add server" to add one from presets (e.g. typescript) or enter a custom command.');
    return 'handled';
  }
  if (value === '/mcp' || value.startsWith('/mcp ')) {
    ctx.setMode('mcp');
    ctx.addSystemMessage('Choose an MCP server to enable, disable, remove, or set a key for it. Choose "add server" to add one from presets (e.g. context7) or enter custom details.');
    return 'handled';
  }
  if (value === '/settings open' || value === '/settings edit') {
    const file = await ensureSettingsFile(ctx.settings);
    openPath(file);
    ctx.addSystemMessage(`Opened settings file: ${file}`);
    return 'handled';
  }
  if (value === '/settings') {
    const providers = configuredProviders(ctx.settings);
    const activeProvider = providers.find(provider => provider.name === ctx.settings.provider) ?? providers[0];
    const contextDiagnostics = contextFileDiagnostics(ctx.contextFiles);
    const contextTokens = contextDiagnostics.reduce((sum, file) => sum + file.estimatedTokens, 0);
    const summary = summarizeContextDiagnostics(ctx.contextFiles);
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
    const lspServers = configuredLspServers(ctx.settings);
    const {loadSkillRegistry} = await import('../../skills/SkillRegistry.js');
    const installedSkills = [...(await loadSkillRegistry()).skills.values()];
    const skillNames = installedSkills.map(skill => `${skill.name}${isSkillEnabled(ctx.settings, skill.name) ? '' : ' (disabled)'}`).join(', ');
    const lines = [
      `Provider: ${activeProvider?.name ?? 'not configured'}`,
      `Model: ${ctx.settings.model ?? 'not set'}`,
      `Base URL: ${activeProvider?.url ?? ctx.settings.baseURL ?? 'not configured'}`,
      `API key: ${activeProvider && providerHasKey(ctx.settings, activeProvider) ? 'saved' : 'missing'}`,
      `Configured providers: ${providers.map(provider => provider.name).join(', ') || 'none'}`,
      `LSP servers: ${lspServers.map(server => `${server.name}${server.enabled === false ? ' (disabled)' : ''}`).join(', ') || 'none'}`,
      `MCP servers: ${configuredMcpServers(ctx.settings).map(server => `${server.name}${server.enabled === false ? ' (disabled)' : ''}`).join(', ') || 'none'}`,
      `Skills: ${skillNames || 'none'}`,
      `Context files: ${ctx.contextFiles.length ? `${ctx.contextFiles.map(file => file.path).join(', ')} (~${contextTokens} tokens)` : 'none'}`,
    ];
    if (notes.length > 0) lines.push(`Context note: ${notes.join('; ')}`);
    ctx.addSystemMessage(lines.join(' | '));
    return 'handled';
  }
  if (value === '/provider') {
    ctx.setModelProviderFilter?.(undefined);
    ctx.setMode('provider');
    ctx.addSystemMessage('Choose a provider. Selecting one opens provider actions. Choose "add provider" to pick from presets or enter custom details.');
    return 'handled';
  }
  if (value === '/model') {
    ctx.setModelProviderFilter?.(undefined);
    ctx.setMode('model');
    ctx.addSystemMessage('Choose a model. Selecting a model also sets its provider.');
    return 'handled';
  }
  if (value === '/model list') {
    const providers = configuredProviders(ctx.settings);
    ctx.addSystemMessage(['Configured models:', ...providers.flatMap(provider => provider.models.map(model => `- ${modelSelector(provider, model)} - ${provider.name}`))].join('\n'));
    return 'handled';
  }
  if (value.startsWith('/model ')) {
    const selector = value.slice('/model '.length).trim();
    const resolved = resolveModelSelector(ctx.settings, selector);
    if (resolved.status === 'ambiguous') {
      ctx.addSystemMessage(`Model ${resolved.model} exists on multiple providers: ${resolved.providers.map(provider => modelSelector(provider, resolved.model)).join(', ')}`);
      return 'handled';
    }
    if (resolved.status === 'missing') {
      const provider = activeProvider(ctx.settings);
      if (!provider) {
        ctx.addSystemMessage('No provider configured. Run /provider to choose or add a provider before setting a model.');
        return 'handled';
      }
      const nextProvider = provider.models.includes(selector) ? provider : {...provider, models: [...provider.models, selector]};
      await ctx.updateSettings({provider: provider.name, model: selector, providers: upsertProvider(ctx.settings, nextProvider)});
      ctx.addSystemMessage(`Model set to ${selector} on ${provider.name}. Saved to ~/.haze/settings.json.`);
      return 'handled';
    }
    await ctx.updateSettings({provider: resolved.provider.name, model: resolved.model});
    ctx.addSystemMessage(`Model set to ${resolved.model} on ${resolved.provider.name}. Saved to ~/.haze/settings.json.`);
    return 'handled';
  }
  if (value === '/init') {
    await ctx.runAgentTurn(buildInitPrompt(), '/init');
    await ctx.refreshContextFiles();
    const agentsMdPath = path.join(process.cwd(), 'AGENTS.md');
    if (await fs.pathExists(agentsMdPath)) {
      const content = await fs.readFile(agentsMdPath, 'utf8');
      const chars = content.length;
      const lines = content.split('\n').length;
      const msg = chars > MAX_CONTEXT_FILE_CHARS
        ? `AGENTS.md validation: ${chars.toLocaleString()} chars / ${lines} lines — exceeds the ${MAX_CONTEXT_FILE_CHARS.toLocaleString()}-char context budget and will be truncated. Trim it before relying on it.`
        : `AGENTS.md validation: ${chars.toLocaleString()} chars / ${lines} lines — within the ${MAX_CONTEXT_FILE_CHARS.toLocaleString()}-char context budget.`;
      ctx.addSystemMessage(msg);
    }
    return 'handled';
  }
  if (value === '/skills') {
    ctx.setMode('skills');
    ctx.addSystemMessage('Choose a skill to show info, enable/disable, or remove it. Choose "add skill" to generate a new one from a description.');
    return 'handled';
  }
  if (value.startsWith('/')) {
    ctx.addSystemMessage(`Unknown command: ${value}. Bold start.`);
    return 'handled';
  }
  return 'unhandled';
}
