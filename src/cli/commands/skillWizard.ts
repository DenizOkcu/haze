import type {HazeSettings} from '../../config/settings.js';
import {isSkillEnabled, setSkillEnabled} from '../../config/skillSettings.js';
import type {LoadedSkill} from '../../skills/types.js';
import {COMMON_ACTIONS, SKILL_ACTIONS, SKILL_CHOICES} from './wizardActions.js';

export type SkillWizardResult = {
  message?: string;
  mode?: 'chat' | 'skills' | 'skillsAction' | 'skillsAddName' | 'skillsConfirmRemove';
  selectedName?: string;
  settingsPatch?: Partial<HazeSettings>;
  clearDraft?: boolean;
};

export function skillPickerValue(skill: LoadedSkill) {
  return `${skill.name} · ${skill.source}`;
}

export function findSelectedSkill(skills: LoadedSkill[], selection: string | undefined) {
  if (!selection) return undefined;
  return skills.find(skill => skillPickerValue(skill) === selection)
    ?? skills.find(skill => skill.name === selection);
}

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
