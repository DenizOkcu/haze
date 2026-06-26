import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {internals} from '../../src/skills/builder/SkillBuilder.js';

let tmp = '';
let skillsDir = '';

async function loadSkillBuilder() {
  vi.doMock('../../src/config/paths.js', () => ({
    HAZE_DIR: tmp,
    GLOBAL_SKILLS_DIR: skillsDir,
  }));
  vi.resetModules();
  return import('../../src/skills/builder/SkillBuilder.js');
}

describe('SkillBuilder pure helpers', () => {
  describe('slug', () => {
    it('strips meta-framing stop words and joins with hyphens', () => {
      expect(internals.slug('create a security review skill')).toBe('create-security-review');
      expect(internals.slug('make me a skill that finds TODOs')).toBe('make-that-finds-todos');
    });

    it('caps at 4 words', () => {
      expect(internals.slug('one two three four five six')).toBe('one-two-three-four');
    });

    it('lowercases and strips non-alphanumeric characters', () => {
      expect(internals.slug('Hello, World!')).toBe('hello-world');
    });

    it('returns custom-skill for empty input', () => {
      expect(internals.slug('!!!')).toBe('custom-skill');
    });

    it('keeps short inputs at 2 words by repeating', () => {
      expect(internals.slug('custom')).toBe('custom-skill');
      expect(internals.slug('workflow')).toBe('workflow-workflow');
    });
  });

  describe('normalizeSkillDescription', () => {
    it('prefixes with "Use when" when the input does not already start with it', () => {
      expect(internals.normalizeSkillDescription('reviewing security issues')).toBe('Use when reviewing security issues');
    });

    it('keeps the existing prefix when already present', () => {
      expect(internals.normalizeSkillDescription('Use when reviewing code')).toBe('Use when reviewing code');
    });

    it('lowercases the first character when adding the prefix', () => {
      expect(internals.normalizeSkillDescription('Reviewing PRs')).toBe('Use when reviewing PRs');
    });

    it('collapses internal whitespace runs', () => {
      expect(internals.normalizeSkillDescription('reviewing   code\tskills')).toBe('Use when reviewing code skills');
    });

    it('returns a placeholder for empty input', () => {
      expect(internals.normalizeSkillDescription('   ')).toBe('Use when the user asks for this workflow.');
    });
  });

  describe('withSkillName', () => {
    it('rewrites the existing name field in the frontmatter', () => {
      const original = '---\nname: old-name\ndescription: Use when x\n---\n\nbody';
      expect(internals.withSkillName(original, 'new-name')).toBe('---\nname: new-name\ndescription: Use when x\n---\n\nbody');
    });

    it('does not affect the rest of the frontmatter body', () => {
      const original = '---\nname: a\ndescription: Use when x\n---\n\n# Role\n\nKeep me';
      const updated = internals.withSkillName(original, 'b');
      expect(updated).toContain('# Role\n\nKeep me');
      expect(updated).toContain('name: b');
    });

    it('handles a description field that contains extra spaces and unusual formatting', () => {
      const original = '---\nname:  spaced-name  \ndescription: Use when y\n---\n';
      expect(internals.withSkillName(original, 'clean')).toContain('name:  clean');
    });
  });

  describe('withSkillDescription', () => {
    it('rewrites the description field with a YAML-quoted value', () => {
      const original = '---\nname: test\ndescription: Use when old\n---\n';
      const updated = internals.withSkillDescription(original, 'reviewing pull requests');
      expect(updated).toContain('name: test');
      expect(updated).toContain('description: "Use when reviewing pull requests"');
    });

    it('preserves the existing "Use when" prefix without re-prefixing', () => {
      const original = '---\nname: test\ndescription: Use when reviewing\n---\n';
      const updated = internals.withSkillDescription(original, 'Use when reviewing');
      expect(updated).toContain('description: "Use when reviewing"');
    });

    it('escapes embedded quotes safely via JSON.stringify', () => {
      const original = '---\nname: test\ndescription: Use when old\n---\n';
      const updated = internals.withSkillDescription(original, 'use when "x" matters');
      expect(updated).toMatch(/description: "use when \\"x\\" matters"/);
    });
  });

  describe('assertSafeGeneratedFile', () => {
    it('accepts a normal relative path', () => {
      expect(internals.assertSafeGeneratedFile('examples/template.md')).toBe(path.join('examples', 'template.md'));
    });

    it('accepts SKILL.md at the root', () => {
      expect(internals.assertSafeGeneratedFile('SKILL.md')).toBe('SKILL.md');
    });

    it('rejects absolute paths', () => {
      expect(() => internals.assertSafeGeneratedFile('/etc/passwd')).toThrow(/relative/);
    });

    it('rejects parent-directory escapes via ..', () => {
      expect(() => internals.assertSafeGeneratedFile('../escape.md')).toThrow(/escapes skill directory/);
      expect(() => internals.assertSafeGeneratedFile('sub/../../escape.md')).toThrow(/escapes skill directory/);
    });

    it('rejects empty or "." paths', () => {
      expect(() => internals.assertSafeGeneratedFile('')).toThrow();
      expect(() => internals.assertSafeGeneratedFile('.')).toThrow();
    });
  });

  describe('parseGeneratedSkill', () => {
    it('parses a clean JSON object', () => {
      const generated = internals.parseGeneratedSkill(JSON.stringify({
        name: 'Reviewer Skill',
        intent: 'security review',
        files: [{path: 'SKILL.md', content: '---\nname: reviewer\ndescription: Use when x\n---\n'}],
      }), 'create a security review skill');
      expect(generated.name).toBe('reviewer-skill');
      expect(generated.intent).toBe('security review');
      expect(generated.files).toHaveLength(1);
    });

    it('extracts JSON from a fenced code block', () => {
      const text = 'Here is the skill:\n```json\n{"name":"reviewer","intent":"review","files":[{"path":"SKILL.md","content":"---\\nname: r\\ndescription: Use when x\\n---\\n"}]}\n```';
      const generated = internals.parseGeneratedSkill(text, 'review');
      expect(generated.intent).toBe('review');
      expect(generated.files[0]?.path).toBe('SKILL.md');
    });

    it('falls back to the description as name and intent when fields are missing', () => {
      const generated = internals.parseGeneratedSkill(JSON.stringify({
        files: [{path: 'SKILL.md', content: '---\nname: x\ndescription: Use when x\n---\n'}],
      }), 'review code');
      expect(generated.intent).toBe('review code');
      expect(generated.name).toBe('review-code');
    });

    it('throws when SKILL.md is missing from the generated files', () => {
      expect(() => internals.parseGeneratedSkill(JSON.stringify({
        name: 'x',
        intent: 'x',
        files: [{path: 'notes.md', content: 'hi'}],
      }), 'x')).toThrow(/SKILL\.md/);
    });

    it('drops malformed file entries', () => {
      const generated = internals.parseGeneratedSkill(JSON.stringify({
        name: 'reviewer',
        intent: 'review',
        files: [
          {path: 'SKILL.md', content: '---\nname: r\ndescription: Use when r\n---\n'},
          'not-an-object',
          {path: 5, content: 'no path string'},
          {content: 'no path'},
          null,
        ],
      }), 'review');
      expect(generated.files).toHaveLength(1);
    });
  });
});

describe('SkillBuilder.createSkill', () => {
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-skills-test-'));
    skillsDir = path.join(tmp, 'skills');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.remove(tmp);
  });

  it('writes a generated SKILL.md to ~/.haze/skills/<name>/SKILL.md when a model returns content', async () => {
    vi.doMock('../../src/llm/client.js', () => ({
      model: async () => ({}) as never,
    }));
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {
        ...actual,
        generateObject: async () => ({
          object: {
            name: 'unused-by-createSkill',
            intent: 'review code',
            files: [
              {
                path: 'SKILL.md',
                content: '---\nname: ignored\ndescription: Use when old\n---\n\n# Role\n\nYou review code.',
              },
            ],
          },
        }),
      };
    });
    const mod = await loadSkillBuilder();
    const result = await mod.createSkill({name: 'review-code', description: 'review code'});
    expect(result.name).toBe('review-code');
    expect(result.dir).toBe(path.join(skillsDir, 'review-code'));
    expect(result.file).toBe(path.join(skillsDir, 'review-code', 'SKILL.md'));
    const written = await fs.readFile(result.file, 'utf8');
    expect(written).toContain('name: review-code');
    expect(written).toContain('# Role');
    expect(written).toContain('You review code.');
    expect(written).toContain('# Operating rules');
  });

  it('coerces the user-supplied name into a directory-safe kebab-case slug', async () => {
    vi.doMock('../../src/llm/client.js', () => ({
      model: async () => ({}) as never,
    }));
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {
        ...actual,
        generateObject: async () => ({
          object: {
            name: 'unused',
            intent: 'review code',
            files: [{path: 'SKILL.md', content: '---\nname: unused\ndescription: Use when old\n---\n\n# Role\n\nbody'}],
          },
        }),
      };
    });
    const mod = await loadSkillBuilder();
    const result = await mod.createSkill({name: 'PR Reviewer!!!', description: 'review code'});
    expect(result.name).toBe('pr-reviewer');
    expect(result.dir).toBe(path.join(skillsDir, 'pr-reviewer'));
  });

  it('uses the fallback skill when the model call fails with a non-config error', async () => {
    vi.doMock('../../src/llm/client.js', () => ({
      model: async () => ({}) as never,
    }));
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {
        ...actual,
        generateObject: async () => {
          throw new Error('network error');
        },
      };
    });
    const mod = await loadSkillBuilder();
    const result = await mod.createSkill({name: 'fallback-skill', description: 'do fallback work'});
    expect(result.name).toBe('fallback-skill');
    const written = await fs.readFile(result.file, 'utf8');
    expect(written).toContain('name: fallback-skill');
    expect(written).toContain('# Focused prompt');
    expect(written).toContain('# Inputs to inspect');
  });

  it('throws when no model is configured', async () => {
    vi.doMock('../../src/llm/client.js', () => ({
      model: async () => undefined,
    }));
    const mod = await loadSkillBuilder();
    await expect(mod.createSkill({name: 'no-model', description: 'review'})).rejects.toThrow(/No model provider configured/);
  });

  it('writes referenced extra files alongside SKILL.md when the model returns them', async () => {
    vi.doMock('../../src/llm/client.js', () => ({
      model: async () => ({}) as never,
    }));
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {
        ...actual,
        generateObject: async () => ({
          object: {
            name: 'unused',
            intent: 'review code',
            files: [
              {path: 'SKILL.md', content: '---\nname: unused\ndescription: Use when old\n---\n\n# Role\n\nbody'},
              {path: 'examples/notes.md', content: '# Notes\nUseful info.'},
            ],
          },
        }),
      };
    });
    const mod = await loadSkillBuilder();
    const result = await mod.createSkill({name: 'with-extras', description: 'review code'});
    const extrasPath = path.join(result.dir, 'examples', 'notes.md');
    expect(await fs.pathExists(extrasPath)).toBe(true);
    expect(await fs.readFile(extrasPath, 'utf8')).toContain('Useful info.');
  });

  it('refuses to overwrite an existing skill at the same directory', async () => {
    vi.doMock('../../src/llm/client.js', () => ({
      model: async () => ({}) as never,
    }));
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {
        ...actual,
        generateObject: async () => ({
          object: {
            name: 'unused',
            intent: 'review code',
            files: [{path: 'SKILL.md', content: '---\nname: unused\ndescription: Use when old\n---\n\n# Role\n\nbody'}],
          },
        }),
      };
    });
    const mod = await loadSkillBuilder();
    await mod.createSkill({name: 'duplicate', description: 'review code'});
    await expect(mod.createSkill({name: 'duplicate', description: 'review code'})).rejects.toThrow(/already exists/);
  });

  it('rejects an empty skill name', async () => {
    const mod = await loadSkillBuilder();
    await expect(mod.createSkill({name: '!!!', description: 'review'})).rejects.toThrow(/at least one letter or number/);
  });
});
