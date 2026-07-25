import fs from 'fs-extra';
import path from 'node:path';
import {GLOBAL_SKILLS_DIR} from '../config/paths.js';
import {loadSkill} from './SkillLoader.js';
import type {LoadedSkill, SkillRegistry} from './types.js';
import {assertRealPathInsideRoot} from '../utils/path.js';

export async function loadSkillRegistry(): Promise<SkillRegistry> {
  const skills = new Map<string, LoadedSkill>();
  const errors: SkillRegistry['errors'] = [];
  await fs.ensureDir(GLOBAL_SKILLS_DIR);
  for (const name of (await fs.readdir(GLOBAL_SKILLS_DIR)).sort()) {
    const dir = path.join(GLOBAL_SKILLS_DIR, name);
    try {
      await assertRealPathInsideRoot(GLOBAL_SKILLS_DIR, dir, name, 'skills root');
      if (!(await fs.stat(dir)).isDirectory()) continue;
      const skill = await loadSkill(dir, 'global');
      if (!skill) continue;
      if (skills.has(skill.name)) {
        errors.push({directory: name, message: `duplicate skill name "${skill.name}"; first valid skill wins`});
        continue;
      }
      skills.set(skill.name, skill);
    } catch (error) {
      errors.push({directory: name, message: error instanceof Error ? error.message : String(error)});
    }
  }
  return {skills, errors};
}
