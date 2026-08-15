import {WIZARD_STEPS, type WizardStepDef, type WizardStepId} from './wizardFlow.js';

/**
 * Input-mode classification derived from the wizard flow table
 * (`wizardFlow.ts`): the `Mode` union, the picker/masked/empty-submit sets,
 * and per-mode placeholders all follow from the step definitions, so adding a
 * step updates every classification from its single table entry.
 */
export type Mode = 'chat' | WizardStepId;

/** Wizard steps viewed through their definition type, for uniform property access. */
const STEPS: readonly WizardStepDef[] = WIZARD_STEPS;

const stepIds = (steps: readonly WizardStepDef[]): Mode[] => steps.map(step => step.id as Mode);

/** Modes that show an always-on suggestion picker (server/preset lists). */
export const PICKER_MODES: ReadonlySet<Mode> = new Set(stepIds(STEPS.filter(step => step.kind === 'pick')));

/** Modes that mask input (secrets/API keys). */
export const MASKED_MODES: ReadonlySet<Mode> = new Set(stepIds(STEPS.filter(step => step.kind === 'masked-input')));

/** Modes where submitting an empty value is valid (optional steps). */
export const SUBMIT_EMPTY_MODES: ReadonlySet<Mode> = new Set(stepIds(STEPS.filter(step => step.optional)));

export function placeholderForMode(mode: Mode, busy: boolean): string {
  const step = WIZARD_STEPS.find(candidate => candidate.id === mode);
  return step?.placeholder ?? (busy ? 'Queue a follow-up, or Esc to interrupt' : 'Ask haze to help build your app');
}
