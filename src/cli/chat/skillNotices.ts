import {loadSkillRegistry} from '../../skills/SkillRegistry.js';
import type {LoadedSkill} from '../../skills/types.js';

/** Signatures of the skill notices already announced in this session. */
export type SkillNoticeState = {project: string; errors: string; notices: string};

export const initialSkillNoticeState = (): SkillNoticeState => ({project: '', errors: '', notices: ''});

/**
 * Pure diffing half of `refreshSkills`: loads the registry and returns the
 * candidate list, the next notice state, and the system messages that changed
 * since the previous state (each notice is announced once per signature).
 */
export async function loadSkillsWithNotices(previous: SkillNoticeState): Promise<{skills: LoadedSkill[]; state: SkillNoticeState; messages: string[]}> {
  const registry = await loadSkillRegistry();
  const skills = registry.candidates ?? [...registry.skills.values()];
  const projectSkills = skills.filter(skill => skill.source === 'project');
  const project = projectSkills.map(skill => `${skill.name}:${skill.path}`).join('\n');
  const errors = registry.errors.map(error => `${error.source ? `${error.source}/` : ''}${error.directory}: ${error.message}`).join('\n');
  // Visible load-time shadow notices (HZA-6): a project skill silently
  // overriding a same-named user skill is something the user should see.
  const notices = (registry.notices ?? []).join('\n');
  const messages: string[] = [];
  if (project && project !== previous.project) {
    messages.push(`Project skills discovered (repository-provided, untrusted content): ${projectSkills.map(skill => skill.name).join(', ')}`);
  }
  if (errors && errors !== previous.errors) messages.push(`Invalid skills were isolated:\n${errors}`);
  if (notices && notices !== previous.notices) messages.push(notices);
  return {skills, state: {project, errors, notices}, messages};
}
