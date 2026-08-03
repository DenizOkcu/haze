import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

// Point the registry at a temp directory so we exercise the real fs + loader.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-skill-registry-'));

vi.mock('../../src/config/paths.js', () => ({
  GLOBAL_SKILLS_DIR: tmp,
  HAZE_DIR: tmp,
}));

const {loadSkillRegistry, resolveSkillCandidates} = await import('../../src/skills/SkillRegistry.js');

afterAll(async () => {
  await fs.remove(tmp);
});

describe('loadSkillRegistry', () => {
  beforeEach(async () => {
    await fs.emptyDir(tmp);
  });

  async function writeSkill(name: string, body = 'Use this skill.') {
    const dir = path.join(tmp, name);
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n\n${body}\n`);
    return dir;
  }

  it('returns an empty registry when no skills are installed', async () => {
    const registry = await loadSkillRegistry();
    expect(registry.skills.size).toBe(0);
  });

  it('loads every installed skill directory', async () => {
    await writeSkill('alpha');
    await writeSkill('beta');
    const registry = await loadSkillRegistry();
    expect([...registry.skills.keys()].sort()).toEqual(['alpha', 'beta']);
    expect(registry.skills.get('alpha')?.source).toBe('global');
  });

  it('ignores plain files sitting in the skills directory', async () => {
    await fs.writeFile(path.join(tmp, 'stray.md'), 'not a skill dir');
    await writeSkill('alpha');
    const registry = await loadSkillRegistry();
    expect([...registry.skills.keys()]).toEqual(['alpha']);
  });

  it('skips directories whose SKILL.md is missing', async () => {
    await fs.ensureDir(path.join(tmp, 'empty'));
    await writeSkill('alpha');
    const registry = await loadSkillRegistry();
    expect([...registry.skills.keys()]).toEqual(['alpha']);
  });

  it('isolates invalid skills while retaining valid ones', async () => {
    await writeSkill('alpha');
    const invalid = path.join(tmp, 'broken');
    await fs.ensureDir(invalid);
    await fs.writeFile(path.join(invalid, 'SKILL.md'), 'not frontmatter');
    const registry = await loadSkillRegistry();
    expect([...registry.skills.keys()]).toEqual(['alpha']);
    expect(registry.errors).toEqual([expect.objectContaining({directory: 'broken'})]);
  });

  it('keeps the first sorted valid skill when names collide', async () => {
    for (const directory of ['a', 'b']) {
      const dir = path.join(tmp, directory);
      await fs.ensureDir(dir);
      await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: duplicate\ndescription: ${directory}\n---\n\nbody\n`);
    }
    const registry = await loadSkillRegistry();
    expect(registry.skills.get('duplicate')?.description).toBe('a');
    expect(registry.errors).toEqual([expect.objectContaining({directory: 'b', message: expect.stringContaining('duplicate')})]);
  });

  it('loads project skills and gives them precedence while retaining both candidates', async () => {
    await writeSkill('shared', 'global body');
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-project-skills-'));
    const dir = path.join(workspace, '.haze', 'skills', 'shared');
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: shared\ndescription: project\n---\n\nproject body\n');
    try {
      const registry = await loadSkillRegistry(workspace);
      expect(registry.skills.get('shared')?.source).toBe('project');
      expect(registry.candidates?.filter(skill => skill.name === 'shared').map(skill => skill.source)).toEqual(['project', 'global']);
      const fallback = resolveSkillCandidates(registry.candidates ?? [], skill => skill.source !== 'project');
      expect(fallback.get('shared')?.source).toBe('global');
    } finally {
      await fs.remove(workspace);
    }
  });

  it('isolates project symlink escapes', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-project-skills-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-outside-skill-'));
    await fs.writeFile(path.join(outside, 'SKILL.md'), '---\nname: escaped\ndescription: no\n---\n\nbody\n');
    await fs.ensureDir(path.join(workspace, '.haze', 'skills'));
    await fs.symlink(outside, path.join(workspace, '.haze', 'skills', 'escaped'));
    try {
      const registry = await loadSkillRegistry(workspace);
      expect(registry.skills.has('escaped')).toBe(false);
      expect(registry.errors).toEqual(expect.arrayContaining([expect.objectContaining({directory: 'escaped', source: 'project'})]));
    } finally {
      await fs.remove(workspace);
      await fs.remove(outside);
    }
  });
});
