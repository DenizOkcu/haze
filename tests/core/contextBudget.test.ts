import {describe, expect, it} from 'vitest';
import {tool} from 'ai';
import {z} from 'zod';
import {cacheHitRatio, contextBreakdown, effectiveNonCachedInput, estimateTextTokens, estimateValueTokens, IMAGE_BYTES_PER_TOKEN_ESTIMATE} from '../../src/core/agent/contextBudget.js';

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

  it('calculates cache hit ratio', () => {
    expect(cacheHitRatio(10000, 9500)).toBeCloseTo(0.95, 5);
    expect(cacheHitRatio(10743, 512)).toBeCloseTo(0.0477, 3);
    expect(cacheHitRatio(undefined, 1000)).toBeUndefined();
    expect(cacheHitRatio(1000, undefined)).toBeUndefined();
    expect(cacheHitRatio(0, 0)).toBeUndefined();
    expect(cacheHitRatio(1000, 0)).toBeUndefined();
  });

  it('estimates image file parts from byte size instead of serializing bytes (F03)', () => {
    const bytes = IMAGE_BYTES_PER_TOKEN_ESTIMATE * 100;
    const part = {type: 'file', mediaType: 'image/png', data: new Uint8Array(bytes)};
    expect(estimateValueTokens(part)).toBe(100);
    // Tagged data shape and base64 strings are handled too.
    expect(estimateValueTokens({type: 'file', mediaType: 'image/jpeg', data: {type: 'data', data: new Uint8Array(bytes)}})).toBe(100);
    expect(estimateValueTokens({type: 'file', mediaType: 'image/png', data: 'A'.repeat(400)})).toBe(1);
  });

  it('counts image parts in user messages without serializing the payload (F03)', () => {
    const message = {
      role: 'user',
      content: [
        {type: 'text', text: 'fix this layout'},
        {type: 'file', mediaType: 'image/png', data: new Uint8Array(IMAGE_BYTES_PER_TOKEN_ESTIMATE * 200), filename: 'shot.png'},
      ],
    };
    const tokens = estimateValueTokens(message);
    // Text envelope + text part + the 200-token image estimate: nowhere near
    // the millions of tokens a serialized payload would imply.
    expect(tokens).toBeGreaterThan(200);
    expect(tokens).toBeLessThan(400);
  });
});
