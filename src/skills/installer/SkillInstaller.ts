import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {confirm} from '@inquirer/prompts';
import {GLOBAL_SKILLS_DIR} from '../../config/paths.js';
import {loadSkill} from '../SkillLoader.js';
import {listFilesRecursive} from '../../utils/fs.js';

function repoUrl(spec: string) {
  if (spec.startsWith('http')) return spec;
  if (spec.startsWith('github:')) return `https://github.com/${spec.slice(7)}.git`;
  if (/^[\w.-]+\/[\w.-]+$/.test(spec)) return `https://github.com/${spec}.git`;
  return spec;
}

export async function prepareSkillInstall(spec: string) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-skill-'));
  const url = repoUrl(spec);
  const clone = spawnSync('git', ['clone', '--depth=1', url, tmp], {stdio: 'pipe', encoding: 'utf8'});
  if (clone.status !== 0) throw new Error(`git clone failed${clone.stderr ? `: ${clone.stderr.trim()}` : ''}`);
  const skill = await loadSkill(tmp, 'global');
  if (!skill) throw new Error('Repository does not contain a root skill.yaml');
  const files = await listFilesRecursive(tmp);
  return {tmp, url, skill, files, dest: path.join(GLOBAL_SKILLS_DIR, skill.manifest.name)};
}

export function formatSkillInstallPreview(prepared: Awaited<ReturnType<typeof prepareSkillInstall>>) {
  const deps = prepared.skill.manifest.dependencies;
  return [
    `Skill: ${prepared.skill.manifest.name} ${prepared.skill.manifest.version}`,
    prepared.skill.manifest.description,
    '',
    'Files:',
    ...prepared.files.map(f => `  ${f}`),
    deps?.cli?.length ? `\nCLI dependencies: ${deps.cli.map(d => d.name).join(', ')}` : undefined,
    deps?.env?.length ? `Env dependencies: ${deps.env.map(d => d.name).join(', ')}` : undefined,
    `\nDestination: ${prepared.dest}`,
  ].filter(Boolean).join('\n');
}

export async function activatePreparedSkillInstall(prepared: Awaited<ReturnType<typeof prepareSkillInstall>>) {
  await fs.remove(prepared.dest);
  await fs.ensureDir(path.dirname(prepared.dest));
  await fs.copy(prepared.tmp, prepared.dest, {filter: src => !src.includes(`${path.sep}.git${path.sep}`)});
  await fs.remove(path.join(prepared.dest, '.git'));
  return `Installed ${prepared.skill.manifest.name} to ${prepared.dest}`;
}

export async function installSkill(spec: string) {
  const prepared = await prepareSkillInstall(spec);
  console.log(`\n${formatSkillInstallPreview(prepared)}`);
  if (await fs.pathExists(prepared.dest)) console.log(`\nExisting skill will be replaced: ${prepared.dest}`);
  const ok = await confirm({message: 'Approve and activate this skill? It is code from the internet, regrettably.', default: false});
  if (!ok) return;
  console.log(await activatePreparedSkillInstall(prepared));
}
