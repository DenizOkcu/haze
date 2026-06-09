import fs from 'fs-extra';
import path from 'node:path';
import {buildInitPrompt} from '../../llm/initPrompt.js';
import type {ContextFile} from '../../config/contextFiles.js';
import type {HazeSettings} from '../../config/settings.js';
import {activeProvider, configuredProviders, modelSelector, providerHasKey, resolveModelSelector, upsertProvider} from '../../config/providers.js';
import type {Mode} from './chat.js';
import {clearTasks, generateTaskId, loadTasks, saveTasks} from '../../core/tasks/taskStorage.js';

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
    '/create-skill <description>',
    '  Create a Markdown skill in ~/.haze/skills.',
    '/list-skills',
    '  List installed skills.',
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
    ? ['Installed skills:', '- None yet. Create one with /create-skill <description>.']
    : ['Installed skills:', ...skills.map(s => `- /${s.name} - ${s.description}`)];
  return `${skillHelp()}\n\n${installed.join('\n')}`;
}

async function handleSkillCommand(value: string, ctx: CommandContext): Promise<CommandResult> {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const subcommand = parts[1];
  if (!subcommand || subcommand === 'help') {
    ctx.addSystemMessage(await skillOverview());
    return 'handled';
  }

  if (subcommand === 'create') {
    const description = parts.slice(2).join(' ');
    if (!description) {
      ctx.addSystemMessage('Usage: /create-skill <description>');
      return 'handled';
    }
    const {createSkill} = await import('../../skills/builder/SkillBuilder.js');
    const result = await createSkill(description);
    ctx.addSystemMessage(`Created skill ${result.name} at ${result.file}. Invoke it with /${result.name}. Edit SKILL.md to refine its workflow.`);
    return 'handled';
  }

  if (subcommand === 'list') {
    const {loadSkillRegistry} = await import('../../skills/SkillRegistry.js');
    const registry = await loadSkillRegistry();
    const skills = [...registry.skills.values()];
    ctx.addSystemMessage(skills.length === 0
      ? 'No installed skills found. Create one with /create-skill <description>.'
      : ['Installed skills:', ...skills.map(s => `- /${s.name} - ${s.description}`)].join('\n'));
    return 'handled';
  }

  if (subcommand === 'info') {
    const name = parts[2];
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

  if (subcommand === 'validate') {
    const target = parts[2];
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

  if (subcommand === 'remove') {
    const name = parts[2];
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

  ctx.addSystemMessage(`Unknown skill command: ${parts[0]} ${subcommand}\n\n${skillHelp()}`);
  return 'handled';
}

const STATUS_ICON: Record<string, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '✓',
};

async function handleTasksCommand(args: string, ctx: CommandContext): Promise<CommandResult> {
  const parts = args.split(/\s+/).filter(Boolean);
  const subcommand = parts[0]?.toLowerCase();

  if (!subcommand || subcommand === 'help') {
    const tasks = await loadTasks();
    if (tasks.length === 0) {
      ctx.addSystemMessage('No tasks. Add one with /tasks add <title>.');
    } else {
      const list = tasks.map((t, i) => `  ${STATUS_ICON[t.status] ?? '○'} ${i + 1}. ${t.title}`).join('\n');
      ctx.addSystemMessage(`Tasks:\n${list}`);
    }
    return 'handled';
  }

  if (subcommand === 'add') {
    const title = parts.slice(1).join(' ').trim();
    if (!title) {
      ctx.addSystemMessage('Usage: /tasks add <title>');
      return 'handled';
    }
    const tasks = await loadTasks();
    const now = new Date().toISOString();
    tasks.push({id: generateTaskId(), title, status: 'pending', createdAt: now, updatedAt: now});
    await saveTasks(tasks);
    ctx.addSystemMessage(`Added: ${title}`);
    return 'handled';
  }

  if (subcommand === 'remove' || subcommand === 'rm') {
    const numStr = parts[1];
    if (!numStr) {
      ctx.addSystemMessage('Usage: /tasks remove <number>');
      return 'handled';
    }
    const num = parseInt(numStr, 10);
    if (isNaN(num) || num < 1) {
      ctx.addSystemMessage('Provide a valid task number (e.g., /tasks remove 1).');
      return 'handled';
    }
    const tasks = await loadTasks();
    if (num > tasks.length) {
      ctx.addSystemMessage(`Task ${num} not found. You have ${tasks.length} task(s).`);
      return 'handled';
    }
    const removed = tasks.splice(num - 1, 1)[0]!;
    await saveTasks(tasks);
    ctx.addSystemMessage(`Removed: ${removed.title}`);
    return 'handled';
  }

  if (subcommand === 'clear') {
    await clearTasks();
    ctx.addSystemMessage('All tasks cleared.');
    return 'handled';
  }

  // Unknown subcommand → treat as task title
  const title = args.trim();
  const tasks = await loadTasks();
  const now = new Date().toISOString();
  tasks.push({id: generateTaskId(), title, status: 'pending', createdAt: now, updatedAt: now});
  await saveTasks(tasks);
  ctx.addSystemMessage(`Added: ${title}`);
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
      '  Show the configured provider, model, API key status, and loaded context files.',
      '/create-skill <description>',
      '  Create a reusable Markdown workflow from how you work.',
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
      '/tasks',
      '  Manage your task list. Subcommands: add <title>, remove <number>, clear.',
      '/tasks',
      '  Show current task list.',
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
  if (value === '/tasks' || value.startsWith('/tasks ')) {
    const args = value.slice('/tasks'.length).trim();
    return await handleTasksCommand(args, ctx);
  }
  if (value === '/settings') {
    const providers = configuredProviders(ctx.settings);
    const activeProvider = providers.find(provider => provider.name === ctx.settings.provider) ?? providers[0];
    ctx.addSystemMessage([
      `Provider: ${activeProvider?.name ?? 'not configured'}`,
      `Model: ${ctx.settings.model ?? 'not set'}`,
      `Base URL: ${activeProvider?.url ?? ctx.settings.baseURL ?? 'not configured'}`,
      `API key: ${activeProvider && providerHasKey(ctx.settings, activeProvider) ? 'saved' : 'missing'}`,
      `Configured providers: ${providers.map(provider => provider.name).join(', ') || 'none'}`,
      `Context files: ${ctx.contextFiles.length ? ctx.contextFiles.map(file => file.path).join(', ') : 'none'}`,
    ].join(' | '));
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
    return 'handled';
  }
  if (value === '/skills') return await handleSkillCommand('/skill help', ctx);
  if (value === '/list-skills') return await handleSkillCommand('/skill list', ctx);
  if (value === '/create-skill' || value.startsWith('/create-skill ')) return await handleSkillCommand(`/skill create${value.slice('/create-skill'.length)}`, ctx);
  if (value === '/skill-info' || value.startsWith('/skill-info ')) return await handleSkillCommand(`/skill info${value.slice('/skill-info'.length)}`, ctx);
  if (value === '/validate-skill' || value.startsWith('/validate-skill ')) return await handleSkillCommand(`/skill validate${value.slice('/validate-skill'.length)}`, ctx);
  if (value === '/remove-skill' || value.startsWith('/remove-skill ')) return await handleSkillCommand(`/skill remove${value.slice('/remove-skill'.length)}`, ctx);
  if (value === '/skill' || value.startsWith('/skill ') || value.startsWith('/skills ')) {
    const normalized = value.replace(/^\/skills\b/, '/skill');
    return await handleSkillCommand(normalized, ctx);
  }
  if (value.startsWith('/')) {
    ctx.addSystemMessage(`Unknown command: ${value}. Bold start.`);
    return 'handled';
  }
  return 'unhandled';
}
