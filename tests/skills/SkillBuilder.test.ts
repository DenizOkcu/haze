import {describe, expect, it} from 'vitest';
import {internals} from '../../src/skills/builder/SkillBuilder.js';

describe('SkillBuilder', () => {
  it('parses generated JSON skill output', () => {
    const generated = internals.parseGeneratedSkill(JSON.stringify({
      name: 'Reviewer Skill',
      intent: 'security review',
      files: [{path: 'SKILL.md', content: '---\nname: reviewer\ndescription: Use when reviewing code\n---\n'}],
    }), 'create a security review skill');
    expect(generated.name).toBe('reviewer-skill');
    expect(generated.intent).toBe('security review');
    expect(generated.files).toHaveLength(1);
  });

  it('falls back to the description as intent when the model omits intent', () => {
    const generated = internals.parseGeneratedSkill(JSON.stringify({
      name: 'reviewer',
      files: [{path: 'SKILL.md', content: '---\nname: reviewer\ndescription: Use when reviewing code\n---\n'}],
    }), 'review code');
    expect(generated.intent).toBe('review code');
  });

  it('fallback skill is markdown with predictable workflow sections', () => {
    const generated = internals.fallbackSkill({name: 'review-code', description: 'review code'});
    expect(generated.files[0]?.path).toBe('SKILL.md');
    expect(generated.files[0]?.content).toContain('---\nname: review-code');
    expect(generated.files[0]?.content).toContain('# Role');
    expect(generated.files[0]?.content).toContain('# Focused prompt');
    expect(generated.files[0]?.content).toContain('# Inputs to inspect');
    expect(generated.files[0]?.content).toContain('# Stop conditions');
    expect(generated.files[0]?.content).toContain('# Output template');
    expect(generated.files[0]?.content).toContain('# Operating rules');
  });

  it('fallback skill honors a user-provided role verbatim', () => {
    const generated = internals.fallbackSkill({name: 'pr-reviewer', role: 'Staff security engineer', description: 'review PRs'});
    expect(generated.files[0]?.content).toContain('---\nname: pr-reviewer');
    expect(generated.files[0]?.content).toContain('# Role\n\nStaff security engineer');
  });

  it('toSkillDirName kebab-cases user input without stripping stop words', () => {
    expect(internals.toSkillDirName('Security Review')).toBe('security-review');
    expect(internals.toSkillDirName('  Hello   World! ')).toBe('hello-world');
    expect(internals.toSkillDirName('create-a-skill')).toBe('create-a-skill');
    expect(internals.toSkillDirName('!!!')).toBe('');
    expect(internals.toSkillDirName('PR_Reviewer')).toBe('pr-reviewer');
  });

  it('appends standard requirements to generated SKILL.md content', () => {
    const content = internals.withStandardRequirements('---\nname: test\ndescription: Use when testing\n---\n\n# Trigger\n\nTest.');
    expect(content).toContain('# Operating rules');
    expect(content).toContain('Only call something a blocker');
    expect(content).toContain('Truncated output is not a blocker');
  });

  it('skill creator prompt asks for role, focused prompt, fallbacks, truncation handling, and blocker policy', () => {
    expect(internals.SKILL_CREATOR_SKILL).toContain('Role');
    expect(internals.SKILL_CREATOR_SKILL).toContain('Focused prompt');
    expect(internals.SKILL_CREATOR_SKILL).toContain('Output template');
    expect(internals.SKILL_CREATOR_SKILL).toContain('fallback paths');
    expect(internals.SKILL_CREATOR_SKILL).toContain('truncated command');
    expect(internals.SKILL_CREATOR_SKILL).toContain('Blocker policy');
  });

  it('skill creator prompt teaches intent extraction in any language, not English-only regex bait', () => {
    expect(internals.SKILL_CREATOR_SKILL).toContain('any language');
    expect(internals.SKILL_CREATOR_SKILL).toContain('meta-framing');
    expect(internals.SKILL_CREATOR_SKILL).toContain('security review skill');
  });
});
