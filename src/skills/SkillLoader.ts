import fs from 'fs-extra';
import path from 'node:path';
import YAML from 'yaml';
import type {LoadedSkill, LoadedSkillReference, SkillFrontmatter, SkillSource} from './types.js';
import {assertRealPathInsideRoot} from '../utils/path.js';
import {SKILL_MARKDOWN_BYTES} from '../core/limits.js';
import {readUtf8Prefix} from '../core/io/boundedRead.js';
import {isProtectedSecretPath} from '../core/safety/secretPaths.js';

const MAX_REFERENCE_BYTES = 50_000;
/** CI-04: aggregate bounds so a dense skill cannot allocate unbounded memory. */
const MAX_REFERENCES = 20;
const MAX_TOTAL_REFERENCE_BYTES = 200_000;
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
  // CI-03: the shared secret policy applies to skill bodies and references —
  // confinement alone does not; a protected name inside the skill directory is
  // refused before any filesystem access. Errors carry path metadata only.
  if (isProtectedSecretPath(absolutePath)) throw new Error(`Skill reference is a protected secret file: ${referencePath}`);
  const realPath = await assertRealPathInsideRoot(dir, absolutePath, referencePath, 'skill directory');
  if (isProtectedSecretPath(realPath)) throw new Error(`Skill reference is a protected secret file: ${referencePath}`);
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) throw new Error(`Skill reference is not a file: ${referencePath}`);
  const prefix = await readUtf8Prefix(realPath, MAX_REFERENCE_BYTES);
  if (prefix.truncated) throw new Error(`Skill reference is too large: ${referencePath}`);
  return {path: referencePath, absolutePath: realPath, content: prefix.content};
}

export async function loadSkill(dir: string, source: SkillSource = 'global'): Promise<LoadedSkill | null> {
  const skillPath = path.join(dir, 'SKILL.md');
  if (!(await fs.pathExists(skillPath))) return null;
  const realSkillPath = await assertRealPathInsideRoot(dir, skillPath, 'SKILL.md', 'skill directory');
  if (isProtectedSecretPath(realSkillPath)) throw new Error('SKILL.md is a protected secret file');
  const stat = await fs.stat(realSkillPath);
  if (!stat.isFile()) throw new Error('SKILL.md is not a file');
  const prefix = await readUtf8Prefix(realSkillPath, SKILL_MARKDOWN_BYTES);
  if (prefix.truncated) throw new Error(`SKILL.md exceeds ${SKILL_MARKDOWN_BYTES} byte limit`);
  const content = prefix.content;
  const {frontmatter, body} = parseSkillMarkdown(content);
  const referencePaths = referencedPaths(body);
  if (referencePaths.length > MAX_REFERENCES) throw new Error(`Skill declares ${referencePaths.length} references; the maximum is ${MAX_REFERENCES}.`);
  // Sequential bounded loading (CI-04): no unbounded Promise.all fan-out, and
  // the aggregate byte budget fails loudly instead of growing silently.
  const references: LoadedSkillReference[] = [];
  let totalReferenceBytes = 0;
  for (const ref of referencePaths) {
    const loaded = await loadReference(dir, ref);
    totalReferenceBytes += Buffer.byteLength(loaded.content);
    if (totalReferenceBytes > MAX_TOTAL_REFERENCE_BYTES) throw new Error(`Skill references exceed the aggregate ${MAX_TOTAL_REFERENCE_BYTES} byte limit`);
    references.push(loaded);
  }
  return {dir, path: realSkillPath, name: frontmatter.name, description: frontmatter.description, body, references, source};
}
