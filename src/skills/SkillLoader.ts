import fs from 'fs-extra';
import path from 'node:path';
import YAML from 'yaml';
import type {LoadedSkill, LoadedSkillReference, SkillFrontmatter} from './types.js';

const MAX_REFERENCE_BYTES = 50_000;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const MARKDOWN_LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;
const PLAIN_REFERENCE_RE = /(?:^|\n)\s*(?:[-*]\s+)?((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)\s*(?=\n|$)/g;

function validateFrontmatter(value: unknown): SkillFrontmatter {
  if (typeof value !== 'object' || value == null) throw new Error('SKILL.md frontmatter must be an object');
  const frontmatter = value as Partial<SkillFrontmatter>;
  if (typeof frontmatter.name !== 'string' || frontmatter.name.trim().length === 0) throw new Error('SKILL.md frontmatter requires name');
  if (!/^[a-zA-Z0-9_-]+$/.test(frontmatter.name)) throw new Error('Skill name may only contain letters, numbers, hyphens, and underscores');
  if (typeof frontmatter.description !== 'string' || frontmatter.description.trim().length === 0) throw new Error('SKILL.md frontmatter requires description');
  return {name: frontmatter.name.trim(), description: frontmatter.description.trim()};
}

function parseSkillMarkdown(content: string) {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) throw new Error('SKILL.md must start with YAML frontmatter delimited by ---');
  const frontmatter = validateFrontmatter(YAML.parse(match[1] ?? ''));
  return {frontmatter, body: content.slice(match[0].length).trim()};
}

function normalizeReference(reference: string) {
  const withoutAnchor = reference.split('#')[0]?.split('?')[0]?.trim() ?? '';
  return withoutAnchor.replace(/^<|>$/g, '');
}

function referencedPaths(body: string) {
  const refs = new Set<string>();
  for (const match of body.matchAll(MARKDOWN_LINK_RE)) {
    const ref = normalizeReference(match[1] ?? '');
    if (ref && !ref.includes('://')) refs.add(ref);
  }
  for (const match of body.matchAll(PLAIN_REFERENCE_RE)) {
    const ref = normalizeReference(match[1] ?? '');
    if (ref) refs.add(ref);
  }
  return [...refs];
}

async function loadReference(dir: string, referencePath: string): Promise<LoadedSkillReference> {
  if (path.isAbsolute(referencePath)) throw new Error(`Skill reference must be relative: ${referencePath}`);
  const absolutePath = path.resolve(dir, referencePath);
  const relative = path.relative(dir, absolutePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Skill reference escapes skill directory: ${referencePath}`);
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) throw new Error(`Skill reference is not a file: ${referencePath}`);
  if (stat.size > MAX_REFERENCE_BYTES) throw new Error(`Skill reference is too large: ${referencePath}`);
  return {path: referencePath, absolutePath, content: await fs.readFile(absolutePath, 'utf8')};
}

export async function loadSkill(dir: string, source: 'global' = 'global'): Promise<LoadedSkill | null> {
  const skillPath = path.join(dir, 'SKILL.md');
  if (!(await fs.pathExists(skillPath))) return null;
  const content = await fs.readFile(skillPath, 'utf8');
  const {frontmatter, body} = parseSkillMarkdown(content);
  const references = await Promise.all(referencedPaths(body).map(ref => loadReference(dir, ref)));
  return {dir, path: skillPath, name: frontmatter.name, description: frontmatter.description, body, references, source};
}

export const internals = {parseSkillMarkdown, referencedPaths};
