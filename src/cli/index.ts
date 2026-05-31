#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {Command} from 'commander';
import {listSkills, infoSkill, removeSkill, validateSkill} from './commands/skills.js';
import {buildSkill} from '../skills/builder/SkillBuilder.js';
import {installSkill} from '../skills/installer/SkillInstaller.js';
import {chatCommand} from './commands/chat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));

const program = new Command();
program
  .name('haze')
  .description('A pragmatic, intentionally limited agentic CLI.')
  .version(pkg.version)
  .option('--debug', 'show simple model/tool debug logs in the chat UI');

program.action(async () => {
  await chatCommand({debug: Boolean(program.opts<{debug?: boolean}>().debug)});
});

program.command('build-skill <description...>').description('Deliberately design and create a new file-based skill').action(async (d: string[]) => buildSkill(d.join(' ')));
program.command('install-skill <githubRepo>').description('Install a skill from GitHub with mandatory approval').action(installSkill);

const skills = program.command('skills').description('Manage skills');
skills.command('list').description('List installed skills').action(listSkills);
skills.command('info <name>').description('Show skill details').action(infoSkill);
skills.command('remove <name>').description('Remove an installed skill').action(removeSkill);
skills.command('validate <dir>').description('Validate a skill directory').action(validateSkill);

program.parseAsync().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
