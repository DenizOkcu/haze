import fs from 'fs-extra';
import path from 'node:path';
import {buildInitPrompt} from '../../llm/initPrompt.js';
import type {ContextFile} from '../../config/contextFiles.js';
import type {HazeSettings} from '../../config/settings.js';
import type {Mode} from './chat.js';

export type CommandContext = {
  settings: HazeSettings;
  contextFiles: ContextFile[];
  setMode: (mode: Mode) => void;
  addSystemMessage: (text: string) => void;
  clearConversation: () => void;
  runAgentTurn: (prompt: string, displayValue?: string) => Promise<void>;
  refreshContextFiles: () => Promise<ContextFile[]>;
  updateSettings: (patch: Partial<HazeSettings>) => Promise<HazeSettings>;
};

export type CommandResult = 'handled' | 'unhandled' | 'exit';

function skillHelp() {
  return [
    'Skill commands:',
    '/skill create <description>',
    '  Create a Markdown skill in ~/.haze/skills.',
    '/skill list',
    '  List installed skills.',
    '/skill info <name>',
    '  Show a skill description and path.',
    '/skill validate <name-or-dir>',
    '  Validate a skill directory containing SKILL.md.',
    '/skill remove <name> --yes',
    '  Remove an installed skill. Requires --yes because it deletes files.',
  ].join('\n');
}

async function handleSkillCommand(value: string, ctx: CommandContext): Promise<CommandResult> {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const subcommand = parts[1];
  if (!subcommand || subcommand === 'help') {
    ctx.addSystemMessage(skillHelp());
    return 'handled';
  }

  if (subcommand === 'create') {
    const description = parts.slice(2).join(' ');
    if (!description) {
      ctx.addSystemMessage('Usage: /skill create <description>');
      return 'handled';
    }
    const {createSkill} = await import('../../skills/builder/SkillBuilder.js');
    const result = await createSkill(description);
    ctx.addSystemMessage(`Created skill ${result.name} at ${result.file}. Edit SKILL.md to refine its workflow.`);
    return 'handled';
  }

  if (subcommand === 'list') {
    const {loadSkillRegistry} = await import('../../skills/SkillRegistry.js');
    const registry = await loadSkillRegistry();
    const skills = [...registry.skills.values()];
    ctx.addSystemMessage(skills.length === 0
      ? 'No installed skills found.'
      : ['Installed skills:', ...skills.map(s => `- ${s.name} — ${s.description}`)].join('\n'));
    return 'handled';
  }

  if (subcommand === 'info') {
    const name = parts[2];
    if (!name) {
      ctx.addSystemMessage('Usage: /skill info <name>');
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
      ctx.addSystemMessage('Usage: /skill validate <name-or-dir>');
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
      ctx.addSystemMessage('Usage: /skill remove <name> --yes');
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
      '/login',
      '  Save an OpenRouter API key to ~/.haze/settings.json.',
      '/model',
      '  Prompt for an OpenRouter model name to use for future chats.',
      '/model <name>',
      '  Set the OpenRouter model directly, for example x-ai/grok-build-0.1.',
      '/settings',
      '  Show the configured provider, model, API key status, and loaded context files.',
      '/skill help',
      '  Manage Markdown skills from inside the Haze app.',
      '/init',
      '  Inspect the current workspace and create or update AGENTS.md project instructions.',
      '/clear',
      '  Clear the current chat conversation history.',
      '/exit',
      '  Exit Haze.',
      '/quit',
      '  Exit Haze.',
    ].join('\n'));
    return 'handled';
  }
  if (value === '/clear') {
    ctx.clearConversation();
    ctx.addSystemMessage('Cleared. The void is productive.');
    return 'handled';
  }
  if (value === '/settings') {
    ctx.addSystemMessage(`Provider: ${ctx.settings.provider ?? 'not configured'} | Model: ${ctx.settings.model ?? 'not set'} | API key: ${ctx.settings.apiKey ? 'saved' : 'missing'} | Context files: ${ctx.contextFiles.length ? ctx.contextFiles.map(file => file.path).join(', ') : 'none'}`);
    return 'handled';
  }
  if (value === '/login') {
    ctx.setMode('apiKey');
    ctx.addSystemMessage('Paste your OpenRouter API key. It will be stored in ~/.haze/settings.json.');
    return 'handled';
  }
  if (value === '/model') {
    ctx.setMode('model');
    ctx.addSystemMessage('Enter an OpenRouter model name, e.g. x-ai/grok-build-0.1 or anthropic/claude-3.5-sonnet.');
    return 'handled';
  }
  if (value.startsWith('/model ')) {
    const modelName = value.slice('/model '.length).trim();
    await ctx.updateSettings({model: modelName});
    ctx.addSystemMessage(`Model set to ${modelName}. Saved to ~/.haze/settings.json and will be used until you set a new model.`);
    return 'handled';
  }
  if (value === '/init') {
    await ctx.runAgentTurn(buildInitPrompt(), '/init');
    await ctx.refreshContextFiles();
    return 'handled';
  }
  if (value === '/skill' || value.startsWith('/skill ') || value === '/skills' || value.startsWith('/skills ')) {
    const normalized = value.replace(/^\/skills\b/, '/skill');
    return await handleSkillCommand(normalized, ctx);
  }
  if (value.startsWith('/')) {
    ctx.addSystemMessage(`Unknown command: ${value}. Bold start.`);
    return 'handled';
  }
  return 'unhandled';
}
