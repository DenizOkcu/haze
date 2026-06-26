import {describe, expect, it} from 'vitest';
import {captureSkillDescription, skillCreationFailure, skillCreationMessage} from '../../src/cli/commands/skillCreation.js';

describe('skill creation', () => {
  it('rejects empty descriptions', () => {
    expect(captureSkillDescription('   ', 'name')).toMatchObject({message: expect.stringContaining('Description is required')});
  });

  it('reports when the draft name is lost', () => {
    expect(captureSkillDescription('desc', undefined)).toMatchObject({mode: 'chat', message: expect.stringContaining('lost the name')});
  });

  it('returns a busy creation when valid', () => {
    expect(captureSkillDescription('desc', 'name')).toMatchObject({description: 'desc', draftName: 'name', busy: true});
  });

  it('formats success and failure messages', () => {
    expect(skillCreationMessage('a', '/tmp/a/SKILL.md')).toBe('Created skill a at /tmp/a/SKILL.md. Invoke it with /a. Edit SKILL.md to refine its workflow.');
    expect(skillCreationFailure(new Error('boom'))).toBe('Skill creation failed: boom');
    expect(skillCreationFailure('oops')).toBe('Skill creation failed: oops');
  });
});