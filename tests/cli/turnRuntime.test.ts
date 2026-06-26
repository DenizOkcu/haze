import {describe, expect, it} from 'vitest';
import {extractUsage, rememberContextFilesFromToolOutput, retryDelayMs, subagentTokenEstimate} from '../../src/cli/commands/streaming/turnRuntime.js';

describe('turnRuntime', () => {
  it('caps retry delay growth', () => {
    expect(retryDelayMs(0)).toBe(1000);
    expect(retryDelayMs(1)).toBe(2000);
    expect(retryDelayMs(10)).toBe(4000);
  });

  it('normalizes provider usage details', () => {
    expect(extractUsage({usage: {inputTokens: 100, outputTokens: 20, inputTokenDetails: {cacheReadTokens: 25}, outputTokenDetails: {reasoningTokens: 3}}})).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 25,
      noCacheTokens: 75,
      effectiveNonCachedInput: 75,
      reasoningTokens: 3,
    });
  });

  it('remembers applicable scoped context files only once', () => {
    const existing = [{path: 'AGENTS.md', content: 'root'}];
    const next = rememberContextFilesFromToolOutput(existing, {
      applicableProjectInstructions: [
        {path: 'AGENTS.md', content: 'duplicate'},
        {path: 'pkg/AGENTS.md', content: 'pkg'},
        {path: 1, content: 'invalid'},
      ],
    });

    expect(next).toEqual([{path: 'AGENTS.md', content: 'root'}, {path: 'pkg/AGENTS.md', content: 'pkg'}]);
  });

  it('extracts subagent token estimates from structured outputs', () => {
    expect(subagentTokenEstimate({tokens: {in: 12, out: 3}})).toEqual({input: 12, output: 3});
    expect(subagentTokenEstimate({tokens: {in: 0, out: 0}})).toBeUndefined();
  });
});
