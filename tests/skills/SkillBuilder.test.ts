import {describe, expect, it} from 'vitest';
import {internals} from '../../src/skills/builder/SkillBuilder.js';

describe('SkillBuilder', () => {
  it('parses generated JSON skill output', () => {
    const generated = internals.parseGeneratedSkill(JSON.stringify({
      name: 'Reviewer Skill',
      files: [{path: 'SKILL.md', content: '---\nname: reviewer\ndescription: Use when reviewing code\n---\n'}],
    }), 'review code');
    expect(generated.name).toBe('reviewer-skill');
    expect(generated.files).toHaveLength(1);
  });

  it('fallback skill is markdown with predictable workflow sections', () => {
    const generated = internals.fallbackSkill('review code');
    expect(generated.files[0]?.path).toBe('SKILL.md');
    expect(generated.files[0]?.content).toContain('---\nname: review-code');
    expect(generated.files[0]?.content).toContain('# Role');
    expect(generated.files[0]?.content).toContain('# Focused prompt');
    expect(generated.files[0]?.content).toContain('# Inputs to inspect');
    expect(generated.files[0]?.content).toContain('# Stop conditions');
    expect(generated.files[0]?.content).toContain('# Output template');
    expect(generated.files[0]?.content).toContain('# Operating rules');
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
});
