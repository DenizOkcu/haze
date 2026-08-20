import fs from 'fs-extra';
import {loadSkillRegistry} from '../../../skills/SkillRegistry.js';
import {createSkill, toSkillDirName} from '../../../skills/builder/SkillBuilder.js';
import type {SkillSource} from '../../../skills/types.js';
import type {Mode} from '../../commands/chatModes.js';
import {selectSkillActionResult, selectSkillResult, captureSkillDescription as captureSkillDescriptionResult, skillCreationFailure, skillCreationMessage, skillConfirmRemoveResult as skillConfirmRemove} from '../../commands/skillsWizard.js';
import type {WizardDispatchDeps, WizardHandler, WizardSetterContext} from './types.js';

/** Skills wizard handlers: picker, actions, the three-step creation flow, and confirm-remove. */
export function createSkillsWizardHandlers(deps: WizardDispatchDeps, ctx: WizardSetterContext): Partial<Record<Mode, WizardHandler>> {
  const {setMode, showMessage} = ctx;
  const setSkillDraft = ctx.setSkillDraft;
  const setSelectedSkillName = ctx.setSelectedSkillName;

  async function selectSkill(name: string) {
    const result = selectSkillResult(deps.skills, name);
    if (result.clearDraft) setSkillDraft({});
    if ('selectedName' in result) setSelectedSkillName(result.selectedName);
    if (result.mode) setMode(result.mode);
    showMessage(result.message);
  }

  async function selectSkillAction(action: string) {
    const result = selectSkillActionResult(deps.settings, deps.skills, deps.wizard.selectedSkillName, action);
    if (result.settingsPatch) await ctx.applySettings(result.settingsPatch);
    if ('selectedName' in result) setSelectedSkillName(result.selectedName);
    if (result.mode) setMode(result.mode);
    if (result.validate && result.skill) {
      const {loadSkill} = await import('../../../skills/SkillLoader.js');
      try {
        const loaded = await loadSkill(result.skill.dir, result.skill.source);
        showMessage(loaded ? `Valid: ${loaded.name}` : 'No SKILL.md found');
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        showMessage(`Invalid skill: ${text}`);
      }
      return;
    }
    showMessage(result.message);
  }

  async function captureSkillName(value: string) {
    const dirName = toSkillDirName(value);
    if (!dirName) {
      showMessage('Skill name must contain at least one letter or number. Try again, or press ESC to cancel.');
      return;
    }
    setSkillDraft({...deps.wizard.skillDraft, name: dirName});
    setMode('skillsAddScope');
    showMessage(`Where should "${dirName}" be created? Choose this project or global explicitly.`);
  }

  async function captureSkillScope(value: string) {
    const scope: SkillSource | undefined = value.trim().toLowerCase() === 'this project' ? 'project'
      : value.trim().toLowerCase() === 'global' ? 'global' : undefined;
    if (!scope) {
      showMessage('Choose "this project" or "global".');
      return;
    }
    const name = deps.wizard.skillDraft.name;
    if (!name) {
      setSkillDraft({});
      setMode('chat');
      showMessage('Skill wizard lost the name. Start over with /skills.');
      return;
    }
    const registry = await loadSkillRegistry();
    if ((registry.candidates ?? [...registry.skills.values()]).some(skill => skill.name === name && skill.source === scope)) {
      showMessage(`A ${scope} skill named "${name}" already exists. Choose another scope or press ESC to cancel.`);
      return;
    }
    setSkillDraft({...deps.wizard.skillDraft, scope});
    setMode('skillsAddDescription');
    showMessage(`Describe what "${name}" should do. This is the work the LLM will expand into the skill body.`);
  }

  async function captureSkillDescription(value: string) {
    const result = captureSkillDescriptionResult(value, deps.wizard.skillDraft.name);
    if (result.message) showMessage(result.message);
    if (result.mode === 'chat') setMode('chat');
    if (result.clearDraft) setSkillDraft({});
    if (result.description && result.draftName) {
      const name = result.draftName;
      const description = result.description;
      deps.setBusyLabel(result.busyLabel ?? 'Creating skill');
      deps.setBusy(true);
      try {
        const created = await createSkill({name, description, scope: deps.wizard.skillDraft.scope ?? 'global'});
        showMessage(skillCreationMessage(created.name, created.file));
        await deps.refreshSkills();
      } catch (error) {
        showMessage(skillCreationFailure(error));
      } finally {
        deps.setBusy(false);
        deps.setBusyLabel(deps.idleBusyLabel);
      }
    }
  }

  async function skillsConfirmRemoveMode(value: string) {
    const result = skillConfirmRemove(deps.settings, deps.skills, deps.wizard.selectedSkillName, value);
    if (result.message) showMessage(result.message);
    if (result.selectedName === undefined) setSelectedSkillName(undefined);
    if (result.mode === 'chat') setMode('chat');
    if (result.removedDir) await fs.remove(result.removedDir);
    if (result.settingsPatch) await ctx.applySettings(result.settingsPatch);
    if (result.removedDir) await deps.refreshSkills();
  }

  return {
    skills: selectSkill,
    skillsAction: selectSkillAction,
    skillsAddName: captureSkillName,
    skillsAddScope: captureSkillScope,
    skillsAddDescription: captureSkillDescription,
    skillsConfirmRemove: skillsConfirmRemoveMode,
  };
}
