import fs from 'node:fs/promises';
import {pathExists, ensureDir} from '../utils/fs.js';
import path from 'node:path';
import {GLOBAL_SKILLS_DIR} from '../config/paths.js';
import {loadSkill} from './SkillLoader.js';
import type {LoadedSkill, SkillRegistry, SkillSource} from './types.js';
import {confinedResolve} from './confinement.js';
import {loadPluginSkills} from './plugins/runtime.js';

async function loadRoot(
  root: string,
  containmentRoot: string,
  source: SkillSource,
  errors: SkillRegistry['errors'],
): Promise<LoadedSkill[]> {
  if (!(await pathExists(root))) return [];
  if (source === 'project') {
    try {
      await confinedResolve(containmentRoot, root, '.haze/skills', 'workspace');
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
      await confinedResolve(containmentRoot, dir, name, source === 'project' ? 'workspace' : 'skills root');
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
  const notices: string[] = [];
  await ensureDir(GLOBAL_SKILLS_DIR);
  const global = await loadRoot(GLOBAL_SKILLS_DIR, GLOBAL_SKILLS_DIR, 'global', errors);
  const projectRoot = path.join(cwd, '.haze', 'skills');
  const project = await loadRoot(projectRoot, cwd, 'project', errors);
  const plugins = await loadPluginSkills(errors);
  const candidates = [...project, ...plugins, ...global];

  // Shadow notice (HZA-6): project skills silently win name collisions against
  // user-authored global skills; surface that at load time so the user can see
  // which version actually runs.
  const globalNames = new Set(global.filter(skill => skill.source === 'global').map(skill => skill.name));
  for (const candidate of project) {
    if (globalNames.has(candidate.name)) notices.push(`Project skill "${candidate.name}" shadows your same-named global skill; the project (repository-provided) version takes precedence.`);
  }

  const skills = resolveSkillCandidates(candidates);
  return {skills, candidates, errors, notices};
}
