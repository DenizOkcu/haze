import {spawn} from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';
import {buildInitPrompt} from '../../llm/initPrompt.js';
import type {ContextFile} from '../../config/contextFiles.js';
import {contextFileDiagnostics, summarizeContextDiagnostics, MAX_CONTEXT_FILE_CHARS} from '../../config/contextFiles.js';
import {SETTINGS_FILE, writeSettings, type HazeMcpServer, type HazeSettings} from '../../config/settings.js';
import {activeProvider, configuredProviders, modelSelector, providerHasKey, resolveModelSelector, upsertProvider} from '../../config/providers.js';
import {configuredLspServers, lspPreset, LSP_PRESETS, removeLspServer, setLspServerEnabled, upsertLspServer} from '../../config/lspSettings.js';
import {configuredMcpServers, findMcpPreset, findMcpServer, presetIds, removeMcpServer, toggleMcpServer, upsertMcpServer} from '../../config/mcpSettings.js';
import type {Mode} from './chat.js';
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
};

export type CommandResult = 'handled' | 'unhandled' | 'exit';

function skillHelp() {
  return [
    'Skill commands:',
    '/create-skill',
    '  Launch the 3-step skill wizard (name -> role -> description). Creates a Markdown skill in ~/.haze/skills.',
    '/skill-info <name>',
    '  Show a skill description and path.',
    '/validate-skill <name-or-dir>',
    '  Validate a skill directory containing SKILL.md.',
    '/remove-skill <name> --yes',
    '  Remove an installed skill. Requires --yes because it deletes files.',
  ].join('\n');
}

async function skillOverview(): Promise<string> {
  const {loadSkillRegistry} = await import('../../skills/SkillRegistry.js');
  const registry = await loadSkillRegistry();
  const skills = [...registry.skills.values()];
  const installed = skills.length === 0
    ? ['Installed skills:', '- None yet. Create one with /create-skill.']
    : ['Installed skills:', ...skills.map(s => `- /${s.name} - ${s.description}`)];
  return `${skillHelp()}\n\n${installed.join('\n')}`;
}

type SkillSubcommand = 'help' | 'create' | 'info' | 'validate' | 'remove';

async function handleSkillCommand(sub: SkillSubcommand, args: string, ctx: CommandContext): Promise<CommandResult> {
  if (sub === 'help') {
    ctx.addSystemMessage(await skillOverview());
    return 'handled';
  }

  if (sub === 'create') {
    // Inline args are intentionally ignored — the wizard is the only path.
    ctx.setMode('skillCreateName');
    ctx.addSystemMessage('Skill wizard — step 1/3: Name the skill (kebab-case, e.g. security-review). ESC cancels.');
    return 'handled';
  }

  if (sub === 'info') {
    const name = args.trim();
    if (!name) {
      ctx.addSystemMessage('Usage: /skill-info <name>');
      return 'handled';
    }
    const {loadSkillRegistry} = await import('../../skills/SkillRegistry.js');
    const registry = await loadSkillRegistry();
    const skill = registry.skills.get(name);
    if (!skill) {
      ctx.addSystemMessage(`No skill named ${name}`);
      return 'handled';
    }
    ctx.addSystemMessage([
      `${skill.name}`,
      skill.description,
      '',
      `References: ${skill.references.length}`,
      `Path: ${skill.dir}`,
    ].join('\n'));
    return 'handled';
  }

  if (sub === 'validate') {
    const target = args.trim();
    if (!target) {
      ctx.addSystemMessage('Usage: /validate-skill <name-or-dir>');
      return 'handled';
    }
    const {GLOBAL_SKILLS_DIR} = await import('../../config/paths.js');
    const {loadSkill} = await import('../../skills/SkillLoader.js');
    const direct = path.resolve(target);
    const dir = await fs.pathExists(path.join(direct, 'SKILL.md')) ? direct : path.join(GLOBAL_SKILLS_DIR, target);
    const skill = await loadSkill(dir, 'global');
    ctx.addSystemMessage(skill ? `Valid: ${skill.name}` : 'No SKILL.md found');
    return 'handled';
  }

  if (sub === 'remove') {
    const parts = args.split(/\s+/).filter(Boolean);
    const name = parts[0];
    if (!name || !parts.includes('--yes')) {
      ctx.addSystemMessage('Usage: /remove-skill <name> --yes');
      return 'handled';
    }
    const {loadSkillRegistry} = await import('../../skills/SkillRegistry.js');
    const registry = await loadSkillRegistry();
    const skill = registry.skills.get(name);
    if (!skill) {
      ctx.addSystemMessage(`No skill named ${name}`);
      return 'handled';
    }
    await fs.remove(skill.dir);
    ctx.addSystemMessage(`Removed ${name} from ${skill.dir}.`);
    return 'handled';
  }

  return 'handled';
}

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

function splitArgs(input: string) {
  const matches = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map(part => part.replace(/^(["'])(.*)\1$/, '$2'));
}

function lspOverview(settings: HazeSettings) {
  const servers = configuredLspServers(settings);
  const lines = [
    'LSP commands:',
    '/lsp',
    '  List configured language servers.',
    '/lsp presets',
    `  Show built-in presets: ${Object.keys(LSP_PRESETS).join(', ')}`,
    '/lsp add <preset>',
    '  Add a preset, e.g. /lsp add typescript.',
    '/lsp add <name> -- <command> [args...]',
    '  Add a custom stdio LSP server. Example: /lsp add custom-ts -- typescript-language-server --stdio',
    '/lsp enable <name> | /lsp disable <name> | /lsp remove <name>',
    '',
    'Configured LSP servers:',
    ...(servers.length === 0 ? ['- none'] : servers.map(server => `- ${server.name} ${server.enabled === false ? '(disabled)' : '(enabled)'}: ${server.command} ${(server.args ?? []).join(' ')} [${(server.extensions ?? []).join(', ') || 'no extensions'}]`)),
  ];
  return lines.join('\n');
}

async function handleLspCommand(args: string, ctx: CommandContext): Promise<CommandResult> {
  const parts = splitArgs(args);
  const sub = parts[0];
  if (!sub) {
    ctx.addSystemMessage(lspOverview(ctx.settings));
    return 'handled';
  }
  if (sub === 'presets') {
    ctx.addSystemMessage(['LSP presets:', ...Object.values(LSP_PRESETS).map(preset => `- ${preset.name}: ${preset.command} ${(preset.args ?? []).join(' ')} [${(preset.extensions ?? []).join(', ')}]`)].join('\n'));
    return 'handled';
  }
  if (sub === 'add') {
    const name = parts[1];
    if (!name) {
      ctx.addSystemMessage('Usage: /lsp add <preset> OR /lsp add <name> -- <command> [args...]');
      return 'handled';
    }
    const preset = lspPreset(name);
    if (preset) {
      await ctx.updateSettings({lspServers: upsertLspServer(ctx.settings, preset)});
      ctx.addSystemMessage(`Added LSP preset ${name}. Ensure ${preset.command} is installed and on PATH.`);
      return 'handled';
    }
    const sep = parts.indexOf('--');
    const command = sep === -1 ? undefined : parts[sep + 1];
    if (!command) {
      ctx.addSystemMessage(`Unknown preset ${name}. Use /lsp presets or /lsp add <name> -- <command> [args...]`);
      return 'handled';
    }
    const server = {name, command, args: parts.slice(sep + 2), extensions: [], rootPatterns: ['.git'], enabled: true};
    await ctx.updateSettings({lspServers: upsertLspServer(ctx.settings, server)});
    ctx.addSystemMessage(`Added custom LSP server ${name}. Add extensions manually in ~/.haze/settings.json before tools can auto-select it.`);
    return 'handled';
  }
  if (sub === 'remove' || sub === 'enable' || sub === 'disable') {
    const name = parts[1];
    if (!name) {
      ctx.addSystemMessage(`Usage: /lsp ${sub} <name>`);
      return 'handled';
    }
    if (sub === 'remove') await ctx.updateSettings({lspServers: removeLspServer(ctx.settings, name)});
    else await ctx.updateSettings({lspServers: setLspServerEnabled(ctx.settings, name, sub === 'enable')});
    ctx.addSystemMessage(`LSP server ${name} ${sub === 'remove' ? 'removed' : sub === 'enable' ? 'enabled' : 'disabled'}.`);
    return 'handled';
  }
  ctx.addSystemMessage('Unknown /lsp command. Use /lsp for help.');
  return 'handled';
}

function mcpOverview(settings: HazeSettings) {
  const servers = configuredMcpServers(settings);
  const lines = [
    'MCP commands:',
    '/mcp',
    '  List configured MCP servers.',
    '/mcp presets',
    `  Show built-in presets: ${presetIds().join(', ') || 'none'}`,
    '/mcp add <preset>',
    '  Add a preset, e.g. /mcp add context7.',
    '/mcp add <name> -- (http|sse) <url>',
    '  Add a remote MCP server. Example: /mcp add github -- http https://mcp.example.com/mcp',
    '/mcp add <name> -- stdio <command> [args...]',
    '  Add a local MCP server. Example: /mcp add fs -- stdio npx -y @modelcontextprotocol/server-filesystem .',
    '/mcp key <name> <value>',
    '  Set an Authorization: Bearer <value> header for a server.',
    '/mcp enable <name> | /mcp disable <name> | /mcp remove <name>',
    '',
    'Configured MCP servers:',
    ...(servers.length === 0 ? ['- none'] : servers.map(server => {
      const location = server.url ?? (server.command ? `${server.command} ${(server.args ?? []).join(' ')}`.trim() : '');
      return `- ${server.name} ${server.enabled === false ? '(disabled)' : '(enabled)'}: ${server.transport}${location ? ` ${location}` : ''}`;
    })),
    '',
    'MCP tools load at the start of each turn and the connections close when the turn ends.',
  ];
  return lines.join('\n');
}

async function handleMcpCommand(args: string, ctx: CommandContext): Promise<CommandResult> {
  const parts = splitArgs(args);
  const sub = parts[0];
  if (!sub) {
    ctx.addSystemMessage(mcpOverview(ctx.settings));
    return 'handled';
  }
  if (sub === 'presets') {
    ctx.addSystemMessage(['MCP presets:', ...presetIds().map(id => `- ${id}: ${findMcpPreset(id)?.description ?? 'custom'}`)].join('\n'));
    return 'handled';
  }
  if (sub === 'add') {
    const name = parts[1];
    if (!name) {
      ctx.addSystemMessage('Usage: /mcp add <preset> OR /mcp add <name> -- (http|sse) <url> OR /mcp add <name> -- stdio <command> [args...]');
      return 'handled';
    }
    const preset = findMcpPreset(name);
    if (preset) {
      const {description: _description, ...rest} = preset;
      void _description;
      const server: HazeMcpServer = {name, ...rest, enabled: true};
      await ctx.updateSettings({mcpServers: upsertMcpServer(ctx.settings, server)});
      ctx.addSystemMessage(`Added MCP preset ${name} (${preset.transport}${preset.url ? ` ${preset.url}` : ''}). Tools load on the next turn.`);
      return 'handled';
    }
    const sep = parts.indexOf('--');
    const rest = sep === -1 ? [] : parts.slice(sep + 1);
    const transport = rest[0];
    if (transport === 'http' || transport === 'sse') {
      const url = rest[1];
      if (!url) {
        ctx.addSystemMessage(`Usage: /mcp add ${name} -- ${transport} <url>`);
        return 'handled';
      }
      const server: HazeMcpServer = {name, transport, url, enabled: true};
      await ctx.updateSettings({mcpServers: upsertMcpServer(ctx.settings, server)});
      ctx.addSystemMessage(`Added MCP server ${name} (${transport}, ${url}). Tools load on the next turn.`);
      return 'handled';
    }
    if (transport === 'stdio') {
      const command = rest[1];
      if (!command) {
        ctx.addSystemMessage(`Usage: /mcp add ${name} -- stdio <command> [args...]`);
        return 'handled';
      }
      const server: HazeMcpServer = {name, transport, command, args: rest.slice(2), enabled: true};
      await ctx.updateSettings({mcpServers: upsertMcpServer(ctx.settings, server)});
      ctx.addSystemMessage(`Added MCP server ${name} (stdio, ${command}${rest.length > 2 ? ` ${rest.slice(2).join(' ')}` : ''}). Tools load on the next turn.`);
      return 'handled';
    }
    ctx.addSystemMessage(`Unknown transport "${transport ?? ''}". Use http, sse, or stdio. Example: /mcp add ${name} -- http https://mcp.example.com/mcp`);
    return 'handled';
  }
  if (sub === 'enable' || sub === 'disable') {
    const name = parts[1];
    if (!name) {
      ctx.addSystemMessage(`Usage: /mcp ${sub} <name>`);
      return 'handled';
    }
    const next = toggleMcpServer(ctx.settings, name, sub === 'enable');
    if (!next) {
      ctx.addSystemMessage(`No MCP server named ${name}.`);
      return 'handled';
    }
    await ctx.updateSettings({mcpServers: next});
    ctx.addSystemMessage(`MCP server ${name} ${sub === 'enable' ? 'enabled' : 'disabled'}.`);
    return 'handled';
  }
  if (sub === 'remove') {
    const name = parts[1];
    if (!name) {
      ctx.addSystemMessage('Usage: /mcp remove <name>');
      return 'handled';
    }
    await ctx.updateSettings({mcpServers: removeMcpServer(ctx.settings, name)});
    ctx.addSystemMessage(`Removed MCP server ${name}.`);
    return 'handled';
  }
  if (sub === 'key') {
    const name = parts[1];
    const value = parts[2];
    if (!name || !value) {
      ctx.addSystemMessage('Usage: /mcp key <name> <value>  (sets an Authorization: Bearer <value> header)');
      return 'handled';
    }
    const server = findMcpServer(ctx.settings, name);
    if (!server) {
      ctx.addSystemMessage(`No MCP server named ${name}.`);
      return 'handled';
    }
    const headers = (server.headers ?? []).filter(header => header.name !== 'Authorization');
    headers.push({name: 'Authorization', value: `Bearer ${value}`});
    await ctx.updateSettings({mcpServers: upsertMcpServer(ctx.settings, {...server, headers})});
    ctx.addSystemMessage(`Set Authorization header for MCP server ${name}.`);
    return 'handled';
  }
  ctx.addSystemMessage('Unknown /mcp command. Use /mcp for help.');
  return 'handled';
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
      '  Show the configured provider, model, API key status, LSP/MCP servers, and loaded context files.',
      '/settings open',
      '  Open ~/.haze/settings.json with the OS default app.',
      '/create-skill',
      '  Launch the 3-step skill wizard (name, role, description).',
      '/skills',
      '  Show Markdown skill commands and installed skill slash commands.',
      '/init',
      '  Inspect the current workspace and create or update AGENTS.md project instructions.',
      '/session',
      '  Show the current durable session file.',
      '/resume',
      '  Resume the latest saved session for this workspace.',
      '/new',
      '  Start a fresh durable session.',
      '/logs',
      '  List recent log files with sizes and dates.',
      '/lsp',
      '  Configure read-only Language Server Protocol navigation tools.',
      '/mcp',
      '  Configure Model Context Protocol servers (e.g. Context7) to add external tools.',
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
    const args = value.slice('/lsp'.length).trim();
    return await handleLspCommand(args, ctx);
  }
  if (value === '/mcp' || value.startsWith('/mcp ')) {
    const args = value.slice('/mcp'.length).trim();
    return await handleMcpCommand(args, ctx);
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
    const lines = [
      `Provider: ${activeProvider?.name ?? 'not configured'}`,
      `Model: ${ctx.settings.model ?? 'not set'}`,
      `Base URL: ${activeProvider?.url ?? ctx.settings.baseURL ?? 'not configured'}`,
      `API key: ${activeProvider && providerHasKey(ctx.settings, activeProvider) ? 'saved' : 'missing'}`,
      `Configured providers: ${providers.map(provider => provider.name).join(', ') || 'none'}`,
      `LSP servers: ${lspServers.map(server => `${server.name}${server.enabled === false ? ' (disabled)' : ''}`).join(', ') || 'none'}`,
      `MCP servers: ${configuredMcpServers(ctx.settings).map(server => `${server.name}${server.enabled === false ? ' (disabled)' : ''}`).join(', ') || 'none'}`,
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
  if (value === '/skills') return await handleSkillCommand('help', '', ctx);
  if (value === '/create-skill' || value.startsWith('/create-skill ')) return await handleSkillCommand('create', '', ctx);
  if (value === '/skill-info' || value.startsWith('/skill-info ')) return await handleSkillCommand('info', value.slice('/skill-info '.length), ctx);
  if (value === '/validate-skill' || value.startsWith('/validate-skill ')) return await handleSkillCommand('validate', value.slice('/validate-skill '.length), ctx);
  if (value === '/remove-skill' || value.startsWith('/remove-skill ')) return await handleSkillCommand('remove', value.slice('/remove-skill '.length), ctx);
  if (value.startsWith('/')) {
    ctx.addSystemMessage(`Unknown command: ${value}. Bold start.`);
    return 'handled';
  }
  return 'unhandled';
}
