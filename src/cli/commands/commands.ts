import {spawn} from 'node:child_process';
import fs from 'fs-extra';
import type {ContextFile} from '../../config/contextFiles.js';
import {SETTINGS_FILE, writeSettings, type HazeSettings} from '../../config/settings.js';
import type {Mode} from './chatModes.js';
import {clearTasks} from '../../core/tasks/taskStorage.js';
import {COMMAND_HELP_ENTRIES, formatCommandHelp} from './commandHelp.js';
import {handleCostCommand} from './costCommand.js';
import {handleInitCommand} from './initCommand.js';
import {handleLogsCommand} from './logsCommand.js';
import {handleModelCommand} from './modelCommand.js';
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
  sessionStart?: Date;
};

export type CommandResult = 'handled' | 'unhandled' | 'exit';

type SlashCommand = {
  match: (value: string) => false | {args: string};
  run: (args: string, ctx: CommandContext) => Promise<CommandResult> | CommandResult;
};

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

const HANDLED: CommandResult = 'handled';

function exact(command: string): SlashCommand['match'] {
  return value => value === command ? {args: ''} : false;
}

function exactOrArgs(command: string): SlashCommand['match'] {
  return value => value === command ? {args: ''} : value.startsWith(`${command} `) ? {args: value.slice(command.length).trim()} : false;
}

const SLASH_COMMANDS: SlashCommand[] = [
  {match: value => value === '/exit' || value === '/quit' ? {args: ''} : false, run: () => 'exit'},
  {match: exact('/help'), run: (_args, ctx) => { ctx.addSystemMessage(formatCommandHelp(COMMAND_HELP_ENTRIES)); return HANDLED; }},
  {match: exact('/context'), run: async (_args, ctx) => { ctx.addSystemMessage(ctx.getContextReport ? await ctx.getContextReport() : 'Context overview is unavailable.'); return HANDLED; }},
  {match: exact('/session'), run: (_args, ctx) => { ctx.addSystemMessage(ctx.sessionInfo?.() ?? 'Session persistence is unavailable.'); return HANDLED; }},
  {match: exact('/resume'), run: async (_args, ctx) => { if (ctx.resumeSession) await ctx.resumeSession(); else ctx.addSystemMessage('Session persistence is unavailable.'); return HANDLED; }},
  {match: exact('/new'), run: async (_args, ctx) => { if (ctx.newSession) await ctx.newSession(); else ctx.addSystemMessage('Session persistence is unavailable.'); return HANDLED; }},
  {match: exactOrArgs('/compact'), run: (args, ctx) => { if (ctx.compactConversation) ctx.compactConversation(args || undefined); else ctx.addSystemMessage('Compaction is unavailable.'); return HANDLED; }},
  {match: exact('/clear'), run: async (_args, ctx) => { ctx.clearConversation(); await clearTasks(); ctx.addSystemMessage('Cleared. The void is productive.'); return HANDLED; }},
  {match: exactOrArgs('/logs'), run: async (args, ctx) => await handleLogsCommand(args, ctx)},
  {match: exactOrArgs('/lsp'), run: (_args, ctx) => { ctx.setMode('lsp'); ctx.addSystemMessage('Choose an LSP server to enable, disable, or remove it. Choose "add server" to add one from presets (e.g. typescript) or enter a custom command.'); return HANDLED; }},
  {match: exactOrArgs('/mcp'), run: (_args, ctx) => { ctx.setMode('mcp'); ctx.addSystemMessage('Choose an MCP server to enable, disable, remove, or set a key for it. Choose "add server" to add one from presets (e.g. context7) or enter custom details.'); return HANDLED; }},
  {match: value => value === '/settings open' || value === '/settings edit' ? {args: ''} : false, run: async (_args, ctx) => { const file = await ensureSettingsFile(ctx.settings); openPath(file); ctx.addSystemMessage(`Opened settings file: ${file}`); return HANDLED; }},
  {match: exact('/settings'), run: async (_args, ctx) => { ctx.addSystemMessage(await formatSettingsSummary(ctx.settings, ctx.contextFiles)); return HANDLED; }},
  {match: exact('/provider'), run: (_args, ctx) => { ctx.setModelProviderFilter?.(undefined); ctx.setMode('provider'); ctx.addSystemMessage('Choose a provider. Selecting one opens provider actions. Choose "add provider" to pick from presets or enter custom details.'); return HANDLED; }},
  {match: exact('/init'), run: async (_args, ctx) => await handleInitCommand(ctx)},
  {match: exactOrArgs('/cost'), run: async (args, ctx) => await handleCostCommand(args, ctx)},
  {match: exactOrArgs('/usage'), run: async (args, ctx) => await handleCostCommand(args, ctx)},
  {match: exact('/skills'), run: (_args, ctx) => { ctx.setMode('skills'); ctx.addSystemMessage('Choose a skill to show info, enable/disable, or remove it. Choose "add skill" to generate a new one from a description.'); return HANDLED; }},
];

export async function handleSlashCommand(
  value: string,
  ctx: CommandContext
): Promise<CommandResult> {
  for (const command of SLASH_COMMANDS) {
    const match = command.match(value);
    if (match) return await command.run(match.args, ctx);
  }
  const modelResult = await handleModelCommand(value, ctx);
  if (modelResult) return modelResult;
  if (value.startsWith('/')) {
    ctx.addSystemMessage(`Unknown command: ${value}. Bold start.`);
    return 'handled';
  }
  return 'unhandled';
}
