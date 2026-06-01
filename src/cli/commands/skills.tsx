import React from 'react';
import {render, Box, Text} from 'ink';
import fs from 'fs-extra';
import path from 'node:path';
import {confirm} from '@inquirer/prompts';
import {GLOBAL_SKILLS_DIR} from '../../config/paths.js';
import {loadSkillRegistry} from '../../skills/SkillRegistry.js';
import {Header} from '../../ui/components/Header.js';
import {theme} from '../../ui/theme.js';

export async function listSkills() {
  const registry = await loadSkillRegistry();
  render(<Box flexDirection="column"><Header subtitle="Installed skills" />{[...registry.skills.values()].map(s => <Text key={s.name}><Text color={theme.purple}>{s.name}</Text> — {s.description}</Text>)}</Box>);
}

export async function infoSkill(name: string) {
  const registry = await loadSkillRegistry();
  const skill = registry.skills.get(name);
  if (!skill) throw new Error(`No skill named ${name}`);
  render(<Box flexDirection="column"><Header subtitle={`Skill: ${name}`} /><Text>{skill.description}</Text><Text color={theme.violet}>References</Text>{skill.references.map(r => <Text key={r.path}>  {r.path}</Text>)}<Text color={theme.violet}>Path</Text><Text>{skill.dir}</Text></Box>);
}

export async function removeSkill(name: string) {
  const registry = await loadSkillRegistry();
  const skill = registry.skills.get(name);
  if (!skill) throw new Error(`No skill named ${name}`);
  const ok = await confirm({message: `Remove ${name} from ${skill.dir}?`, default: false});
  if (!ok) return;
  await fs.remove(skill.dir);
  console.log(`Removed ${name}. A rare case of subtraction as progress.`);
}

export async function validateSkill(target: string) {
  const {loadSkill} = await import('../../skills/SkillLoader.js');
  const direct = path.resolve(target);
  const dir = await fs.pathExists(path.join(direct, 'SKILL.md')) ? direct : path.join(GLOBAL_SKILLS_DIR, target);
  const skill = await loadSkill(dir, 'global');
  console.log(skill ? `Valid: ${skill.name}` : 'No SKILL.md found');
}
