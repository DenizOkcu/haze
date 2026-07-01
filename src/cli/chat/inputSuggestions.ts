import type {HazeSettings} from '../../config/settings.js';
import {isSkillEnabled} from '../../config/skillSettings.js';
import type {LoadedSkill} from '../../skills/types.js';
import type {TextInputSuggestion} from '../../ui/components/TextInput.js';
import type {Mode} from '../commands/chatModes.js';
import {providerSuggestions, providerActionSuggestions, presetSuggestions, modelSuggestions, lspSuggestions, lspActionSuggestions, lspPresetSuggestions, mcpSuggestions, mcpActionSuggestions, mcpPresetSuggestions, mcpTransportSuggestions, skillsSuggestions, skillsActionSuggestions} from '../commands/wizardSuggestions.js';

const CHAT_COMMAND_SUGGESTIONS: TextInputSuggestion[] = [
  {value: '/help', description: 'Show commands', kind: 'command'},
  {value: '/provider', description: 'Choose a provider', kind: 'command'},
  {value: '/model', description: 'Choose a model', kind: 'command'},
  {value: '/lsp', description: 'Manage LSP servers (semantic navigation)', kind: 'command'},
  {value: '/mcp', description: 'Manage MCP servers (Context7, etc.)', kind: 'command'},
  {value: '/settings', description: 'Show provider, model, API key, and context status', kind: 'command'},
  {value: '/context', description: 'Show token breakdown of system, tools, MCP, and messages', kind: 'command'},
  {value: '/skills', description: 'Manage Markdown skills (add, enable/disable, validate, remove)', kind: 'command'},
  {value: '/plan', description: 'Toggle plan mode (plan without implementing; Shift+Tab)', kind: 'command'},
  {value: '/init', description: 'Create or update AGENTS.md project instructions', kind: 'command'},
  {value: '/session', description: 'Show current session path', kind: 'command'},
  {value: '/resume', description: 'Resume latest session for this workspace', kind: 'command'},
  {value: '/new', description: 'Start a new session', kind: 'command'},
  {value: '/compact ', description: 'Summarize older context and keep recent messages', kind: 'command'},
  {value: '/clear', description: 'Clear conversation history', kind: 'command'},
  {value: '/exit', description: 'Exit Haze', kind: 'command'},
  {value: '/quit', description: 'Exit Haze', kind: 'command'},
];

interface InputSuggestionState {
  mode: Mode;
  settings: HazeSettings;
  skills: LoadedSkill[];
  selectedProviderName?: string;
  modelProviderFilter?: string;
  selectedSkillName?: string;
  selectedLspName?: string;
  selectedMcpName?: string;
}

export function inputSuggestionsForState(state: InputSuggestionState): TextInputSuggestion[] {
  const {mode, settings, skills} = state;
  if (mode === 'provider') return providerSuggestions(settings);
  if (mode === 'providerAction') return providerActionSuggestions(settings, state.selectedProviderName);
  if (mode === 'providerAddPreset') return presetSuggestions();
  if (mode === 'model') return modelSuggestions(settings, state.modelProviderFilter);
  if (mode === 'skills') return skillsSuggestions(settings, skills);
  if (mode === 'skillsAction') return skillsActionSuggestions(settings, skills, state.selectedSkillName);
  if (mode === 'lsp') return lspSuggestions(settings);
  if (mode === 'lspAction') return lspActionSuggestions(settings, state.selectedLspName);
  if (mode === 'lspAddPreset') return lspPresetSuggestions();
  if (mode === 'mcp') return mcpSuggestions(settings);
  if (mode === 'mcpAction') return mcpActionSuggestions(settings, state.selectedMcpName);
  if (mode === 'mcpAddPreset') return mcpPresetSuggestions();
  if (mode === 'mcpAddTransport') return mcpTransportSuggestions();
  if (mode !== 'chat') return [];
  return [
    ...CHAT_COMMAND_SUGGESTIONS,
    ...skills.filter(skill => isSkillEnabled(settings, skill.name)).map(skill => ({value: `/${skill.name}`, description: skill.description, kind: 'skill' as const})),
  ];
}
