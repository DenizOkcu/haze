import fs from 'fs-extra';
import path from 'node:path';
import {GLOBAL_SKILLS_DIR, LOCAL_SKILLS_DIR} from '../config/paths.js';
import {SkillLoader} from './SkillLoader.js';
import type {LoadedSkill, LoadedTool} from './types.js';

export class SkillRegistry {
  skills = new Map<string, LoadedSkill>();
  tools = new Map<string, LoadedTool>();
  private loader = new SkillLoader();

  async load(): Promise<this> {
    this.skills.clear();
    this.tools.clear();
    await fs.ensureDir(GLOBAL_SKILLS_DIR);
    await fs.ensureDir(LOCAL_SKILLS_DIR);
    await this.scanDir(GLOBAL_SKILLS_DIR, 'global');
    await this.scanDir(LOCAL_SKILLS_DIR, 'local'); // local overrides global
    for (const skill of this.skills.values()) for (const tool of skill.tools) this.tools.set(tool.id, tool);
    return this;
  }

  getPromptContext(): string {
    return [...this.skills.values()].flatMap(s => s.prompts.map(p => `# ${s.manifest.name}/${p.name}\n${p.content}`)).join('\n\n');
  }

  private async scanDir(root: string, source: 'global' | 'local') {
    if (!(await fs.pathExists(root))) return;
    for (const name of await fs.readdir(root)) {
      const dir = path.join(root, name);
      if (!(await fs.stat(dir)).isDirectory()) continue;
      const skill = await this.loader.loadSkill(dir, source);
      if (skill) this.skills.set(skill.manifest.name, skill);
    }
  }
}
