import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {loadSkill} from '../../src/skills/SkillLoader.js';
import {SKILL_MARKDOWN_BYTES} from '../../src/core/limits.js';

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

  it('rejects protected secret references before reading them (CI-03)', async () => {
    // Synthetic protected names only — no real credentials are ever created.
    await fs.writeFile(path.join(tmp, 'SKILL.md'), skillMarkdown('name: test\ndescription: test', 'References:\n- [env](.env)\n- [key](server.key)'));
    await expect(loadSkill(tmp)).rejects.toThrow(/protected secret/);
    expect(await fs.pathExists(path.join(tmp, '.env'))).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('rejects a symlink renamed onto a protected name', async () => {
    const outside = path.join(path.dirname(tmp), `${path.basename(tmp)}-target.md`);
    await fs.writeFile(outside, 'innocuous');
    try {
      await fs.symlink(outside, path.join(tmp, 'id_rsa'));
      await fs.writeFile(path.join(tmp, 'SKILL.md'), skillMarkdown('name: test\ndescription: test', 'References:\n- [key](id_rsa)'));
      await expect(loadSkill(tmp)).rejects.toThrow(/protected secret/);
    } finally {
      await fs.remove(outside);
    }
  });

  it('rejects too many references and oversized aggregate reference bodies (CI-04)', async () => {
    await fs.ensureDir(path.join(tmp, 'refs'));
    const many = Array.from({length: 21}, (_, i) => `refs/${i}.md`).join('\n- ');
    await fs.writeFile(path.join(tmp, 'SKILL.md'), skillMarkdown('name: test\ndescription: test', `References:\n- ${many}`));
    await expect(loadSkill(tmp)).rejects.toThrow(/maximum is 20/);

    const big = 'x'.repeat(45_000);
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md', 'e.md']) await fs.writeFile(path.join(tmp, 'refs', name), big);
    await fs.writeFile(path.join(tmp, 'SKILL.md'), skillMarkdown('name: test\ndescription: test', 'References:\n- [a](refs/a.md)\n- [b](refs/b.md)\n- [c](refs/c.md)\n- [d](refs/d.md)\n- [e](refs/e.md)'));
    await expect(loadSkill(tmp)).rejects.toThrow(/aggregate/);
  });

  it('loads documentation-template references that share the env stem', async () => {
    await fs.writeFile(path.join(tmp, '.env.example'), '# placeholder variables only');
    await fs.writeFile(path.join(tmp, 'SKILL.md'), skillMarkdown('name: test\ndescription: test', 'References:\n- [sample](.env.example)'));
    const skill = await loadSkill(tmp);
    expect(skill?.references[0]?.content).toContain('placeholder');
  });

  it('rejects references outside the skill directory', async () => {
    await fs.writeFile(path.join(tmp, 'SKILL.md'), skillMarkdown('name: test\ndescription: test', 'References:\n[bad](../outside.md)'));
    await expect(loadSkill(tmp)).rejects.toThrow(/escapes/);
  });

  it.runIf(process.platform !== 'win32')('rejects an outside-root symlinked SKILL.md', async () => {
    const outside = path.join(path.dirname(tmp), `${path.basename(tmp)}-outside.md`);
    await fs.writeFile(outside, skillMarkdown('name: escaped\ndescription: escaped'));
    try {
      await fs.symlink(outside, path.join(tmp, 'SKILL.md'));
      await expect(loadSkill(tmp)).rejects.toThrow(/outside the skill directory/);
    } finally {
      await fs.remove(outside);
    }
  });

  it.runIf(process.platform !== 'win32')('rejects referenced symlinks that resolve outside the skill directory', async () => {
    const outside = path.join(path.dirname(tmp), `${path.basename(tmp)}-secret.md`);
    await fs.writeFile(outside, 'secret');
    try {
      await fs.symlink(outside, path.join(tmp, 'secret.md'));
      await fs.writeFile(path.join(tmp, 'SKILL.md'), skillMarkdown('name: test\ndescription: test', 'References:\n- [secret](secret.md)'));
      await expect(loadSkill(tmp)).rejects.toThrow(/outside the skill directory/);
    } finally {
      await fs.remove(outside);
    }
  });

  it('rejects oversized SKILL.md before parsing it', async () => {
    await fs.writeFile(path.join(tmp, 'SKILL.md'), skillMarkdown('name: huge\ndescription: huge', 'x'.repeat(SKILL_MARKDOWN_BYTES)));
    await expect(loadSkill(tmp)).rejects.toThrow(/byte limit/);
  });
});
