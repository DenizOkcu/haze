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
  if (value.startsWith('/')) {
    ctx.addSystemMessage(`Unknown command: ${value}. Bold start.`);
    return 'handled';
  }
  return 'unhandled';
}
