import type {HazeSettings} from '../../config/settings.js';
import {removeSkillSetting} from '../../config/skillSettings.js';
import type {LoadedSkill} from '../../skills/types.js';
import {isYesConfirmation} from './wizardInput.js';
import {findSelectedSkill} from './skillWizard.js';

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