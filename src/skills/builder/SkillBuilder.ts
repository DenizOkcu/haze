import {generateObject} from 'ai';
import fs from 'fs-extra';
import path from 'node:path';
import {GLOBAL_SKILLS_DIR} from '../../config/paths.js';
import {model} from '../../llm/client.js';
import {loadSkill} from '../SkillLoader.js';
import {z} from 'zod';

const STANDARD_SKILL_REQUIREMENTS = `

# Operational guardrails

- Always ground the work in actual tool output or file contents before producing the final answer.
- Define the exact commands, files, or project state that count as input for this workflow.
- Inspect large inputs incrementally. Prefer summary/list commands first, then targeted per-file reads or per-file diffs for the files most relevant to the goal.
- If a command output is truncated, do not stop. Run narrower commands or read specific files to gather enough evidence for a useful answer.
- If the primary expected input is empty, check the natural fallback inputs before stopping. For example, when reviewing a branch diff, also inspect staged and unstaged working-tree changes.
- Only report "nothing to do" when every explicitly relevant input source has been checked and is empty.
- Only call something a blocker when a concrete tool failure, missing permission, missing dependency, or ambiguous user requirement prevents progress. Truncated output is not a blocker when narrower follow-up inspection is possible.
- Do not stop after status/summary commands when the workflow requires analysis; inspect the actual content to analyze.
- In the final response, cite the concrete files, commands, or evidence used. Exact line numbers are helpful but must not be required when the available evidence supports file/function-level feedback.
`;

const SKILL_CREATOR_SKILL = `---
name: skill-creator
description: Use when the user asks Haze to create a new skill from a natural-language description.
---

You create predictable, high-quality Haze skills.

A Haze skill is a directory in ~/.haze/skills containing SKILL.md and optional referenced files.
SKILL.md must be Markdown with YAML frontmatter, followed by a role and focused prompt:

---
name: kebab-case-name
description: Use when the user asks ...
---

# Role
You are a focused, practical assistant for this workflow.

# Focused prompt
Complete the user's goal with the smallest reliable workflow.

The description must tell the model exactly when to use the skill.
The body must be a deterministic operating procedure, not generic advice.
Keep skills simple, short, and practical: prefer the fewest commands and sections that reliably complete the workflow.
Avoid exhaustive checklists, rigid citation requirements, or heavyweight output formats unless the user's request truly requires them.
Additional files are allowed only when SKILL.md explicitly references them with relative paths.
Skills do not execute code. They teach Haze how to behave for a workflow.

Every skill you create must include, in this order:
- YAML frontmatter.
- Role: the specific assistant role to adopt for this workflow.
- Focused prompt: a concise directive that explains the goal and keeps the workflow scoped.
- Inputs to inspect: only the essential commands/files/state needed for the workflow, with incremental inspection for large outputs.
- Procedure: a short ordered list with fallback paths for empty, missing, or truncated primary inputs.
- Stop conditions: when it is valid to say there is nothing to do.
- Blocker policy: concrete conditions that justify stopping, excluding truncation when narrower inspection is possible.
- Output template: a compact, reusable final-answer template with predictable headings/placeholders.
- Evidence rule: require final answers to be grounded in actual inspected content, but do not require exhaustive citations.

Infer the user's intent from their wording and make that intent explicit in the Focused prompt. A good focused prompt states what the skill should accomplish, not just what commands it should run.
Favor skills that a small or slower model can follow in one pass. The model should be able to finish with a concise response after a small number of tool calls.
Avoid fragile skills that stop after one empty command or one truncated command, but do not over-correct by requiring exhaustive inspection. Encode only common, necessary fallbacks.
For diff/review skills, keep the default path simple: get status/stat/name-only, inspect unstaged and staged diffs if present, and if no changes or target exist, return a short no-changes response. Use targeted per-file diffs only when the full diff is too large or truncated.
Do not require exact line citations for every finding in generated skills; require concrete file/function/code-area evidence instead, with exact lines only when available.
`;

type GeneratedSkillFile = {path: string; content: string};
type GeneratedSkill = {name: string; files: GeneratedSkillFile[]};

const generatedSkillSchema = z.object({
  name: z.string().min(1).describe('Kebab-case skill name'),
  files: z.array(z.object({
    path: z.string().min(1).describe('Relative file path inside the skill directory'),
    content: z.string().describe('Complete file content'),
  })).min(1).describe('Generated skill files, including SKILL.md'),
});

export function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'custom-skill';
}

function yamlString(value: string) {
  return JSON.stringify(value);
}

function fallbackSkill(description: string): GeneratedSkill {
  const name = slug(description);
  return {
    name,
    files: [{
      path: 'SKILL.md',
      content: `---\nname: ${name}\ndescription: ${yamlString(`Use when the user asks: ${description}`)}\n---\n\n# Role\n\nYou are a focused, practical assistant for this workflow.\n\n# Focused prompt\n\nAccomplish the user's intended outcome with the smallest reliable workflow: ${description}\n\n# Inputs to inspect\n\nIdentify the concrete commands, files, diffs, logs, or project state needed for this workflow. Inspect actual content, not only summaries.\n\n# Procedure\n\n1. Confirm the relevant project state.\n2. Inspect the primary input for the workflow.\n3. If the primary input is empty, unavailable, or truncated, inspect natural fallback inputs or narrower targeted inputs before stopping.\n4. For large inputs, inspect summaries first, then targeted files, sections, or commands most relevant to the goal.\n5. Perform the requested analysis or implementation using the inspected evidence.\n6. Produce the final answer using the output template below.\n\n# Stop conditions\n\nOnly say there is nothing to do after every relevant input source has been checked and is empty.\n\n# Blocker policy\n\nOnly stop as blocked for a concrete tool failure, missing permission, unavailable dependency, or ambiguous requirement that prevents progress. Truncated output is not a blocker when narrower follow-up inspection is possible.\n\n# Output template\n\n## Summary\n- <one-to-three bullets with the result>\n\n## Actions or findings\n- <concrete actions taken or findings discovered>\n\n## Evidence inspected\n- <commands, files, diffs, or outputs used>\n\n## Next step\n- <recommended next action, or "None" if complete>\n${STANDARD_SKILL_REQUIREMENTS}\n# References\n\nAdd relative file references here if this skill needs examples, templates, or supporting docs.\n`,
    }],
  };
}

function withStandardRequirements(content: string) {
  return content.includes('# Operational guardrails') ? content : `${content.trim()}${STANDARD_SKILL_REQUIREMENTS}\n`;
}

function extractJson(text: string) {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
  return fenced?.[1] ?? text;
}

function parseGeneratedSkill(text: string, description: string): GeneratedSkill {
  const parsed = JSON.parse(extractJson(text)) as Partial<GeneratedSkill>;
  const name = typeof parsed.name === 'string' && parsed.name.trim() ? slug(parsed.name) : slug(description);
  const files = Array.isArray(parsed.files) ? parsed.files.filter((file): file is GeneratedSkillFile => {
    return typeof file === 'object' && file != null && typeof file.path === 'string' && typeof file.content === 'string';
  }) : [];
  if (!files.some(file => file.path === 'SKILL.md')) throw new Error('Generated skill did not include SKILL.md');
  return {name, files};
}

function assertSafeGeneratedFile(filePath: string) {
  if (path.isAbsolute(filePath)) throw new Error(`Generated skill file must be relative: ${filePath}`);
  const normalized = path.normalize(filePath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new Error(`Generated skill file escapes skill directory: ${filePath}`);
  if (normalized.length === 0 || normalized === '.') throw new Error('Generated skill file path is empty');
  return normalized;
}

async function generateSkill(description: string): Promise<GeneratedSkill> {
  const activeModel = await model();
  if (!activeModel) throw new Error('No model provider configured. Run /provider to choose or add a provider before using /create-skill.');
  const result = await generateObject({
    model: activeModel,
    temperature: 0,
    system: SKILL_CREATOR_SKILL,
    schema: generatedSkillSchema,
    schemaName: 'GeneratedHazeSkill',
    schemaDescription: 'A generated Haze Markdown skill and optional referenced files.',
    prompt: [
      'Create a Haze skill from this user description:',
      description,
      '',
      'Rules:',
      '- SKILL.md must include frontmatter with name and description.',
      '- The frontmatter description must start with "Use when".',
      '- Infer the user intent from the description and make it explicit in the Focused prompt.',
      '- The body must start with these headings immediately after frontmatter: Role, Focused prompt.',
      '- The body must then include these headings: Inputs to inspect, Procedure, Fallbacks, Stop conditions, Blocker policy, Output template.',
      '- The Focused prompt must describe the desired outcome and definition of success, not just restate the trigger.',
      '- Keep the skill simple enough for a small or slower model to complete in one pass.',
      '- Prefer short procedures, compact final output templates, and the minimum necessary tool calls.',
      '- Avoid exhaustive checklists, mandatory line citations for every claim, and large rigid report templates unless the user explicitly asks for them.',
      '- Procedure steps must name exact commands/files/state to inspect whenever the workflow implies them, but only include essential inspections.',
      '- Include fallback behavior for empty or truncated primary inputs. Example: if branch diff is empty, inspect staged and unstaged changes before stopping; if no changes or target exist, return a concise no-changes response; if full diff is truncated, inspect per-file diffs or read changed files.',
      '- For workflows with potentially large outputs, require incremental inspection: stat/name-only/summary first, then targeted content reads.',
      '- Define when it is valid to say "nothing to do".',
      '- Define blockers narrowly: concrete tool failure, missing permission/dependency, or ambiguous requirement. Truncation alone is not a blocker if targeted follow-up inspection is possible.',
      '- Require final output to cite actual evidence inspected, using exact lines when available and file/function/code-area references otherwise.',
      '- Include extra files only when genuinely useful, and reference them from SKILL.md.',
      '- File paths must be relative and stay inside the skill directory.',
    ].join('\n'),
  });
  const generated = result.object;
  return {name: slug(generated.name || description), files: generated.files};
}

export async function createSkill(description: string) {
  const generated = await generateSkill(description).catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('No model provider configured.')) throw error instanceof Error ? error : new Error(message);
    return fallbackSkill(description);
  });
  const name = generated.name || fallbackSkill(description).name;
  const dir = path.join(GLOBAL_SKILLS_DIR, name);
  const skillFile = path.join(dir, 'SKILL.md');
  await fs.ensureDir(dir);
  if (await fs.pathExists(skillFile)) throw new Error(`Skill already exists: ${name}`);

  for (const generatedFile of generated.files) {
    const safePath = assertSafeGeneratedFile(generatedFile.path);
    const absolutePath = path.join(dir, safePath);
    await fs.ensureDir(path.dirname(absolutePath));
    const content = safePath === 'SKILL.md' ? withStandardRequirements(generatedFile.content) : generatedFile.content;
    await fs.writeFile(absolutePath, content, 'utf8');
  }

  if (!(await fs.pathExists(skillFile))) {
    const fallback = fallbackSkill(description);
    await fs.writeFile(skillFile, fallback.files[0]!.content, 'utf8');
  }

  const loaded = await loadSkill(dir, 'global');
  if (!loaded) throw new Error('Generated skill is missing SKILL.md');
  if (loaded.name !== name) {
    const nextDir = path.join(GLOBAL_SKILLS_DIR, loaded.name);
    if (await fs.pathExists(nextDir)) throw new Error(`Skill already exists: ${loaded.name}`);
    await fs.move(dir, nextDir);
    return {name: loaded.name, dir: nextDir, file: path.join(nextDir, 'SKILL.md')};
  }
  return {name, dir, file: skillFile};
}

export const internals = {SKILL_CREATOR_SKILL, STANDARD_SKILL_REQUIREMENTS, parseGeneratedSkill, fallbackSkill, withStandardRequirements};
