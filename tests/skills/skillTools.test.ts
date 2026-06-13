import {describe, expect, it} from 'vitest';
import {buildSkillTools} from '../../src/skills/skillTools.js';
import type {SkillRegistry} from '../../src/skills/types.js';

describe('buildSkillTools', () => {
  it('uses one catalog tool and loads references progressively', async () => {
    const registry: SkillRegistry = {skills: new Map([['test-skill', {
      name: 'test-skill',
      description: 'Use when testing.',
      body: 'Follow this workflow.',
      dir: '/tmp/test-skill',
      path: '/tmp/test-skill/SKILL.md',
      source: 'global',
      references: [{path: 'references/details.md', absolutePath: '/tmp/test-skill/references/details.md', content: 'Details'}],
    }]])};
    const tools = buildSkillTools(registry);
    expect(Object.keys(tools)).toEqual(['skill']);
    const instructions = await tools.skill?.execute?.({name: 'test-skill'}, {toolCallId: '1', messages: []} as never) as Record<string, unknown>;
    expect(instructions.instructions).toBe('Follow this workflow.');
    expect(instructions.references).toEqual(['references/details.md']);
    expect(instructions).not.toHaveProperty('content');
    const reference = await tools.skill?.execute?.({name: 'test-skill', reference: 'references/details.md'}, {toolCallId: '2', messages: []} as never) as {reference: {content: string}};
    expect(reference.reference.content).toBe('Details');
  });

  it('returns no tool for an empty registry', () => {
    expect(buildSkillTools({skills: new Map()})).toEqual({});
  });
});
