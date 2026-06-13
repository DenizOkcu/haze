import {describe, expect, it} from 'vitest';
import {tool} from 'ai';
import {z} from 'zod';
import {contextBreakdown, effectiveNonCachedInput, estimateTextTokens} from '../../src/core/agent/contextBudget.js';
import {toolRequestSettings} from '../../src/core/agent/requestAssembly.js';

describe('context budget', () => {
  it('accounts for system, messages, project context, and exact tool schemas', () => {
    const tools = {sample: tool({description: 'Sample tool', inputSchema: z.object({value: z.string()})})};
    const result = contextBreakdown({
      system: 'system',
      contextFiles: [{path: 'AGENTS.md', content: 'rules'}],
      messages: [{role: 'user', content: 'hello'}],
      tools,
    });
    expect(result.system).toBe(estimateTextTokens('system'));
    expect(result.projectContext[0]?.path).toBe('AGENTS.md');
    expect(result.toolSchemas[0]?.tokens).toBeGreaterThan(0);
    expect(result.messagesByRole.user).toBeGreaterThan(0);
    expect(result.logicalInputEstimate).toBeGreaterThan(result.system);
  });

  it('calculates non-cached provider input', () => {
    expect(effectiveNonCachedInput(1000, 750)).toBe(250);
    expect(effectiveNonCachedInput(undefined, 0)).toBeUndefined();
  });

  it('omits tools entirely for text-only calls', () => {
    const settings = toolRequestSettings({sample: {}}, false);
    expect(settings).toEqual({});
    expect(toolRequestSettings({sample: {}}, true)).toHaveProperty('tools');
  });
});
