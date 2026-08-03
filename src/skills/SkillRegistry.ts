import fs from 'fs-extra';
import path from 'node:path';
import {GLOBAL_SKILLS_DIR} from '../config/paths.js';
import {loadSkill} from './SkillLoader.js';
import type {LoadedSkill, SkillRegistry, SkillSource} from './types.js';
import {assertRealPathInsideRoot} from '../utils/path.js';

async function loadRoot(
  root: string,
  containmentRoot: string,
  source: SkillSource,
  errors: SkillRegistry['errors'],
): Promise<LoadedSkill[]> {
  if (!(await fs.pathExists(root))) return [];
  if (source === 'project') {
    try {
      await assertRealPathInsideRoot(containmentRoot, root, '.haze/skills', 'workspace');
    } catch (error) {
      errors.push({directory: '.haze/skills', source, message: error instanceof Error ? error.message : String(error)});
      return [];
    }
  }
  const skills: LoadedSkill[] = [];
  const names = new Set<string>();
  for (const name of (await fs.readdir(root)).sort()) {
    const dir = path.join(root, name);
    try {
      // Project-controlled symlinks must remain inside the workspace, not merely
      // inside a possibly symlinked .haze/skills directory.
      await assertRealPathInsideRoot(containmentRoot, dir, name, source === 'project' ? 'workspace' : 'skills root');
      if (!(await fs.stat(dir)).isDirectory()) continue;
      const skill = await loadSkill(dir, source);
      if (!skill) continue;
      if (names.has(skill.name)) {
        errors.push({directory: name, source, message: `duplicate skill name "${skill.name}"; first valid skill wins`});
        continue;
      }
      names.add(skill.name);
      skills.push(skill);
    } catch (error) {
      errors.push({directory: name, source, message: error instanceof Error ? error.message : String(error)});
    }
  }
  return skills;
}

export function resolveSkillCandidates(
  candidates: Iterable<LoadedSkill>,
  enabled: (skill: LoadedSkill) => boolean = () => true,
): Map<string, LoadedSkill> {
  const skills = new Map<string, LoadedSkill>();
  for (const skill of candidates) if (enabled(skill) && !skills.has(skill.name)) skills.set(skill.name, skill);
  return skills;
}

export async function loadSkillRegistry(cwd = process.cwd()): Promise<SkillRegistry> {
  const errors: SkillRegistry['errors'] = [];
  await fs.ensureDir(GLOBAL_SKILLS_DIR);
  const global = await loadRoot(GLOBAL_SKILLS_DIR, GLOBAL_SKILLS_DIR, 'global', errors);
  const projectRoot = path.join(cwd, '.haze', 'skills');
  const project = await loadRoot(projectRoot, cwd, 'project', errors);
  const candidates = [...project, ...global];
  const skills = resolveSkillCandidates(candidates);
  return {skills, candidates, errors};
}
