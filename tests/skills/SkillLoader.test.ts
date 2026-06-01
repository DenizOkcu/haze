import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {loadSkill} from '../../src/skills/SkillLoader.js';

function skillMarkdown(frontmatter: string, body = 'Use this skill.') {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

describe('loadSkill', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-skill-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  it('loads a markdown skill with frontmatter', async () => {
    await fs.writeFile(path.join(tmp, 'SKILL.md'), skillMarkdown('name: my-skill\ndescription: Use when testing'));
    const skill = await loadSkill(tmp);
    expect(skill?.name).toBe('my-skill');
    expect(skill?.description).toBe('Use when testing');
    expect(skill?.body).toContain('Use this skill.');
  });

  it('returns null when SKILL.md is missing', async () => {
    await expect(loadSkill(tmp)).resolves.toBeNull();
  });

  it('rejects missing name', async () => {
    await fs.writeFile(path.join(tmp, 'SKILL.md'), skillMarkdown('description: test'));
    await expect(loadSkill(tmp)).rejects.toThrow(/name/);
  });

  it('rejects missing description', async () => {
    await fs.writeFile(path.join(tmp, 'SKILL.md'), skillMarkdown('name: test'));
    await expect(loadSkill(tmp)).rejects.toThrow(/description/);
  });

  it('loads referenced files', async () => {
    await fs.ensureDir(path.join(tmp, 'examples'));
    await fs.writeFile(path.join(tmp, 'examples', 'one.md'), 'example content');
    await fs.writeFile(path.join(tmp, 'SKILL.md'), skillMarkdown('name: test\ndescription: test', 'References:\n- examples/one.md'));
    const skill = await loadSkill(tmp);
    expect(skill?.references).toHaveLength(1);
    expect(skill?.references[0]?.content).toBe('example content');
  });

  it('rejects references outside the skill directory', async () => {
    await fs.writeFile(path.join(tmp, 'SKILL.md'), skillMarkdown('name: test\ndescription: test', 'References:\n[bad](../outside.md)'));
    await expect(loadSkill(tmp)).rejects.toThrow(/escapes/);
  });
});
