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

export function selectSkillResult(skills: LoadedSkill[], name: string): SkillWizardResult {
  if (name === SKILL_CHOICES.addSkill) return {mode: 'skillsAddName', clearDraft: true, message: 'Name the skill (kebab-case, e.g. security-review). ESC cancels.'};
  const skill = skills.find(candidate => candidate.name === name);
  if (!skill) return {mode: 'chat', message: `No skill named ${name}. Use /skills and choose add skill.`};
  return {mode: 'skillsAction', selectedName: skill.name, message: `${skill.name}: choose an action.`};
}

export function skillInfoMessage(settings: HazeSettings, skill: LoadedSkill): string {
  return [
    `${skill.name}`,
    skill.description,
    '',
    `References: ${skill.references.length}`,
    `Path: ${skill.dir}`,
    `State: ${isSkillEnabled(settings, skill.name) ? 'enabled' : 'disabled'}`,
  ].join('\n');
}

export function selectSkillActionResult(settings: HazeSettings, skills: LoadedSkill[], selectedName: string | undefined, action: string): SkillWizardResult & {skill?: LoadedSkill; validate?: boolean} {
  if (!selectedName) return {mode: 'skills'};
  const skill = skills.find(candidate => candidate.name === selectedName);
  if (!skill) return {mode: 'chat', selectedName: undefined, message: `Skill ${selectedName} not found.`};
  if (action === COMMON_ACTIONS.enable || action === COMMON_ACTIONS.disable) {
    const enabled = action === COMMON_ACTIONS.enable;
    return {mode: 'chat', selectedName: undefined, settingsPatch: {skills: setSkillEnabled(settings, selectedName, enabled)}, message: `Skill ${selectedName} ${enabled ? 'enabled' : 'disabled'}.`, skill};
  }
  if (action === SKILL_ACTIONS.showInfo) return {message: skillInfoMessage(settings, skill), skill};
  if (action === SKILL_ACTIONS.validate) return {validate: true, skill};
  if (action === SKILL_ACTIONS.removeSkill) return {mode: 'skillsConfirmRemove', message: `Remove skill ${selectedName}? This deletes ~/.haze/skills/${selectedName}. Type "yes" to confirm. Esc to cancel.`, skill};
  return {message: `Unknown skill action: ${action}`, skill};
}
