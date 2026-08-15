import type {HazeSettings} from '../../config/settings.js';
import {isSkillEnabled, removeSkillSetting, setSkillEnabled} from '../../config/skillSettings.js';
import type {LoadedSkill} from '../../skills/types.js';
import {COMMON_ACTIONS, SKILL_ACTIONS, SKILL_CHOICES, findSelectedSkill, isYesConfirmation, skillPickerValue} from './wizardFlow.js';

/**
 * Pure result functions for the skills wizard flow: selection, actions,
 * creation-from-description, and confirm-remove. Steps live in
 * `wizardFlow.ts`; submit orchestration in `chat/wizardDispatch.ts`.
 */

export type SkillWizardResult = {
  message?: string;
  mode?: 'chat' | 'skills' | 'skillsAction' | 'skillsAddName' | 'skillsConfirmRemove';
  selectedName?: string;
  settingsPatch?: Partial<HazeSettings>;
  clearDraft?: boolean;
};

export function selectSkillResult(skills: LoadedSkill[], name: string): SkillWizardResult {
  if (name === SKILL_CHOICES.addSkill) return {mode: 'skillsAddName', clearDraft: true, message: 'Name the skill (kebab-case, e.g. security-review). ESC cancels.'};
  const skill = findSelectedSkill(skills, name);
  if (!skill) return {mode: 'chat', message: `No skill named ${name}. Use /skills and choose add skill.`};
  return {mode: 'skillsAction', selectedName: name === skill.name ? skill.name : skillPickerValue(skill), message: `${skill.name} · ${skill.source}: choose an action.`};
}

export function skillInfoMessage(settings: HazeSettings, skill: LoadedSkill): string {
  return [
    `${skill.name}`,
    skill.description,
    '',
    `Source: ${skill.source}`,
    `References: ${skill.references.length}`,
    `Path: ${skill.dir}`,
    `State: ${isSkillEnabled(settings, skill.name, skill.source) ? 'enabled' : 'disabled'}`,
  ].join('\n');
}

export function selectSkillActionResult(settings: HazeSettings, skills: LoadedSkill[], selectedName: string | undefined, action: string): SkillWizardResult & {skill?: LoadedSkill; validate?: boolean} {
  if (!selectedName) return {mode: 'skills'};
  const skill = findSelectedSkill(skills, selectedName);
  if (!skill) return {mode: 'chat', selectedName: undefined, message: `Skill ${selectedName} not found.`};
  if (action === COMMON_ACTIONS.enable || action === COMMON_ACTIONS.disable) {
    const enabled = action === COMMON_ACTIONS.enable;
    return {mode: 'chat', selectedName: undefined, settingsPatch: {skills: setSkillEnabled(settings, skill.name, enabled, skill.source)}, message: `Skill ${skill.name} (${skill.source}) ${enabled ? 'enabled' : 'disabled'}.`, skill};
  }
  if (action === SKILL_ACTIONS.showInfo) return {message: skillInfoMessage(settings, skill), skill};
  if (action === SKILL_ACTIONS.validate) return {validate: true, skill};
  if (action === SKILL_ACTIONS.removeSkill) return {mode: 'skillsConfirmRemove', message: `Remove ${skill.source} skill ${skill.name}? This deletes ${skill.dir}. Type "yes" to confirm. Esc to cancel.`, skill};
  return {message: `Unknown skill action: ${action}`, skill};
}

export type SkillCreationResult = {
  busy?: boolean;
  busyLabel?: string;
  message?: string;
  description?: string;
  draftName?: string;
  mode?: 'chat';
  clearDraft?: boolean;
};

export function captureSkillDescription(value: string, draftName: string | undefined): SkillCreationResult {
  const description = value.trim();
  if (!description) return {message: 'Description is required. Try again, or press ESC to cancel.'};
  if (!draftName) return {mode: 'chat', clearDraft: true, message: 'Skill wizard lost the name. Start over with /skills.'};
  return {description, draftName, busy: true, busyLabel: 'Creating skill'};
}

export function skillCreationMessage(name: string, file: string): string {
  return `Created skill ${name} at ${file}. Invoke it with /${name}. Edit SKILL.md to refine its workflow.`;
}

export function skillCreationFailure(error: unknown): string {
  return `Skill creation failed: ${error instanceof Error ? error.message : String(error)}`;
}
export type SkillConfirmRemoveResult = {
  message?: string;
  mode?: 'chat';
  settingsPatch?: Partial<HazeSettings>;
  removedDir?: string;
  selectedName?: string;
  skill?: LoadedSkill;
};

export function skillConfirmRemoveResult(settings: HazeSettings, skills: LoadedSkill[], selectedName: string | undefined, value: string): SkillConfirmRemoveResult {
  if (!selectedName) return {mode: 'chat'};
  if (!isYesConfirmation(value)) return {mode: 'chat', selectedName: undefined, message: 'Cancelled. Skill not removed.'};
  const skill = findSelectedSkill(skills, selectedName);
  if (!skill) return {mode: 'chat', selectedName: undefined, message: `Skill ${selectedName} not found.`};
  return {
    mode: 'chat',
    selectedName: undefined,
    skill,
    removedDir: skill.dir,
    settingsPatch: {skills: removeSkillSetting(settings, skill.name, skill.source)},
    message: skill.source === 'global' ? `Removed skill ${skill.name}.` : `Removed project skill ${skill.name}.`,
  };
}