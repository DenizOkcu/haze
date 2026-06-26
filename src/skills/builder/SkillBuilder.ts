import {generateObject} from 'ai';
import fs from 'fs-extra';
import path from 'node:path';
import YAML from 'yaml';
import {GLOBAL_SKILLS_DIR} from '../../config/paths.js';
import {model} from '../../llm/client.js';
import {loadSkill} from '../SkillLoader.js';
import {z} from 'zod';

const STANDARD_SKILL_REQUIREMENTS = `

# Operating rules

- Optimize for autonomous completion for expert users: do not ask for command confirmations; stop only for concrete blockers or necessary product decisions.
- Ground the work in actual tool output or file contents before producing the final answer.
- Inspect large inputs incrementally: summary/list commands first, then targeted reads or per-file diffs for what matters to the goal.
- Truncated output is not a blocker. Run narrower commands or read specific files to gather enough evidence.
- If the primary input is empty, check natural fallback inputs before stopping (e.g. for a branch diff, also inspect staged and unstaged changes).
- Only report "nothing to do" when every relevant input source has been checked and is empty.
- Only call something a blocker when a concrete tool failure, missing dependency/permission, or ambiguous user requirement prevents progress.
- Cite concrete files, commands, or evidence in the final response. Prefer file/function references; require exact lines only when available.
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
Keep skills simple, short, and practical: prefer the fewest commands and sections that reliably complete the workflow for a professional user.
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
- Blocker policy: concrete conditions that justify stopping, excluding truncation or ordinary non-destructive operations when narrower inspection or autonomous action is possible.
- Output template: a compact, reusable final-answer template with predictable headings/placeholders.
- Evidence rule: require final answers to be grounded in actual inspected content, but do not require exhaustive citations.

Infer the user's intent from their wording and make that intent explicit in the Focused prompt. A good focused prompt states what the skill should accomplish, not just what commands it should run.
Users often phrase skill requests with meta-framing like "create a skill that...", "make me a skill for...", "build a ... skill", or the equivalent in any language. Strip that framing. The skill must perform the underlying intent end-to-end; it must not be a skill whose job is to "create" or "build" the thing the user named. Example: "create a security review skill" means the skill IS a security reviewer, not a skill that creates security reviewers.
Favor skills that a small or slower model can follow in one pass. The model should be able to finish with a concise response after a small number of tool calls.
Avoid fragile skills that stop after one empty command or one truncated command, but do not over-correct by requiring exhaustive inspection. Encode only common, necessary fallbacks.
For diff/review skills, keep the default path simple: get status/stat/name-only, inspect unstaged and staged diffs if present, and if no changes or target exist, return a short no-changes response. Use targeted per-file diffs only when the full diff is too large or truncated.
Do not require exact line citations for every finding in generated skills; require concrete file/function/code-area evidence instead, with exact lines only when available.
`;

type GeneratedSkillFile = {path: string; content: string};
type GeneratedSkill = {name: string; intent: string; files: GeneratedSkillFile[]};

const generatedSkillSchema = z.object({
  name: z.string().min(1).describe('Meaningful kebab-case skill name with 2-4 words'),
  intent: z.string().min(1).describe('The underlying purpose the skill performs, with any "create a skill" / "make me a skill" framing stripped away. States what the skill DOES, in the same language the user used. Example: input "create a security review skill" -> intent "security review".'),
  files: z.array(z.object({
    path: z.string().min(1).describe('Relative file path inside the skill directory'),
    content: z.string().describe('Complete file content'),
  })).min(1).describe('Generated skill files, including SKILL.md'),
});

const SKILL_NAME_STOP_WORDS = new Set([
  'a', 'an', 'the', 'to', 'for', 'with', 'and', 'or', 'of', 'in', 'on', 'my', 'our', 'me', 'i', 'from', 'against', 'as', 'by', 'into', 'using', 'use', 'when', 'asks', 'ask', 'skill', 'skills',
]);

const SKILL_NAME_TRAILING_FILLER_WORDS = new Set([
  'write', 'create', 'make', 'build', 'generate', 'do', 'run', 'handle', 'help', 'using', 'with', 'for', 'to',
]);

export function slug(s: string) {
  const rawWords = s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const meaningfulWords = rawWords.filter(word => !SKILL_NAME_STOP_WORDS.has(word));
  const words = (meaningfulWords.length >= 2 ? meaningfulWords : rawWords).slice(0, 4);
  while (words.length > 2 && SKILL_NAME_TRAILING_FILLER_WORDS.has(words.at(-1) ?? '')) words.pop();
  if (words.length === 0) return 'custom-skill';
  if (words.length === 1) words.push(words[0] === 'custom' ? 'skill' : 'workflow');
  return words.join('-');
}

/**
 * Coerce a user-typed skill name into a directory-safe kebab-case slug.
 * Unlike slug(), this preserves every word the user typed (no stop-word stripping)
 * so explicit names like "create a skill" come through as "create-a-skill", not "skill".
 * Returns '' when the input collapses to nothing usable.
 */
export function toSkillDirName(raw: string): string {
  const collapsed = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  const stripped = collapsed.replace(/[^a-z0-9-]/g, '');
  const trimmed = stripped.replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  return trimmed;
}

export type CreateSkillInput = {
  name: string;
  role?: string;
  description: string;
};

function yamlString(value: string) {
  return JSON.stringify(value);
}

const DEFAULT_SKILL_ROLE = 'You are a focused, practical assistant for this workflow.';

function fallbackSkill(input: CreateSkillInput): GeneratedSkill {
  const name = input.name;
  const role = input.role?.trim() || DEFAULT_SKILL_ROLE;
  return {
    name,
    intent: input.description,
    files: [{
      path: 'SKILL.md',
      content: `---\nname: ${name}\ndescription: ${yamlString(`Use when the user asks: ${input.description}`)}\n---\n\n# Role\n\n${role}\n\n# Focused prompt\n\nAccomplish the user's intended outcome with the smallest reliable workflow: ${input.description}\n\n# Inputs to inspect\n\nIdentify the concrete commands, files, diffs, logs, or project state needed for this workflow. Inspect actual content, not only summaries.\n\n# Procedure\n\n1. Confirm the relevant project state.\n2. Inspect the primary input for the workflow.\n3. If the primary input is empty, unavailable, or truncated, inspect natural fallback inputs or narrower targeted inputs before stopping.\n4. For large inputs, inspect summaries first, then targeted files, sections, or commands most relevant to the goal.\n5. Perform the requested analysis or implementation using the inspected evidence.\n6. Produce the final answer using the output template below.\n\n# Stop conditions\n\nOnly say there is nothing to do after every relevant input source has been checked and is empty.\n\n# Blocker policy\n\nOnly stop as blocked for a concrete tool failure, missing permission, unavailable dependency, or ambiguous requirement that prevents progress. Truncated output is not a blocker when narrower follow-up inspection is possible.\n\n# Output template\n\n## Summary\n- <one-to-three bullets with the result>\n\n## Actions or findings\n- <concrete actions taken or findings discovered>\n\n## Evidence inspected\n- <commands, files, diffs, or outputs used>\n\n## Next step\n- <recommended next action, or "None" if complete>\n${STANDARD_SKILL_REQUIREMENTS}\n# References\n\nAdd relative file references here if this skill needs examples, templates, or supporting docs.\n`,
    }],
  };
}

function withStandardRequirements(content: string) {
  return content.includes('# Operating rules') || content.includes('# Operational guardrails') ? content : `${content.trim()}${STANDARD_SKILL_REQUIREMENTS}\n`;
}

function withSkillName(content: string, name: string) {
  if (/^---\n[\s\S]*?^name:\s*.*$/m.test(content)) return content.replace(/^(---\n[\s\S]*?^name:\s*).*$/m, `$1${name}`);
  return content;
}

function normalizeSkillDescription(description: string) {
  const trimmed = description.replace(/\s+/g, ' ').trim();
  if (!trimmed) return 'Use when the user asks for this workflow.';
  return /^use when\b/i.test(trimmed) ? trimmed : `Use when ${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}`;
}

function withSkillDescription(content: string, description: string) {
  const normalized = normalizeSkillDescription(description);
  if (/^---\n[\s\S]*?^description:\s*.*$/m.test(content)) return content.replace(/^(---\n[\s\S]*?^description:\s*).*$/m, `$1${yamlString(normalized)}`);
  return content;
}

/** Read the `description` field from generated SKILL.md frontmatter (single source of truth). */
function extractDescription(content: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/m.exec(content);
  if (!match) return undefined;
  const parsed = YAML.parse(match[1] ?? '') as {description?: unknown};
  return typeof parsed.description === 'string' && parsed.description.trim() ? parsed.description.trim() : undefined;
}

function extractJson(text: string) {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(text);
  return fenced?.[1] ?? text;
}

function parseGeneratedSkill(text: string, description: string): GeneratedSkill {
  const parsed = JSON.parse(extractJson(text)) as Partial<GeneratedSkill>;
  const name = typeof parsed.name === 'string' && parsed.name.trim() ? slug(parsed.name) : slug(description);
  const intent = typeof parsed.intent === 'string' && parsed.intent.trim() ? parsed.intent.trim() : description;
  const files = Array.isArray(parsed.files) ? parsed.files.filter((file): file is GeneratedSkillFile => {
    return typeof file === 'object' && file != null && typeof file.path === 'string' && typeof file.content === 'string';
  }) : [];
  if (!files.some(file => file.path === 'SKILL.md')) throw new Error('Generated skill did not include SKILL.md');
  return {name, intent, files};
}

function assertSafeGeneratedFile(filePath: string) {
  if (path.isAbsolute(filePath)) throw new Error(`Generated skill file must be relative: ${filePath}`);
  const normalized = path.normalize(filePath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new Error(`Generated skill file escapes skill directory: ${filePath}`);
  if (normalized.length === 0 || normalized === '.') throw new Error('Generated skill file path is empty');
  return normalized;
}

async function generateSkill(input: CreateSkillInput): Promise<GeneratedSkill> {
  const activeModel = await model();
  if (!activeModel) throw new Error('No model provider configured. Run /provider to choose or add a provider before creating a skill via /skills.');
  const role = input.role?.trim() || DEFAULT_SKILL_ROLE;
  const result = await generateObject({
    model: activeModel,
    system: SKILL_CREATOR_SKILL,
    schema: generatedSkillSchema,
    schemaName: 'GeneratedHazeSkill',
    schemaDescription: 'A generated Haze Markdown skill and optional referenced files.',
    prompt: [
      'A user is creating a Haze skill via a 3-step wizard. They have already chosen the NAME and the ROLE; you do NOT choose those.',
      '',
      `User-chosen skill name (use VERBATIM in frontmatter, do not rename): ${input.name}`,
      `User-chosen Role text (paste VERBATIM into the # Role section): ${role}`,
      `Skill description (the work the skill should do): ${input.description}`,
      '',
      'Step 1 — Extract the intent from the description.',
      'The description may contain meta-framing in ANY language: phrases like "create a skill that...", "make me a skill for...", "build a ... skill", or the equivalent verbs and nouns in any other language. Strip that framing and capture what the skill should actually DO. Put the result in the `intent` field, in the same language the user used.',
      '- "create a security review skill" -> intent: "security review"',
      '- "make me a skill that finds TODOs" -> intent: "finds TODOs"',
      '- "crée une compétence qui vérifie le style du code" -> intent: "vérifie le style du code"',
      'The intent must describe the work the skill performs, not the act of creating a skill. If the description already states the purpose cleanly (e.g. "review code"), copy it through unchanged.',
      '',
      'Step 2 — Build the skill around the intent, not the framing.',
      `- The skill name in frontmatter MUST be exactly: ${input.name} — do not invent a different name.`,
      `- The # Role section MUST contain exactly this text (do not rephrase): ${role}`,
      '- The skill MUST perform the intent end-to-end. It must NOT be a skill whose job is to "create" or "build" the thing the user named.',
      '- Bad: for intent "security review", the Role says "You create a security reviewer." Good: the Role says "You are a security reviewer" and the skill actually performs security review.',
      '- SKILL.md must include frontmatter with name and description.',
      '- The frontmatter description must start with "Use when".',
      '- Make the intent explicit in the Focused prompt.',
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
  const intent = generated.intent?.trim() || input.description;
  // The user already named the skill — use it verbatim. The single generation pass
  // also writes the frontmatter description; normalize it rather than spending a
  // second model call to re-derive it.
  const finalName = input.name;
  const skillMd = generated.files.find(file => file.path === 'SKILL.md')?.content;
  const rawDescription = skillMd ? extractDescription(skillMd) : undefined;
  const finalDescription = normalizeSkillDescription(rawDescription ?? `the user asks: ${intent}`);
  const files = generated.files.map(file => file.path === 'SKILL.md' ? {...file, content: withSkillDescription(file.content, finalDescription)} : file);
  return {name: finalName, intent, files};
}

export async function createSkill(input: CreateSkillInput) {
  const name = toSkillDirName(input.name);
  if (!name) throw new Error('Skill name must contain at least one letter or number.');
  const normalizedInput: CreateSkillInput = {...input, name, role: input.role?.trim() || undefined};
  const generated = await generateSkill(normalizedInput).catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('No model provider configured.')) throw error instanceof Error ? error : new Error(message);
    return fallbackSkill(normalizedInput);
  });
  const finalName = generated.name || name;
  const dir = path.join(GLOBAL_SKILLS_DIR, finalName);
  const skillFile = path.join(dir, 'SKILL.md');
  await fs.ensureDir(dir);
  if (await fs.pathExists(skillFile)) throw new Error(`Skill already exists: ${finalName}`);

  for (const generatedFile of generated.files) {
    const safePath = assertSafeGeneratedFile(generatedFile.path);
    const absolutePath = path.join(dir, safePath);
    await fs.ensureDir(path.dirname(absolutePath));
    const content = safePath === 'SKILL.md' ? withSkillName(withStandardRequirements(generatedFile.content), finalName) : generatedFile.content;
    await fs.writeFile(absolutePath, content, 'utf8');
  }

  if (!(await fs.pathExists(skillFile))) {
    const fallback = fallbackSkill(normalizedInput);
    await fs.writeFile(skillFile, fallback.files[0]!.content, 'utf8');
  }

  const loaded = await loadSkill(dir, 'global');
  if (!loaded) throw new Error('Generated skill is missing SKILL.md');
  if (loaded.name !== finalName) {
    const nextDir = path.join(GLOBAL_SKILLS_DIR, loaded.name);
    if (await fs.pathExists(nextDir)) throw new Error(`Skill already exists: ${loaded.name}`);
    await fs.move(dir, nextDir);
    return {name: loaded.name, dir: nextDir, file: path.join(nextDir, 'SKILL.md')};
  }
  return {name: finalName, dir, file: skillFile};
}

export const internals = {SKILL_CREATOR_SKILL, STANDARD_SKILL_REQUIREMENTS, parseGeneratedSkill, fallbackSkill, withStandardRequirements, withSkillName, withSkillDescription, normalizeSkillDescription, toSkillDirName, slug, assertSafeGeneratedFile};
