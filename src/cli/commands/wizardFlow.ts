import type {HazeMcpServer, HazeSettings} from '../../config/settings.js';
import {configuredProviders, findProvider, modelSelector, providerImageCapable} from '../../config/providers.js';
import {configuredLspServers, LSP_PRESETS} from '../../config/lspSettings.js';
import {configuredMcpServers, findMcpServer, findMcpPreset, presetIds} from '../../config/mcpSettings.js';
import {isSkillEnabled} from '../../config/skillSettings.js';
import {PROVIDER_PRESETS} from '../../config/providerPresets.js';
import {CHATGPT_CODEX_BASE_URL} from '../../llm/openaiCodexOAuth.js';
import type {LoadedSkill} from '../../skills/types.js';
import type {SessionSummary} from '../../core/session/sessionStore.js';
import type {TextInputSuggestion} from '../../ui/components/TextInput.js';
import {BUILT_IN_THEME_SPECS, DEFAULT_THEME_NAME, resolveTheme} from '../../ui/theme.js';
import {sessionActionSuggestions, sessionSuggestions} from './sessionPicker.js';

/**
 * Wizard flow table (CR-006 successor): the single source of truth for every
 * picker/wizard step. A step's kind, placeholder, suggestion list, and (for
 * field-capture steps) its pure capture function all live in one entry, so
 * adding a wizard step touches one table row — `chatModes.ts` derives the
 * `Mode` union and the picker/masked/empty-submit classification from this
 * table, and `chat/wizardDispatch.ts` drives the submits.
 *
 * Keep this module a leaf: it must not import the per-domain `*Wizard.ts`
 * result modules or `chatModes.ts`, so the dependency graph stays acyclic
 * (domain modules import the shared constants/helpers from here).
 */

// ── Shared action/choice vocabulary ─────────────────────────────────────────

export const PROVIDER_CHOICES = {
  addProvider: 'add provider',
  custom: 'custom',
} as const;

export const PROVIDER_ACTIONS = {
  useProvider: 'use provider',
  addModels: 'add models',
  manageAccess: 'set API key',
  signInChatGpt: 'sign in with ChatGPT',
  markImageCapable: 'mark image-capable',
  clearImageCapable: 'clear image-capable',
  removeModels: 'remove models',
  removeProvider: 'remove provider',
} as const;

export const MODEL_CHOICES = {
  addModels: 'add models',
  enterModelNames: 'enter model names',
} as const;

export const SERVER_CHOICES = {
  addServer: 'add server',
  custom: 'custom',
} as const;

export const COMMON_ACTIONS = {
  enable: 'enable',
  disable: 'disable',
} as const;

export const LSP_ACTIONS = {
  removeServer: 'remove server',
} as const;

export const MCP_ACTIONS = {
  manageAccess: 'set API key',
  removeServer: 'remove server',
} as const;

export const MCP_TRANSPORTS = {
  http: 'http',
  sse: 'sse',
  stdio: 'stdio',
} as const;

export const SKILL_CHOICES = {
  addSkill: 'add skill',
} as const;

export const SKILL_ACTIONS = {
  showInfo: 'show info',
  validate: 'validate',
  removeSkill: 'remove skill',
} as const;

const YES_CONFIRMATION = 'yes';

// ── Input parsing helpers ───────────────────────────────────────────────────

export function commaList(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

export function commandParts(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

export function isYesConfirmation(value: string): boolean {
  return value.trim().toLowerCase() === YES_CONFIRMATION;
}

export function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// ── Skill selection lookup (shared by suggestions and the skills wizard) ────

export function skillPickerValue(skill: LoadedSkill) {
  return `${skill.name} · ${skill.source}`;
}

export function findSelectedSkill(skills: LoadedSkill[], selection: string | undefined) {
  if (!selection) return undefined;
  return skills.find(skill => skillPickerValue(skill) === selection)
    ?? skills.find(skill => skill.name === selection);
}

// ── Pure field-capture steps (provider/MCP/LSP add flows) ───────────────────

export type NameCaptureResult = {
  nextMode?: string;
  draft?: {name?: string};
  message?: string;
  systemMessage?: string;
};

export function captureProviderName(settings: HazeSettings, value: string): NameCaptureResult {
  const name = value.trim();
  if (!name) return {message: 'Provider name is required.'};
  if (settings.providers?.some(provider => provider.name === name)) return {message: `Provider ${name} already exists. Choose a unique name.`};
  return {nextMode: 'providerAddUrl', draft: {name}, systemMessage: 'OpenAI-compatible base URL? Example: https://openrouter.ai/api/v1 or http://localhost:1234/v1'};
}

export function captureLspName(settings: HazeSettings, value: string): NameCaptureResult {
  const name = value.trim();
  if (!name) return {message: 'LSP server name is required.'};
  if (configuredLspServers(settings).some(server => server.name === name)) return {message: `LSP server ${name} already exists. Choose a unique name.`};
  return {nextMode: 'lspAddCommand', draft: {name}, systemMessage: 'Command to run? Example: typescript-language-server --stdio'};
}

export function captureMcpName(settings: HazeSettings, value: string): NameCaptureResult {
  const name = value.trim();
  if (!name) return {message: 'MCP server name is required.'};
  if (findMcpServer(settings, name)) return {message: `MCP server ${name} already exists. Choose a unique name.`};
  return {nextMode: 'mcpAddTransport', draft: {name}, systemMessage: 'Transport type? http (Streamable HTTP), sse (Server-Sent Events), or stdio (local process).'};
}

export type FieldCaptureResult = {
  draft?: Partial<HazeMcpServer>;
  message?: string;
  nextMode?: string;
  systemMessage?: string;
};

export function captureProviderUrl(value: string): FieldCaptureResult {
  if (!isValidUrl(value)) return {message: 'Enter a valid URL, for example http://localhost:1234/v1.'};
  // The Codex endpoint only accepts ChatGPT sign-in, never API keys; point
  // users at the preset instead of a custom provider that cannot work (F-14).
  const codexHint = value.trim() === CHATGPT_CODEX_BASE_URL
    ? `\nNote: ${CHATGPT_CODEX_BASE_URL} serves ChatGPT sign-in only. To use it, add the OpenAI Subscription preset via /provider instead of a custom API-key provider.`
    : '';
  return {draft: {url: value.trim()}, nextMode: 'providerAddKey', systemMessage: `API key? Leave blank for local/keyless providers.${codexHint}`};
}

export function captureMcpUrl(value: string): FieldCaptureResult {
  if (!isValidUrl(value)) return {message: 'Enter a valid URL, for example https://mcp.context7.com/mcp.'};
  return {draft: {url: value.trim()}, nextMode: 'mcpAddKey', systemMessage: 'Optional API key or auth header value? (Leave blank to skip — Enter works.) Sent as Authorization: Bearer <value>.'};
}

export function captureMcpTransport(value: string): FieldCaptureResult {
  const transport = value.trim().toLowerCase();
  if (transport !== MCP_TRANSPORTS.http && transport !== MCP_TRANSPORTS.sse && transport !== MCP_TRANSPORTS.stdio) return {message: 'Enter http, sse, or stdio.'};
  if (transport === MCP_TRANSPORTS.stdio) return {draft: {transport}, nextMode: 'mcpAddCommand', systemMessage: 'Command to run? Example: npx -y @modelcontextprotocol/server-filesystem .'};
  return {draft: {transport}, nextMode: 'mcpAddUrl', systemMessage: `MCP server URL? Example: https://mcp.context7.com/mcp for ${transport}.`};
}

export function captureMcpCommand(value: string): FieldCaptureResult {
  const parts = commandParts(value);
  if (parts.length === 0) return {message: 'Command is required.'};
  return {draft: {command: parts[0], args: parts.slice(1)}, nextMode: 'chat', systemMessage: 'Stdio MCP authentication must be handled by the command or wrapper; HTTP headers do not apply.'};
}

// ── Suggestion builders (pure; bound to steps in the table below) ───────────

export function providerSuggestions(settings: HazeSettings): TextInputSuggestion[] {
  return [
    ...configuredProviders(settings).map(provider => ({
      value: provider.name,
      description: `${provider.url} · ${provider.models.length} model${provider.models.length === 1 ? '' : 's'}`,
      kind: 'provider' as const,
    })),
    {value: PROVIDER_CHOICES.addProvider, description: 'Add a new provider (presets available)', kind: 'provider' as const},
  ];
}

export function providerActionSuggestions(settings: HazeSettings, selectedProviderName: string | undefined): TextInputSuggestion[] {
  const provider = selectedProviderName ? findProvider(settings, selectedProviderName) : undefined;
  return [
    {value: PROVIDER_ACTIONS.useProvider, description: 'Set this provider and choose a model', kind: 'provider' as const},
    {value: PROVIDER_ACTIONS.addModels, description: provider?.kind === 'chatgpt-codex' ? 'Add a supported Codex model name' : 'Fetch the provider model list and add models', kind: 'provider' as const},
    ...(provider?.kind === 'chatgpt-codex'
      ? [{value: PROVIDER_ACTIONS.signInChatGpt, description: 'Sign in again or switch ChatGPT account', kind: 'provider' as const}]
      : [{value: PROVIDER_ACTIONS.manageAccess, description: provider?.key ? 'Update the saved API key' : 'Add an API key', kind: 'provider' as const}]),
    provider
      ? (providerImageCapable(provider)
        ? {value: PROVIDER_ACTIONS.clearImageCapable, description: 'Stop sending attached images to this provider', kind: 'provider' as const}
        : {value: PROVIDER_ACTIONS.markImageCapable, description: 'Allow attached images to be sent to this provider', kind: 'provider' as const})
      : {value: PROVIDER_ACTIONS.markImageCapable, description: 'Allow attached images to be sent to this provider', kind: 'provider' as const},
    ...(provider?.models?.length ? [{value: PROVIDER_ACTIONS.removeModels, description: 'Remove models from this provider', kind: 'provider' as const}] : []),
    {value: PROVIDER_ACTIONS.removeProvider, description: 'Delete this provider from settings', kind: 'provider' as const},
  ];
}

export function presetSuggestions(): TextInputSuggestion[] {
  const cloudPresets = PROVIDER_PRESETS.filter(p => p.category === 'cloud');
  const localPresets = PROVIDER_PRESETS.filter(p => p.category === 'local');
  return [
    ...cloudPresets.map(preset => ({
      value: preset.id,
      description: `${preset.baseUrl}${preset.auth === 'chatgpt-oauth' ? ' · browser sign-in' : ''}${preset.suggestedModels?.length ? ' · e.g. ' + preset.suggestedModels.slice(0, 2).join(', ') : ''}`,
      kind: 'provider' as const,
    })),
    ...localPresets.map(preset => ({
      value: preset.id,
      description: `${preset.baseUrl} · local, no API key needed`,
      kind: 'provider' as const,
    })),
    {value: PROVIDER_CHOICES.custom, description: 'Enter provider name, URL, and API key manually', kind: 'provider' as const},
  ];
}

export function modelSuggestions(settings: HazeSettings, modelProviderFilter: string | undefined): TextInputSuggestion[] {
  const providers = configuredProviders(settings).filter(provider => !modelProviderFilter || provider.name === modelProviderFilter);
  return [
    ...providers.flatMap(provider => provider.models.map(model => ({
      value: modelProviderFilter ? model : modelSelector(provider, model),
      description: provider.name,
      kind: 'model' as const,
    }))),
    {value: MODEL_CHOICES.addModels, description: modelProviderFilter ? `Add models to ${modelProviderFilter} (fetched from its models endpoint)` : 'Add models to a provider (fetched from its models endpoint)', kind: 'model' as const},
  ];
}

export function modelAddProviderSuggestions(settings: HazeSettings): TextInputSuggestion[] {
  return configuredProviders(settings).map(provider => ({
    value: provider.name,
    description: `${provider.models.length} model${provider.models.length === 1 ? '' : 's'} configured`,
    kind: 'provider' as const,
  }));
}

/**
 * Model picker fed by live /models discovery. Curated `suggestedModels`
 * (from provider presets) are pinned atop the discovered list when the
 * endpoint actually serves them — stale curation entries simply don't pin.
 */
export function modelPickSuggestions(settings: HazeSettings, providerName: string | undefined, discoveredModels: string[], suggestedModels: string[] = []): TextInputSuggestion[] {
  const provider = providerName ? findProvider(settings, providerName) : undefined;
  const configured = new Set(provider?.models ?? []);
  const available = discoveredModels.filter(model => !configured.has(model));
  const availableSet = new Set(available);
  const pinned = suggestedModels.filter(model => availableSet.has(model));
  const pinnedSet = new Set(pinned);
  return [
    ...pinned.map(model => ({
      value: model,
      description: 'suggested',
      kind: 'model' as const,
    })),
    ...available.filter(model => !pinnedSet.has(model)).map(model => ({
      value: model,
      description: providerName,
      kind: 'model' as const,
    })),
    {value: MODEL_CHOICES.enterModelNames, description: 'Type comma-separated model names instead', kind: 'model' as const},
  ];
}

export function lspSuggestions(settings: HazeSettings): TextInputSuggestion[] {
  const servers = configuredLspServers(settings);
  return [{value: SERVER_CHOICES.addServer, description: 'add an LSP server (presets available)', kind: 'lsp' as const},
    ...servers.map(server => ({
      value: server.name,
      description: `${server.command}${(server.args ?? []).length ? ` ${(server.args ?? []).join(' ')}` : ''} · ${server.enabled === false ? 'disabled' : 'enabled'}`,
      kind: 'lsp' as const,
    }))];
}

export function lspActionSuggestions(settings: HazeSettings, selectedLspName: string | undefined): TextInputSuggestion[] {
  const server = selectedLspName ? configuredLspServers(settings).find(s => s.name === selectedLspName) : undefined;
  const result: TextInputSuggestion[] = [];
  if (server) result.push({value: server.enabled === false ? COMMON_ACTIONS.enable : COMMON_ACTIONS.disable, description: `${server.enabled === false ? COMMON_ACTIONS.enable : COMMON_ACTIONS.disable} this server`, kind: 'lsp' as const});
  result.push({value: LSP_ACTIONS.removeServer, description: 'remove this server', kind: 'lsp' as const});
  return result;
}

function lspPresetSuggestions(): TextInputSuggestion[] {
  return [
    ...Object.values(LSP_PRESETS).map(preset => ({
      value: preset.name,
      description: `${preset.command} ${(preset.args ?? []).join(' ')} [${(preset.extensions ?? []).join(', ')}]`,
      kind: 'lsp' as const,
    })),
    {value: SERVER_CHOICES.custom, description: 'enter a name and command manually', kind: 'lsp' as const},
  ];
}

export function mcpSuggestions(settings: HazeSettings): TextInputSuggestion[] {
  const servers = configuredMcpServers(settings);
  return [{value: SERVER_CHOICES.addServer, description: 'add an MCP server (presets available)', kind: 'mcp' as const},
    ...servers.map(server => {
      const location = server.url ?? (server.command ? `${server.command} ${(server.args ?? []).join(' ')}`.trim() : '');
      return {value: server.name, description: `${server.transport}${location ? ` ${location}` : ''} · ${server.enabled === false ? 'disabled' : 'enabled'}`, kind: 'mcp' as const};
    })];
}

export function mcpActionSuggestions(settings: HazeSettings, selectedMcpName: string | undefined): TextInputSuggestion[] {
  const server = selectedMcpName ? findMcpServer(settings, selectedMcpName) : undefined;
  const result: TextInputSuggestion[] = [];
  if (server) {
    result.push({value: server.enabled === false ? COMMON_ACTIONS.enable : COMMON_ACTIONS.disable, description: `${server.enabled === false ? COMMON_ACTIONS.enable : COMMON_ACTIONS.disable} this server`, kind: 'mcp' as const});
    if (server.transport !== 'stdio') result.push({value: MCP_ACTIONS.manageAccess, description: server.headers?.length ? 'update the saved API key' : 'add an API key', kind: 'mcp' as const});
  }
  result.push({value: MCP_ACTIONS.removeServer, description: 'remove this server', kind: 'mcp' as const});
  return result;
}

function mcpPresetSuggestions(): TextInputSuggestion[] {
  return [
    ...presetIds().map(presetId => {
      const preset = findMcpPreset(presetId)!;
      return {value: presetId, description: preset.description ?? `${preset.transport} server`, kind: 'mcp' as const};
    }),
    {value: SERVER_CHOICES.custom, description: 'enter name, transport, and URL or command manually', kind: 'mcp' as const},
  ];
}

export function mcpTransportSuggestions(): TextInputSuggestion[] {
  return [
    {value: MCP_TRANSPORTS.http, description: 'Streamable HTTP (remote)', kind: 'mcp' as const},
    {value: MCP_TRANSPORTS.sse, description: 'Server-Sent Events (remote)', kind: 'mcp' as const},
    {value: MCP_TRANSPORTS.stdio, description: 'local process', kind: 'mcp' as const},
  ];
}

export function skillsSuggestions(settings: HazeSettings, skills: LoadedSkill[]): TextInputSuggestion[] {
  return [{value: SKILL_CHOICES.addSkill, description: 'describe a new skill for haze to generate', kind: 'skill' as const},
    ...skills.map(skill => ({
      value: skills.some(candidate => candidate !== skill && candidate.name === skill.name) ? skillPickerValue(skill) : skill.name,
      description: `${skill.description} · ${skill.source}${isSkillEnabled(settings, skill.name, skill.source) ? '' : ' · disabled'}`,
      kind: 'skill' as const,
    }))];
}

export function skillScopeSuggestions(): TextInputSuggestion[] {
  return [
    {value: 'this project', description: 'create .haze/skills/<name>/SKILL.md for this repository', kind: 'skill' as const},
    {value: 'global', description: 'create ~/.haze/skills/<name>/SKILL.md for your user', kind: 'skill' as const},
  ];
}

export function skillsActionSuggestions(settings: HazeSettings, skills: LoadedSkill[], selectedSkillName: string | undefined): TextInputSuggestion[] {
  const skill = findSelectedSkill(skills, selectedSkillName);
  const result: TextInputSuggestion[] = [];
  if (skill) {
    const enabled = isSkillEnabled(settings, skill.name, skill.source);
    result.push({value: enabled ? COMMON_ACTIONS.disable : COMMON_ACTIONS.enable, description: `${enabled ? COMMON_ACTIONS.disable : COMMON_ACTIONS.enable} this skill`, kind: 'skill' as const});
    result.push({value: SKILL_ACTIONS.showInfo, description: 'show description, references, and path', kind: 'skill' as const});
    result.push({value: SKILL_ACTIONS.validate, description: 're-load and validate SKILL.md', kind: 'skill' as const});
  }
  result.push({value: SKILL_ACTIONS.removeSkill, description: 'delete this skill directory', kind: 'skill' as const});
  return result;
}

/** Perceptual-luminance check on a `#rrggbb` background so the theme picker can label light vs dark palettes. */
function isLightBackground(hex: string): boolean {
  const channels = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!channels) return false;
  const [, r = '0', g = '0', b = '0'] = channels;
  return (0.2126 * parseInt(r, 16) + 0.7152 * parseInt(g, 16) + 0.0722 * parseInt(b, 16)) / 255 > 0.5;
}

/** Every built-in theme with its palette brightness and the active one marked (`resolveTheme` validates names). */
export function themeSuggestions(settings: HazeSettings): TextInputSuggestion[] {
  const active = settings.theme ?? DEFAULT_THEME_NAME;
  return Object.keys(BUILT_IN_THEME_SPECS).map(name => ({
    value: name,
    description: `${isLightBackground(resolveTheme(name).background) ? 'light' : 'dark'} palette${name === active ? ' · active' : ''}`,
    kind: 'theme' as const,
  }));
}

// ── The step table ──────────────────────────────────────────────────────────

type WizardStepKind = 'pick' | 'input' | 'masked-input' | 'confirm';

/** Inputs available to a step's suggestion builder (mirrors the picker state). */
export interface WizardSuggestionState {
  settings: HazeSettings;
  skills: LoadedSkill[];
  sessions?: SessionSummary[];
  selectedProviderName?: string;
  modelProviderFilter?: string;
  providerDraftName?: string;
  discoveredModels?: string[];
  suggestedModels?: string[];
  selectedSkillName?: string;
  selectedLspName?: string;
  selectedMcpName?: string;
}

/**
 * One wizard step. `kind` drives the input behavior classification that
 * `chatModes.ts` derives (`pick` → always-on suggestion picker, `masked-input`
 * → masked input, `optional` → empty submit allowed, `confirm` → typed
 * "yes" confirmation). Placeholders must stay user-stable.
 */
export interface WizardStepDef {
  id: string;
  kind: WizardStepKind;
  placeholder: string;
  /** Empty submission is valid (optional steps such as API keys). */
  optional?: boolean;
  suggestions: (state: WizardSuggestionState) => TextInputSuggestion[];
}

export const WIZARD_STEPS = [
  // Sessions
  {id: 'sessions', kind: 'pick', placeholder: 'Choose a saved session', suggestions: (s: WizardSuggestionState) => sessionSuggestions(s.sessions ?? [])},
  {id: 'sessionAction', kind: 'pick', placeholder: 'Resume or fork this session', suggestions: () => sessionActionSuggestions()},
  // Provider + model flows
  {id: 'provider', kind: 'pick', placeholder: 'Choose provider', suggestions: (s: WizardSuggestionState) => providerSuggestions(s.settings)},
  {id: 'providerAction', kind: 'pick', placeholder: 'Choose provider action', suggestions: (s: WizardSuggestionState) => providerActionSuggestions(s.settings, s.selectedProviderName)},
  {id: 'providerAddPreset', kind: 'pick', placeholder: 'Choose a provider preset or custom', suggestions: () => presetSuggestions()},
  {id: 'providerAddName', kind: 'input', placeholder: 'Provider name', suggestions: () => []},
  {id: 'providerAddUrl', kind: 'input', placeholder: 'https://example.com/v1', suggestions: () => []},
  {id: 'providerAddKey', kind: 'masked-input', placeholder: 'API key, or blank for local', optional: true, suggestions: () => []},
  {id: 'providerAddModels', kind: 'input', placeholder: 'model-a, model-b', suggestions: () => []},
  {id: 'providerAppendModels', kind: 'input', placeholder: 'model-a, model-b', suggestions: () => []},
  {id: 'providerSetKey', kind: 'masked-input', placeholder: 'API key', suggestions: () => []},
  {id: 'providerRemoveModels', kind: 'input', placeholder: 'model-a, model-b', suggestions: () => []},
  {id: 'providerConfirmRemove', kind: 'confirm', placeholder: 'Type "yes" to confirm', suggestions: () => []},
  {id: 'model', kind: 'pick', placeholder: 'Choose model, or add model', suggestions: (s: WizardSuggestionState) => modelSuggestions(s.settings, s.modelProviderFilter)},
  {id: 'modelAddProvider', kind: 'pick', placeholder: 'Choose a provider to add models to', suggestions: (s: WizardSuggestionState) => modelAddProviderSuggestions(s.settings)},
  {id: 'modelPick', kind: 'pick', placeholder: 'Choose a model to add', suggestions: (s: WizardSuggestionState) => modelPickSuggestions(s.settings, s.selectedProviderName ?? s.providerDraftName, s.discoveredModels ?? [], s.suggestedModels ?? [])},
  // Skills
  {id: 'skills', kind: 'pick', placeholder: 'Choose a skill or add skill', suggestions: (s: WizardSuggestionState) => skillsSuggestions(s.settings, s.skills)},
  {id: 'skillsAction', kind: 'pick', placeholder: 'show info, enable, disable, validate, or remove', suggestions: (s: WizardSuggestionState) => skillsActionSuggestions(s.settings, s.skills, s.selectedSkillName)},
  {id: 'skillsAddName', kind: 'input', placeholder: 'Skill name (kebab-case, e.g. security-review)', suggestions: () => []},
  {id: 'skillsAddScope', kind: 'pick', placeholder: 'Choose this project or global', suggestions: () => skillScopeSuggestions()},
  {id: 'skillsAddDescription', kind: 'input', placeholder: 'Describe what the skill should do', suggestions: () => []},
  {id: 'skillsConfirmRemove', kind: 'confirm', placeholder: 'Type "yes" to confirm', suggestions: () => []},
  // LSP servers
  {id: 'lsp', kind: 'pick', placeholder: 'Choose LSP server or add server', suggestions: (s: WizardSuggestionState) => lspSuggestions(s.settings)},
  {id: 'lspAction', kind: 'pick', placeholder: 'enable, disable, or remove server', suggestions: (s: WizardSuggestionState) => lspActionSuggestions(s.settings, s.selectedLspName)},
  {id: 'lspAddPreset', kind: 'pick', placeholder: 'Choose an LSP preset or custom', suggestions: () => lspPresetSuggestions()},
  {id: 'lspAddName', kind: 'input', placeholder: 'LSP server name (e.g. typescript)', suggestions: () => []},
  {id: 'lspAddCommand', kind: 'input', placeholder: 'Command (e.g. typescript-language-server --stdio)', suggestions: () => []},
  {id: 'lspConfirmRemove', kind: 'confirm', placeholder: 'Type "yes" to confirm', suggestions: () => []},
  // MCP servers
  {id: 'mcp', kind: 'pick', placeholder: 'Choose MCP server or add server', suggestions: (s: WizardSuggestionState) => mcpSuggestions(s.settings)},
  {id: 'mcpAction', kind: 'pick', placeholder: 'enable, disable, remove, or set key', suggestions: (s: WizardSuggestionState) => mcpActionSuggestions(s.settings, s.selectedMcpName)},
  {id: 'mcpAddPreset', kind: 'pick', placeholder: 'Choose an MCP preset or custom', suggestions: () => mcpPresetSuggestions()},
  {id: 'mcpAddName', kind: 'input', placeholder: 'MCP server name (e.g. context7)', suggestions: () => []},
  {id: 'mcpAddTransport', kind: 'pick', placeholder: 'http, sse, or stdio', suggestions: () => mcpTransportSuggestions()},
  {id: 'mcpAddUrl', kind: 'input', placeholder: 'https://mcp.example.com/mcp', suggestions: () => []},
  {id: 'mcpAddCommand', kind: 'input', placeholder: 'Command (e.g. npx -y @pkg/server)', suggestions: () => []},
  {id: 'mcpAddKey', kind: 'masked-input', placeholder: 'API key, or blank to skip', optional: true, suggestions: () => []},
  {id: 'mcpSetKey', kind: 'masked-input', placeholder: 'API key', suggestions: () => []},
  {id: 'mcpConfirmRemove', kind: 'confirm', placeholder: 'Type "yes" to confirm', suggestions: () => []},
  // Themes
  {id: 'themes', kind: 'pick', placeholder: 'Choose a theme', suggestions: (s: WizardSuggestionState) => themeSuggestions(s.settings)},
] as const satisfies readonly WizardStepDef[];

export type WizardStepId = (typeof WIZARD_STEPS)[number]['id'];

const WIZARD_STEP_BY_ID: Record<WizardStepId, WizardStepDef> = Object.fromEntries(
  WIZARD_STEPS.map(step => [step.id, step]),
) as Record<WizardStepId, WizardStepDef>;

/** Suggestions for a wizard mode, or undefined when the mode is not a wizard step ('chat'). */
export function wizardSuggestionsFor(mode: string, state: WizardSuggestionState): TextInputSuggestion[] | undefined {
  const step = (WIZARD_STEP_BY_ID as Record<string, WizardStepDef | undefined>)[mode];
  return step ? step.suggestions(state) : undefined;
}
