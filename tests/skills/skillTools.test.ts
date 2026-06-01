import {describe, expect, it} from 'vitest';
import {buildSkillTools, internals} from '../../src/skills/skillTools.js';
import type {SkillRegistry} from '../../src/skills/types.js';

describe('skill tools', () => {
  it('creates safe tool names', () => {
    expect(internals.toolNameForSkill('commit-changes')).toBe('skill_commit_changes');
  });

  it('builds one tool per loaded skill', async () => {
    const registry: SkillRegistry = {skills: new Map([['test-skill', {
      dir: '/tmp/test-skill',
      path: '/tmp/test-skill/SKILL.md',
      name: 'test-skill',
      description: 'Use when testing',
      body: 'Do testing things.',
      references: [{path: 'examples/a.md', absolutePath: '/tmp/test-skill/examples/a.md', content: 'Example'}],
      source: 'global',
    }]])};
    const tools = buildSkillTools(registry);
    expect(Object.keys(tools)).toEqual(['skill_test_skill']);
    const result = await tools.skill_test_skill.execute?.({reason: 'needed'}, {toolCallId: '1', messages: []} as never);
    expect(result).toMatchObject({name: 'test-skill', instructions: 'Do testing things.'});
  });
});
