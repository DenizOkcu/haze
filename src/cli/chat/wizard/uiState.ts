import type {HazeMcpServer, HazeProviderSettings} from '../../../config/settings.js';
import type {HazeLspServer} from '../../../config/lspSettings.js';
import type {SkillSource} from '../../../skills/types.js';

/**
 * Wizard flow UI state: one reducer for selection, drafts, and model
 * discovery. The wizard-related React state that used to live in twelve
 * `useState` hooks in `chat.tsx`. Flat field names match the historical deps
 * names so the dispatch body and its tests read the same way.
 */
export interface WizardUiState {
  selectedSessionId?: string;
  modelProviderFilter?: string;
  discoveredModels: string[];
  suggestedModels: string[];
  selectedProviderName?: string;
  providerDraft: Partial<HazeProviderSettings>;
  skillDraft: {name?: string; scope?: SkillSource};
  selectedSkillName?: string;
  selectedLspName?: string;
  lspDraft: Partial<HazeLspServer>;
  selectedMcpName?: string;
  mcpDraft: Partial<HazeMcpServer>;
}

export type WizardUiAction =
  | {type: 'set'; key: 'selectedSessionId' | 'modelProviderFilter' | 'selectedProviderName' | 'selectedSkillName' | 'selectedLspName' | 'selectedMcpName'; value: string | undefined}
  | {type: 'providerDraft'; value: Partial<HazeProviderSettings>}
  | {type: 'skillDraft'; value: {name?: string; scope?: SkillSource}}
  | {type: 'lspDraft'; value: Partial<HazeLspServer>}
  | {type: 'mcpDraft'; value: Partial<HazeMcpServer>}
  | {type: 'discoveredModels'; value: string[]}
  | {type: 'suggestedModels'; value: string[]}
  | {type: 'reset'};

export function initialWizardUiState(): WizardUiState {
  return {discoveredModels: [], suggestedModels: [], providerDraft: {}, skillDraft: {}, lspDraft: {}, mcpDraft: {}};
}

export function wizardUiReducer(state: WizardUiState, action: WizardUiAction): WizardUiState {
  switch (action.type) {
    case 'set': return {...state, [action.key]: action.value};
    case 'providerDraft': return {...state, providerDraft: action.value};
    case 'skillDraft': return {...state, skillDraft: action.value};
    case 'lspDraft': return {...state, lspDraft: action.value};
    case 'mcpDraft': return {...state, mcpDraft: action.value};
    case 'discoveredModels': return {...state, discoveredModels: action.value};
    case 'suggestedModels': return {...state, suggestedModels: action.value};
    case 'reset': return initialWizardUiState();
  }
}
