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
    expect(generated.files[0]?.content).toContain('# Goal');
    expect(generated.files[0]?.content).toContain('# Inputs to inspect');
    expect(generated.files[0]?.content).toContain('# Stop conditions');
    expect(generated.files[0]?.content).toContain('# Operational guardrails');
  });

  it('appends standard requirements to generated SKILL.md content', () => {
    const content = internals.withStandardRequirements('---\nname: test\ndescription: Use when testing\n---\n\n# Trigger\n\nTest.');
    expect(content).toContain('# Operational guardrails');
    expect(content).toContain('Only call something a blocker');
    expect(content).toContain('Truncated output is not a blocker');
  });

  it('skill creator prompt asks for intent, fallbacks, truncation handling, and blocker policy', () => {
    expect(internals.SKILL_CREATOR_SKILL).toContain('user\'s underlying intent');
    expect(internals.SKILL_CREATOR_SKILL).toContain('fallback paths');
    expect(internals.SKILL_CREATOR_SKILL).toContain('truncated command');
    expect(internals.SKILL_CREATOR_SKILL).toContain('Blocker policy');
  });
});
