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
  {usage: '/compact [instructions]', description: 'Summarize older model context and keep recent messages.'},
  {usage: '/clear', description: 'Clear the current chat conversation history.'},
  {usage: '/exit', description: 'Exit haze.'},
  {usage: '/quit', description: 'Exit haze.'},
];

export function formatCommandHelp(entries: CommandHelpEntry[] = COMMAND_HELP_ENTRIES): string {
  return ['Commands:', ...entries.flatMap(entry => [entry.usage, `  ${entry.description}`])].join('\n');
}
