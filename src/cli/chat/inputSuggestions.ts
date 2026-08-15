import {isSkillEnabled} from '../../config/skillSettings.js';
import type {TextInputSuggestion} from '../../ui/components/TextInput.js';
import {wizardSuggestionsFor, type WizardSuggestionState} from '../commands/wizardFlow.js';
import type {Mode} from '../commands/chatModes.js';

const CHAT_COMMAND_SUGGESTIONS: TextInputSuggestion[] = [
  {value: '/help', description: 'Show commands', kind: 'command'},
  {value: '/provider', description: 'Choose a provider', kind: 'command'},
  {value: '/model', description: 'Choose a model', kind: 'command'},
  {value: '/lsp', description: 'Manage LSP servers (semantic navigation)', kind: 'command'},
  {value: '/mcp', description: 'Manage MCP servers (Context7, etc.)', kind: 'command'},
  {value: '/settings', description: 'Show provider, model, API key, and context status', kind: 'command'},
  {value: '/context', description: 'Show token breakdown of system, tools, MCP, and messages', kind: 'command'},
  {value: '/skills', description: 'Manage Markdown skills (add, enable/disable, validate, remove)', kind: 'command'},
  {value: '/fleet ', description: 'Parallelize independent work in disposable contexts (flags: --review/--profile/--workers/--concurrency)', kind: 'command'},
  {value: '/init', description: 'Create or update AGENTS.md project instructions', kind: 'command'},
  {value: '/session', description: 'Show current session path', kind: 'command'},
  {value: '/resume', description: 'Browse saved sessions for this workspace', kind: 'command'},
  {value: '/new', description: 'Start a new session', kind: 'command'},
  {value: '/compact ', description: 'Summarize older context and keep recent messages', kind: 'command'},
  {value: '/clear', description: 'Clear conversation history', kind: 'command'},
  {value: '/exit', description: 'Exit haze', kind: 'command'},
  {value: '/quit', description: 'Exit haze', kind: 'command'},
];

/** Inputs for suggestion building: the wizard picker state plus the current input mode. */
export interface InputSuggestionState extends WizardSuggestionState {
  mode: Mode;
}

/**
 * Suggestions for the current input mode. Wizard/picker modes delegate to the
 * step's suggestion builder from the flow table; chat mode shows slash
 * commands plus enabled skill invocations.
 */
export function inputSuggestionsForState(state: InputSuggestionState): TextInputSuggestion[] {
  if (state.mode !== 'chat') return wizardSuggestionsFor(state.mode, state) ?? [];
  const {settings, skills} = state;
  const activeSkills = skills.filter((skill, index) => isSkillEnabled(settings, skill.name, skill.source)
    && !skills.slice(0, index).some(candidate => candidate.name === skill.name && isSkillEnabled(settings, candidate.name, candidate.source)));
  return [
    ...CHAT_COMMAND_SUGGESTIONS,
    ...activeSkills.map(skill => ({value: `/${skill.name}`, description: `${skill.description} · ${skill.source}`, kind: 'skill' as const})),
  ];
}
