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
    '/skills list',
    '  List installed global and local skills.',
    '/skills info <name>',
    '  Show a skill description, tools, and path.',
    '/skills validate <dir>',
    '  Validate a skill directory containing skill.yaml.',
    '/skills remove <name> --yes',
    '  Remove an installed skill. Requires --yes because it deletes files.',
    '/skills install <githubRepo> --yes',
    '  Clone, inspect, and install a skill from GitHub. Requires --yes.',
    '/skills build <name> <toolName> <description...>',
    '  Create a global skill scaffold.',
  ].join('\n');
}

async function handleSkillsCommand(value: string, ctx: CommandContext): Promise<CommandResult> {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const subcommand = parts[1];
  if (!subcommand || subcommand === 'help') {
    ctx.addSystemMessage(skillHelp());
    return 'handled';
  }

  if (subcommand === 'list') {
    const {loadSkillRegistry} = await import('../../skills/SkillRegistry.js');
    const registry = await loadSkillRegistry();
    const skills = [...registry.skills.values()];
    ctx.addSystemMessage(skills.length === 0
      ? 'No installed skills found.'
      : ['Installed skills:', ...skills.map(s => `- ${s.manifest.name} ${s.manifest.version} — ${s.manifest.description} (${s.source})`)].join('\n'));
    return 'handled';
  }

  if (subcommand === 'info') {
    const name = parts[2];
    if (!name) {
      ctx.addSystemMessage('Usage: /skills info <name>');
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
      `${skill.manifest.name} ${skill.manifest.version}`,
      skill.manifest.description,
      '',
      'Tools:',
      ...(skill.tools.length ? skill.tools.map(t => `- ${t.id}: ${t.description}`) : ['- none']),
      '',
      `Path: ${skill.dir}`,
    ].join('\n'));
    return 'handled';
  }

  if (subcommand === 'validate') {
    const dir = parts[2];
    if (!dir) {
      ctx.addSystemMessage('Usage: /skills validate <dir>');
      return 'handled';
    }
    const {loadSkill} = await import('../../skills/SkillLoader.js');
    const skill = await loadSkill(path.resolve(dir), 'local');
    ctx.addSystemMessage(skill ? `Valid: ${skill.manifest.name}` : 'No skill.yaml found');
    return 'handled';
  }

  if (subcommand === 'remove') {
    const name = parts[2];
    if (!name || !parts.includes('--yes')) {
      ctx.addSystemMessage('Usage: /skills remove <name> --yes');
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

  if (subcommand === 'install') {
    const spec = parts[2];
    if (!spec || !parts.includes('--yes')) {
      ctx.addSystemMessage('Usage: /skills install <githubRepo> --yes\nThis command installs code from the internet, so explicit --yes is required.');
      return 'handled';
    }
    const {prepareSkillInstall, formatSkillInstallPreview, activatePreparedSkillInstall} = await import('../../skills/installer/SkillInstaller.js');
    const prepared = await prepareSkillInstall(spec);
    const preview = formatSkillInstallPreview(prepared);
    const installed = await activatePreparedSkillInstall(prepared);
    ctx.addSystemMessage(`${preview}\n\n${installed}`);
    return 'handled';
  }

  if (subcommand === 'build') {
    const name = parts[2];
    const toolName = parts[3];
    const description = parts.slice(4).join(' ');
    if (!name || !toolName || !description) {
      ctx.addSystemMessage('Usage: /skills build <name> <toolName> <description...>');
      return 'handled';
    }
    const {createSkillScaffold} = await import('../../skills/builder/SkillBuilder.js');
    const result = await createSkillScaffold(name, toolName, description);
    ctx.addSystemMessage(`Created ${name} at ${result.dir}. Edit ${result.files.find(file => file.endsWith(`${toolName}.ts`)) ?? 'the generated tool'} before expecting miracles.`);
    return 'handled';
  }

  ctx.addSystemMessage(`Unknown skill command: /skills ${subcommand}\n\n${skillHelp()}`);
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
      '  Set the OpenRouter model directly, for example openai/gpt-4o-mini.',
      '/settings',
      '  Show the configured provider, model, API key status, and loaded context files.',
      '/skills help',
      '  Manage skills from inside the Haze app.',
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
    ctx.addSystemMessage('Enter an OpenRouter model name, e.g. openai/gpt-4o-mini or anthropic/claude-3.5-sonnet.');
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
  if (value === '/skills' || value.startsWith('/skills ')) {
    return await handleSkillsCommand(value, ctx);
  }
  if (value.startsWith('/')) {
    ctx.addSystemMessage(`Unknown command: ${value}. Bold start.`);
    return 'handled';
  }
  return 'unhandled';
}
