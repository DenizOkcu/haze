export type Mode = 'chat' | 'provider' | 'providerAction' | 'model' | 'providerAddPreset' | 'providerAddName' | 'providerAddUrl' | 'providerAddKey' | 'providerAddModels' | 'providerAppendModels' | 'providerSetKey' | 'providerRemoveModels' | 'providerConfirmRemove' | 'skills' | 'skillsAction' | 'skillsAddName' | 'skillsAddDescription' | 'skillsConfirmRemove' | 'lsp' | 'lspAction' | 'lspAddPreset' | 'lspAddName' | 'lspAddCommand' | 'lspConfirmRemove' | 'mcp' | 'mcpAction' | 'mcpAddPreset' | 'mcpAddName' | 'mcpAddTransport' | 'mcpAddUrl' | 'mcpAddCommand' | 'mcpAddKey' | 'mcpSetKey' | 'mcpConfirmRemove';

/** Modes that show an always-on suggestion picker (server/preset lists). */
export const PICKER_MODES: ReadonlySet<Mode> = new Set(['provider', 'providerAction', 'providerAddPreset', 'model', 'skills', 'skillsAction', 'lsp', 'lspAction', 'lspAddPreset', 'mcp', 'mcpAction', 'mcpAddPreset', 'mcpAddTransport']);

/** Modes that mask input (secrets/API keys). */
export const MASKED_MODES: ReadonlySet<Mode> = new Set(['providerAddKey', 'providerSetKey', 'mcpAddKey', 'mcpSetKey']);

/** Modes where submitting an empty value is valid (optional steps). */
export const SUBMIT_EMPTY_MODES: ReadonlySet<Mode> = new Set(['providerAddKey', 'mcpAddKey']);

const PLACEHOLDERS: Partial<Record<Mode, string>> = {
  provider: 'Choose provider',
  providerAction: 'Choose provider action',
  providerAddPreset: 'Choose a provider preset or custom',
  model: 'Choose model',
  providerAddName: 'Provider name',
  providerAddUrl: 'https://example.com/v1',
  providerAddKey: 'API key, or blank for local',
  providerSetKey: 'API key',
  providerAddModels: 'model-a, model-b',
  providerAppendModels: 'model-a, model-b',
  providerRemoveModels: 'model-a, model-b',
  providerConfirmRemove: 'Type "yes" to confirm',
  skills: 'Choose a skill or add skill',
  skillsAction: 'show info, enable, disable, validate, or remove',
  skillsAddName: 'Skill name (kebab-case, e.g. security-review)',
  skillsAddDescription: 'Describe what the skill should do',
  skillsConfirmRemove: 'Type "yes" to confirm',
  lsp: 'Choose LSP server or add server',
  lspAction: 'enable, disable, or remove server',
  lspAddPreset: 'Choose an LSP preset or custom',
  lspAddName: 'LSP server name (e.g. typescript)',
  lspAddCommand: 'Command (e.g. typescript-language-server --stdio)',
  lspConfirmRemove: 'Type "yes" to confirm',
  mcp: 'Choose MCP server or add server',
  mcpAction: 'enable, disable, remove, or set key',
  mcpAddPreset: 'Choose an MCP preset or custom',
  mcpAddName: 'MCP server name (e.g. context7)',
  mcpAddTransport: 'http, sse, or stdio',
  mcpAddUrl: 'https://mcp.example.com/mcp',
  mcpAddCommand: 'Command (e.g. npx -y @pkg/server)',
  mcpAddKey: 'API key, or blank to skip',
  mcpSetKey: 'API key',
  mcpConfirmRemove: 'Type "yes" to confirm',
};

export function placeholderForMode(mode: Mode, busy: boolean): string {
  return PLACEHOLDERS[mode] ?? (busy ? 'Queue a follow-up, or Esc to interrupt' : 'Ask Haze to help build your app');
}
