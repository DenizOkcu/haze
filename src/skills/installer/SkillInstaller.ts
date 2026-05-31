import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {confirm} from '@inquirer/prompts';
import {GLOBAL_SKILLS_DIR} from '../../config/paths.js';
import {SkillLoader} from '../SkillLoader.js';
import {listFilesRecursive} from '../../utils/fs.js';

function repoUrl(spec: string) {
  if (spec.startsWith('http')) return spec;
  if (spec.startsWith('github:')) return `https://github.com/${spec.slice(7)}.git`;
  if (/^[\w.-]+\/[\w.-]+$/.test(spec)) return `https://github.com/${spec}.git`;
  return spec;
}

export async function installSkill(spec: string) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-skill-'));
  const url = repoUrl(spec);
  const clone = spawnSync('git', ['clone', '--depth=1', url, tmp], {stdio: 'inherit'});
  if (clone.status !== 0) throw new Error('git clone failed');
  const skill = await new SkillLoader().loadSkill(tmp, 'global');
  if (!skill) throw new Error('Repository does not contain a root skill.yaml');
  console.log(`\nSkill: ${skill.manifest.name} ${skill.manifest.version}`);
  console.log(skill.manifest.description);
  console.log('\nFiles:');
  for (const f of await listFilesRecursive(tmp)) console.log(`  ${f}`);
  const deps = skill.manifest.dependencies;
  if (deps?.cli?.length) console.log(`\nCLI dependencies: ${deps.cli.map(d => d.name).join(', ')}`);
  if (deps?.env?.length) console.log(`Env dependencies: ${deps.env.map(d => d.name).join(', ')}`);
  const dest = path.join(GLOBAL_SKILLS_DIR, skill.manifest.name);
  if (await fs.pathExists(dest)) console.log(`\nExisting skill will be replaced: ${dest}`);
  const ok = await confirm({message: 'Approve and activate this skill? It is code from the internet, regrettably.', default: false});
  if (!ok) return;
  await fs.remove(dest);
  await fs.ensureDir(path.dirname(dest));
  await fs.copy(tmp, dest, {filter: src => !src.includes(`${path.sep}.git${path.sep}`)});
  await fs.remove(path.join(dest, '.git'));
  console.log(`Installed ${skill.manifest.name} to ${dest}`);
}
