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

const {loadSkillRegistry} = await import('../../src/skills/SkillRegistry.js');

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
});