import React from 'react';
import {render, Box, Text} from 'ink';
import fs from 'fs-extra';
import path from 'node:path';
import {confirm} from '@inquirer/prompts';
import {loadSkillRegistry} from '../../skills/SkillRegistry.js';
import {Header} from '../../ui/components/Header.js';
import {theme} from '../../ui/theme.js';

export async function listSkills() {
  const registry = await loadSkillRegistry();
  render(<Box flexDirection="column"><Header subtitle="Installed skills" />{[...registry.skills.values()].map(s => <Text key={s.manifest.name}><Text color={theme.purple}>{s.manifest.name}</Text> {s.manifest.version} — {s.manifest.description} ({s.source})</Text>)}</Box>);
}

export async function infoSkill(name: string) {
  const registry = await loadSkillRegistry();
  const skill = registry.skills.get(name);
  if (!skill) throw new Error(`No skill named ${name}`);
  render(<Box flexDirection="column"><Header subtitle={`Skill: ${name}`} /><Text>{skill.manifest.description}</Text><Text color={theme.violet}>Tools</Text>{skill.tools.map(t => <Text key={t.id}>  {t.id}: {t.description}</Text>)}<Text color={theme.violet}>Path</Text><Text>{skill.dir}</Text></Box>);
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

export async function validateSkill(dir: string) {
  const {loadSkill} = await import('../../skills/SkillLoader.js');
  const skill = await loadSkill(path.resolve(dir), 'local');
  console.log(skill ? `Valid: ${skill.manifest.name}` : 'No skill.yaml found');
}
