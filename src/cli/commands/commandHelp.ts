export type CommandHelpEntry = {
  usage: string;
  description: string;
};

export const COMMAND_HELP_ENTRIES: CommandHelpEntry[] = [
  {usage: '/help', description: 'Show all available slash commands and what they do.'},
  {usage: '/provider', description: 'Choose a provider, then use it, add/remove models, set API key, toggle image input, or remove it.'},
  {usage: '/model', description: 'Choose a model, or add models from a provider\'s models endpoint.'},
  {usage: '/model <name-or-provider:name>', description: 'Set a model directly. Selecting a model also sets its provider.'},
  {usage: '/settings', description: 'Show the configured provider, model, API key status, LSP/MCP servers, skills, and loaded context files.'},
  {usage: '/settings open', description: 'Open ~/.haze/settings.json with the OS default app.'},
  {usage: '/themes', description: 'Choose a terminal theme from the built-in registry (light palettes and oh-my-zsh ports included); applies immediately.'},
  {usage: '/themes <name>', description: 'Set the theme directly, e.g. /themes robbyrussell. Saved to ~/.haze/settings.json; text already on screen keeps its old colors.'},
  {usage: '/reasoning', description: 'Choose a reasoning effort level (none, minimal, low, medium, high, xhigh) for the active model, for this session; unset sends no parameter, reset falls back to the saved/default level.'},
  {usage: '/reasoning <level|unset|reset|status>', description: 'Set the reasoning effort for the active model for this session, send no parameter with unset, remove the override with reset, or show the current level with status. Medium is the default. Endpoints without native support ignore the parameter.'},
  {usage: '/thinking', description: 'Alias for /reasoning. Choose a reasoning effort level (none, minimal, low, medium, high, xhigh) for the active model, for this session; unset sends no parameter, reset falls back to the saved/default level.'},
  {usage: '/thinking <level|unset|reset|status>', description: 'Alias for /reasoning. Set the reasoning effort for the active model for this session, send no parameter with unset, remove the override with reset, or show the current level with status. Medium is the default. Endpoints without native support ignore the parameter.'},
  {usage: '/kit [list|inspect <path>|install <path>|remove <id>]', description: 'Manage local project skill kits. Inspect trusted source content before installing; existing files are never overwritten.'},
  {usage: '/skills', description: 'Manage Markdown skills: generate a custom skill, show info, enable/disable, validate, or remove.'},
  {usage: '/tips', description: 'Toggle the rotating tips shown under the busy label while the model is thinking.'},
  {usage: '/fleet [--review] [--profile <name>] [--workers <provider:model>] [--concurrency <n>] [--] <prompt>', description: 'Run genuinely independent tasks through disposable contexts. Runtime enforces profile concurrency, deadlines, and mutation serialization; control guidance is not persisted. Declines non-parallel work.'},
  {usage: '/init', description: 'Inspect the current workspace and create or update AGENTS.md project instructions.'},
  {usage: '/context', description: 'Show a token breakdown of the current request: system prompt, project context, tools (incl. MCP), and chat messages.'},
  {usage: '/session', description: 'Show the current durable session file.'},
  {usage: '/resume [id]', description: 'Browse this workspace’s saved sessions, or resume an exact session id.'},
  {usage: '/new', description: 'Start a fresh durable session.'},
  {usage: '/logs', description: 'List recent log files with sizes and dates.'},
  {usage: '/lsp', description: 'Configure Language Server Protocol navigation tools (interactive picker).'},
  {usage: '/mcp', description: 'Configure Model Context Protocol servers like Context7 (interactive picker).'},
  {usage: '/logs <id>', description: 'Show summary of a specific log: entry counts by type, total tokens, tool calls.'},
  {usage: '/logs <id> view', description: 'Page the raw log JSONL through $PAGER in a fullscreen terminal handoff.'},
  {usage: '/editor', description: 'Compose a prompt in $EDITOR, then submit it as the next message.'},
  {usage: '/compact [instructions]', description: 'Summarize older model context and keep recent messages.'},
  {usage: '/clear', description: 'Clear the current chat conversation history.'},
  {usage: '/exit', description: 'Exit haze.'},
  {usage: '/quit', description: 'Exit haze.'},
];

export function formatCommandHelp(entries: CommandHelpEntry[] = COMMAND_HELP_ENTRIES): string {
  return ['Commands:', ...entries.flatMap(entry => [entry.usage, `  ${entry.description}`])].join('\n');
}
