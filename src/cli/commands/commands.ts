import {spawn} from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';
import {buildInitPrompt} from '../../llm/initPrompt.js';
import type {ContextFile} from '../../config/contextFiles.js';
import {MAX_CONTEXT_FILE_CHARS} from '../../config/contextFiles.js';
import {SETTINGS_FILE, writeSettings, type HazeSettings} from '../../config/settings.js';
import {activeProvider, configuredProviders, modelSelector, resolveModelSelector, upsertProvider} from '../../config/providers.js';
import type {Mode} from './chatModes.js';
import {clearTasks} from '../../core/tasks/taskStorage.js';
import {formatCommandHelp} from './commandHelp.js';
import {handleLogsCommand} from './logsCommand.js';
import {formatSettingsSummary} from './settingsSummary.js';

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

export async function handleSlashCommand(
  value: string,
  ctx: CommandContext
): Promise<CommandResult> {
  if (value === '/exit' || value === '/quit') return 'exit';
  if (value === '/help') {
    ctx.addSystemMessage(formatCommandHelp());
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
    ctx.addSystemMessage(await formatSettingsSummary(ctx.settings, ctx.contextFiles));
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
