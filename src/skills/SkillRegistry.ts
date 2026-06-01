import fs from 'fs-extra';
import path from 'node:path';
import {GLOBAL_SKILLS_DIR} from '../config/paths.js';
import {loadSkill} from './SkillLoader.js';
import type {LoadedSkill, SkillRegistry} from './types.js';

export async function loadSkillRegistry(): Promise<SkillRegistry> {
  const skills = new Map<string, LoadedSkill>();
  await fs.ensureDir(GLOBAL_SKILLS_DIR);
  for (const name of await fs.readdir(GLOBAL_SKILLS_DIR)) {
    const dir = path.join(GLOBAL_SKILLS_DIR, name);
    if (!(await fs.stat(dir)).isDirectory()) continue;
    const skill = await loadSkill(dir, 'global');
    if (skill) skills.set(skill.name, skill);
  }
  return {skills};
}
