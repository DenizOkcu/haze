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
  {usage: '/skills', description: 'Manage Markdown skills: generate a custom skill, show info, enable/disable, validate, or remove.'},
  {usage: '/plugin', description: 'Open the plugin picker: install or inspect a local plugin/collection, or manage installed project plugins. /kit is an alias.'},
  {usage: '/plugin inspect|install <local-directory> [plugin-name]', description: 'Inspect or install a Claude/Agent Plugins package or a selected local marketplace plugin. Only skills are activated; review source first.'},
  {usage: '/plugin list|remove <name>', description: 'List project-installed plugins or remove one, preserving modified and seed files. /kit is an alias.'},
  {usage: '/tips', description: 'Toggle the rotating tips shown under the busy label while the model is thinking.'},
  {usage: '/sandbox', description: 'Show the OS sandbox state: backend (seatbelt on macOS, bubblewrap on Linux), mode, profile, and the exact read-write/read-only roots.'},
  {usage: '/sandbox <auto|on|off|workspace|strict|reset|test|denials|status>', description: 'Control the OS sandbox for this session (in-memory, like /reasoning): auto sandboxes when a backend exists, on requires one, off disables; workspace allows network and cache writes, strict denies network. test runs live boundary probes; denials lists the session audit log of every classified sandbox rejection.'},
  {usage: '/sandbox grant [--rw] <path>, /sandbox revoke <path>', description: 'Persistently grant (or revoke) a sandboxed-command root for a path outside the boundary — tool config directories, module caches, SDK trees. Read-only by default (--rw adds writes) and disclosed as credential exposure when relevant; protected-secret paths are refused. Saved to sandbox.roRoots/rwRoots. Toolchains on $PATH and standard system directories are already read-only by default.'},
  {usage: '/add-dir [directory]', description: 'Extend the workspace with a directory for this session: file tools may read and edit inside it and sandboxed shell commands get it as a read-write root. Explicit user intent only — kept in memory, never persisted; /add-dir reset clears the list. Protected-secret paths are refused.'},
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
