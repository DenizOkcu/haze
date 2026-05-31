import fs from 'fs-extra';
import path from 'node:path';
import {input, confirm} from '@inquirer/prompts';
import {GLOBAL_SKILLS_DIR} from '../../config/paths.js';
import {writeYaml} from '../../utils/yaml.js';

function slug(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'custom-skill'; }

export async function buildSkill(description: string) {
  const name = await input({message: 'Skill name', default: slug(description)});
  const toolName = await input({message: 'First tool name', default: 'run'});
  const toolDescription = await input({message: 'What should this tool do?', default: description});
  const dir = path.join(GLOBAL_SKILLS_DIR, name);
  const files = [path.join(dir, 'skill.yaml'), path.join(dir, 'README.md'), path.join(dir, 'tools', `${toolName}.ts`), path.join(dir, 'prompts', 'planning.md')];
  console.log('\nHaze will write:');
  files.forEach(f => console.log(`  ${f}`));
  const ok = await confirm({message: 'Create these skill files?', default: false});
  if (!ok) return;
  await fs.ensureDir(path.join(dir, 'tools'));
  await fs.ensureDir(path.join(dir, 'prompts'));
  await writeYaml(files[0], {name, version: '0.1.0', description, tools: [{name: toolName, description: toolDescription, path: `tools/${toolName}.ts`, input: {type: 'object', properties: {}}}], prompts: [{name: 'planning', description: 'Planning guidance for this skill.', path: 'prompts/planning.md'}]});
  await fs.writeFile(files[1], `# ${name}\n\n${description}\n`);
  await fs.writeFile(files[2], `export async function execute(input: Record<string, unknown>, context: {cwd: string}) {\n  return {ok: false, message: 'Tool ${toolName} is a generated stub. Edit this file to make it useful.', data: {input, cwd: context.cwd}};\n}\n`);
  await fs.writeFile(files[3], `Use this skill only when the user request matches: ${description}\n`);
  console.log(`Created ${name}. Please edit the tool before expecting miracles.`);
}
