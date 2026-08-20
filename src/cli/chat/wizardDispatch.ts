import type {HazeMcpServer, HazeProviderSettings} from '../../config/settings.js';
import {updateSettings} from '../../config/settings.js';
import type {Mode} from '../commands/chatModes.js';
import type {WizardDispatchDeps, WizardHandler, WizardSetterContext} from './wizard/types.js';
import {transitionMcpField, transitionProviderField, type McpWizardEffect, type ProviderWizardEffect} from './wizard/fieldTransitions.js';
import {createProviderWizardHandlers} from './wizard/providerHandlers.js';
import {createSkillsWizardHandlers} from './wizard/skillsHandlers.js';
import {createLspWizardHandlers} from './wizard/lspHandlers.js';
import {createMcpWizardHandlers} from './wizard/mcpHandlers.js';
import {createSessionThemeHandlers} from './wizard/sessionThemeHandlers.js';

export type {WizardDispatchDeps} from './wizard/types.js';
export {initialWizardUiState, wizardUiReducer, type WizardUiAction, type WizardUiState} from './wizard/uiState.js';
export {transitionMcpField, transitionProviderField, type McpWizardEffect, type ProviderWizardEffect} from './wizard/fieldTransitions.js';

/**
 * Wizard submit engine (CR-006): one table-driven entry point for every
 * picker/wizard mode. The mode-specific handler families live in
 * `wizard/` (provider/model, skills, LSP, MCP, session/theme); each calls the
 * pure `*Wizard.ts` result functions and applies the shared
 * settingsPatch/mode/message shape, while field-capture steps run through the
 * pure transition functions in `wizard/fieldTransitions.ts`, so `chat.tsx`
 * stays orchestration glue instead of a 150-line if-chain.
 */

export interface WizardDispatch {
  /** Handle the value for wizard/picker modes; returns false for non-wizard modes. */
  dispatch: (mode: Mode, value: string) => Promise<boolean>;
  /** Exposed for the MCP field-transition path in submit(). */
  finishMcpCustom: (keyValue?: string, draft?: Partial<HazeMcpServer>) => Promise<void>;
  /** Exposed for the provider field-transition path: discover models for a provider draft after its key step. */
  discoverProviderModelsForDraft: (draft: Partial<HazeProviderSettings>) => Promise<void>;
}

export function createWizardDispatch(deps: WizardDispatchDeps): WizardDispatch {
  const {setMode, setSettings, showMessage} = deps;

  // Setter shims over the single wizard-state reducer, so the handler bodies
  // keep the historical per-field setter vocabulary (minimal diff; the
  // dispatch tests mirror React state through updateWizard).
  const ctx: WizardSetterContext = {
    setMode,
    showMessage,
    applySettings: async patch => {
      const next = await updateSettings(patch);
      setSettings(next);
      return next;
    },
    setSelectedSessionId: id => deps.updateWizard({type: 'set', key: 'selectedSessionId', value: id}),
    setModelProviderFilter: value => deps.updateWizard({type: 'set', key: 'modelProviderFilter', value}),
    setSelectedProviderName: value => deps.updateWizard({type: 'set', key: 'selectedProviderName', value}),
    setProviderDraft: value => deps.updateWizard({type: 'providerDraft', value}),
    setSkillDraft: value => deps.updateWizard({type: 'skillDraft', value}),
    setSelectedSkillName: value => deps.updateWizard({type: 'set', key: 'selectedSkillName', value}),
    setSelectedLspName: value => deps.updateWizard({type: 'set', key: 'selectedLspName', value}),
    setLspDraft: value => deps.updateWizard({type: 'lspDraft', value}),
    setSelectedMcpName: value => deps.updateWizard({type: 'set', key: 'selectedMcpName', value}),
    setMcpDraft: value => deps.updateWizard({type: 'mcpDraft', value}),
    setDiscoveredModels: value => deps.updateWizard({type: 'discoveredModels', value}),
    setSuggestedModels: value => deps.updateWizard({type: 'suggestedModels', value}),
  };

  const provider = createProviderWizardHandlers(deps, ctx);
  const mcp = createMcpWizardHandlers(deps, ctx);
  const handlers: Partial<Record<Mode, WizardHandler>> = {
    ...createSessionThemeHandlers(deps, ctx),
    ...createSkillsWizardHandlers(deps, ctx),
    ...provider.handlers,
    ...createLspWizardHandlers(deps, ctx),
    ...mcp.handlers,
  };

  /** Apply one field-transition effect at the submit boundary (was chat.tsx inline branching). */
  async function applyProviderEffect(effect: ProviderWizardEffect) {
    if (effect.type === 'message') showMessage(effect.text);
    else if (effect.type === 'mode') setMode(effect.mode);
    else if (effect.type === 'provider-draft') {
      if (effect.replace) ctx.setProviderDraft(effect.patch);
      else ctx.setProviderDraft({...deps.wizard.providerDraft, ...effect.patch});
    } else if (effect.type === 'discover-provider-models') {
      // The draft patch above is still pending React state, so discovery
      // receives the merged draft explicitly (same pattern as MCP stdio).
      await provider.discoverProviderModelsForDraft(effect.draft);
    }
  }

  async function applyMcpEffect(effect: McpWizardEffect) {
    if (effect.type === 'message') showMessage(effect.text);
    else if (effect.type === 'mode') setMode(effect.mode);
    else if (effect.type === 'mcp-draft') ctx.setMcpDraft({...deps.wizard.mcpDraft, ...effect.patch});
    else if (effect.type === 'finish-mcp-stdio') await mcp.finishMcpCustom(undefined, effect.draft);
  }

  return {
    async dispatch(mode, value) {
      // Field-capture steps first (same order chat.tsx used), then the submit table.
      const providerEffects = transitionProviderField({mode, value, settings: deps.settings, draft: deps.wizard.providerDraft});
      if (providerEffects) {
        for (const effect of providerEffects) await applyProviderEffect(effect);
        return true;
      }
      const mcpEffects = transitionMcpField({mode, value, settings: deps.settings, draft: deps.wizard.mcpDraft});
      if (mcpEffects) {
        for (const effect of mcpEffects) await applyMcpEffect(effect);
        return true;
      }
      const handler = handlers[mode];
      if (!handler) return false;
      await handler(value);
      return true;
    },
    finishMcpCustom: mcp.finishMcpCustom,
    discoverProviderModelsForDraft: provider.discoverProviderModelsForDraft,
  };
}
