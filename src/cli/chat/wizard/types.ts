import type {HazeMcpServer, HazeProviderSettings, HazeSettings} from '../../../config/settings.js';
import type {HazeLspServer} from '../../../config/lspSettings.js';
import type {LoadedSkill, SkillSource} from '../../../skills/types.js';
import type {SessionSummary} from '../../../core/session/sessionStore.js';
import type {Mode} from '../../commands/chatModes.js';
import {isYesConfirmation} from '../../commands/wizardFlow.js';
import type {WizardUiAction, WizardUiState} from './uiState.js';

/**
 * Shared types for the wizard submit engine (see wizardDispatch.ts for the
 * composition). Handler families live in sibling modules, one per flow.
 */

export interface WizardDispatchDeps {
  settings: HazeSettings;
  skills: LoadedSkill[];
  sessions?: SessionSummary[];
  /** Wizard flow UI state (selection, drafts, model discovery). */
  wizard: WizardUiState;
  updateWizard: (action: WizardUiAction) => void;
  setMode: (mode: Mode) => void;
  setSettings: (next: HazeSettings) => void;
  showMessage: (message: string | undefined) => void;
  resumeSessionById?: (id: string) => Promise<boolean>;
  forkSessionById?: (id: string) => Promise<boolean>;
  refreshSkills: () => Promise<unknown>;
  setBusyLabel: (label: string) => void;
  setBusy: (busy: boolean) => void;
  /** Busy label to restore when a skill creation finishes. */
  idleBusyLabel: string;
}

/** Setter shims over the single wizard-state reducer, shared by every handler family. */
export interface WizardSetterContext {
  setMode: (mode: Mode) => void;
  showMessage: (message: string | undefined) => void;
  /** Apply a settings patch through updateSettings, propagate the result, and return the persisted settings. */
  applySettings: (patch: HazeSettings) => Promise<HazeSettings>;
  setSelectedSessionId: (id: string | undefined) => void;
  setModelProviderFilter: (value: string | undefined) => void;
  setSelectedProviderName: (value: string | undefined) => void;
  setProviderDraft: (value: Partial<HazeProviderSettings>) => void;
  setSkillDraft: (value: {name?: string; scope?: SkillSource}) => void;
  setSelectedSkillName: (value: string | undefined) => void;
  setSelectedLspName: (value: string | undefined) => void;
  setLspDraft: (value: Partial<HazeLspServer>) => void;
  setSelectedMcpName: (value: string | undefined) => void;
  setMcpDraft: (value: Partial<HazeMcpServer>) => void;
  setDiscoveredModels: (value: string[]) => void;
  setSuggestedModels: (value: string[]) => void;
}

/** One mode's submit handler. */
export type WizardHandler = (value: string) => Promise<void>;

/**
 * Generic typed-"yes" confirm-remove step shared by the LSP and MCP flows.
 * Cancel and no-selection paths are identical; `remove` applies the domain
 * settings mutation and returns the success message.
 */
export function confirmRemoveStep(ctx: Pick<WizardSetterContext, 'setMode' | 'showMessage'>, input: {selectedName: () => string | undefined; cancelMessage: string; clearSelection: () => void; remove: (name: string) => Promise<string>}) {
  return async (value: string) => {
    const name = input.selectedName();
    if (!name) {
      ctx.setMode('chat');
      return;
    }
    if (!isYesConfirmation(value)) {
      ctx.showMessage(input.cancelMessage);
      input.clearSelection();
      ctx.setMode('chat');
      return;
    }
    ctx.showMessage(await input.remove(name));
    input.clearSelection();
    ctx.setMode('chat');
  };
}
