export type CommandHelpEntry = {
  usage: string;
  description: string;
};

export const COMMAND_HELP_ENTRIES: CommandHelpEntry[] = [
  {usage: '/help', description: 'Show all available slash commands and what they do.'},
  {usage: '/provider', description: 'Choose a provider, then use it, add/remove models, set API key, or remove it.'},
  {usage: '/model', description: 'Choose a model from all configured providers.'},
  {usage: '/model <name-or-provider:name>', description: 'Set a model directly. Selecting a model also sets its provider.'},
  {usage: '/settings', description: 'Show the configured provider, model, API key status, LSP/MCP servers, skills, and loaded context files.'},
  {usage: '/settings open', description: 'Open ~/.haze/settings.json with the OS default app.'},
  {usage: '/skills', description: 'Manage Markdown skills: generate a custom skill, show info, enable/disable, validate, or remove.'},
  {usage: '/init', description: 'Inspect the current workspace and create or update AGENTS.md project instructions.'},
  {usage: '/context', description: 'Show a token breakdown of the current request: system prompt, project context, tools (incl. MCP), and chat messages.'},
  {usage: '/session', description: 'Show the current durable session file.'},
  {usage: '/resume', description: 'Resume the latest saved session for this workspace.'},
  {usage: '/new', description: 'Start a fresh durable session.'},
  {usage: '/logs', description: 'List recent log files with sizes and dates.'},
  {usage: '/lsp', description: 'Configure Language Server Protocol navigation tools (interactive picker).'},
  {usage: '/mcp', description: 'Configure Model Context Protocol servers like Context7 (interactive picker).'},
  {usage: '/logs <id>', description: 'Show summary of a specific log: entry counts by type, total tokens, tool calls.'},
  {usage: '/cost [session|today|week]', description: 'Show estimated token usage and cost for the current session, today, or the last 7 days.'},
  {usage: '/usage [session|today|week]', description: 'Alias for /cost.'},
  {usage: '/compact [instructions]', description: 'Summarize older model context and keep recent messages.'},
  {usage: '/clear', description: 'Clear the current chat conversation history.'},
  {usage: '/exit', description: 'Exit Haze.'},
  {usage: '/quit', description: 'Exit Haze.'},
];

export function formatCommandHelp(entries: CommandHelpEntry[] = COMMAND_HELP_ENTRIES): string {
  return ['Commands:', ...entries.flatMap(entry => [entry.usage, `  ${entry.description}`])].join('\n');
}
