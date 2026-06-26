import {describe, expect, it} from 'vitest';
import {compactHomePath, estimateConversationTokens, formatTokenCount, toolCallCount} from '../../src/cli/chat/chatMetrics.js';
import type {Message} from '../../src/cli/commands/streaming.js';

describe('chat metrics', () => {
  it('counts tool calls from grouped summaries and rows', () => {
    const messages: Message[] = [
      {role: 'tool', text: 'Tools: 3 calls'},
      {role: 'tool', text: '  ✓ readFile\n  ✗ grep ×2'},
      {role: 'assistant', text: 'ignored'},
    ];
    expect(toolCallCount(messages)).toBe(6);
  });

  it('formats token counts compactly', () => {
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1_500)).toBe('1.5k');
    expect(formatTokenCount(12_500)).toBe('13k');
    expect(formatTokenCount(1_500_000)).toBe('1.5m');
  });

  it('compacts home-relative paths', () => {
    expect(compactHomePath('/Users/me/project', '/Users/me')).toBe('~/project');
    expect(compactHomePath('/tmp/project', '/Users/me')).toBe('/tmp/project');
  });

  it('estimates conversation input and output tokens by role', () => {
    expect(estimateConversationTokens([
      {role: 'user', text: 'abcd'},
      {role: 'tool', text: 'abcd'},
      {role: 'assistant', text: 'abcdefgh'},
    ])).toEqual({input: 3, output: 2});
  });
});
