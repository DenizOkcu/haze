#!/usr/bin/env node
import {Command} from 'commander';
import {listSkills, infoSkill, removeSkill, validateSkill} from './commands/skills.js';
import {buildSkill} from './commands/build-skill.js';
import {installSkill} from './commands/install-skill.js';
import {chatCommand} from './commands/chat.js';

const program = new Command();
program.name('haze').description('A pragmatic, intentionally limited agentic CLI.').version('0.1.0');

program.action(async () => {
  await chatCommand();
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
