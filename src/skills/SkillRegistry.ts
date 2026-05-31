import fs from 'fs-extra';
import path from 'node:path';
import {GLOBAL_SKILLS_DIR, LOCAL_SKILLS_DIR} from '../config/paths.js';
import {loadSkill} from './SkillLoader.js';
import type {LoadedSkill, LoadedTool} from './types.js';

export interface SkillRegistry {
  skills: Map<string, LoadedSkill>;
  tools: Map<string, LoadedTool>;
}

export async function loadSkillRegistry(): Promise<SkillRegistry> {
  const skills = new Map<string, LoadedSkill>();
  const tools = new Map<string, LoadedTool>();

  async function scanDir(root: string, source: 'global' | 'local') {
    if (!(await fs.pathExists(root))) return;
    for (const name of await fs.readdir(root)) {
      const dir = path.join(root, name);
      if (!(await fs.stat(dir)).isDirectory()) continue;
      const skill = await loadSkill(dir, source);
      if (skill) skills.set(skill.manifest.name, skill);
    }
  }

  await fs.ensureDir(GLOBAL_SKILLS_DIR);
  await fs.ensureDir(LOCAL_SKILLS_DIR);
  await scanDir(GLOBAL_SKILLS_DIR, 'global');
  await scanDir(LOCAL_SKILLS_DIR, 'local');

  for (const skill of skills.values()) for (const tool of skill.tools) tools.set(tool.id, tool);

  return {skills, tools};
}
