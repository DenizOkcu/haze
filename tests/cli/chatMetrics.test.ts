import {describe, expect, it} from 'vitest';
import {compactHomePath, estimateConversationTokens, formatTokenCount, statusBarMetrics, toolCallCount} from '../../src/cli/chat/chatMetrics.js';
import {EMPTY_TOKEN_USAGE} from '../../src/cli/chat/turnState.js';
import type {Message} from '../../src/cli/commands/streaming.js';

describe('chat metrics', () => {
  it('prefers the structured toolCount carried by live tool groups', () => {
    const messages: Message[] = [
      {role: 'tool', text: '3 calls · 1 changes · 2s', toolCount: 3},
      {role: 'tool', text: 'any future caption format', toolCount: 5},
      {role: 'assistant', text: 'ignored'},
    ];
    expect(toolCallCount(messages)).toBe(8);
  });

  it('falls back to counting rendered rows for restored historical transcripts', () => {
    const messages: Message[] = [
      {role: 'tool', text: '1 calls · 0 changes · 1s\n  ✓ readFile — ok\n  ✗ grep — error'},
    ];
    expect(toolCallCount(messages)).toBe(2);
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

  it('computes the status-bar detail label from structured metrics', () => {
    const metrics = statusBarMetrics({
      messages: [
        {role: 'assistant', text: 'answer'},
        {role: 'tool', text: '2 calls · 0 changes · 1s', toolCount: 2},
      ],
      tokenUsage: {...EMPTY_TOKEN_USAGE, inputTokens: 100, outputTokens: 50},
      enabledSkillCount: 1,
    });
    expect(metrics.statusDetailLabel).toBe('1 haze message / 2 tool calls / LLM ↑100 ↓50 / 1 skill');
    expect(metrics.inputEstimated).toBe(false);
    expect(metrics.outputEstimated).toBe(false);
    expect(metrics.hasTokenBreakdown).toBe(true);
  });

  it('shows live background process count only when nonzero (F09)', () => {
    const base = {messages: [], tokenUsage: {...EMPTY_TOKEN_USAGE}, enabledSkillCount: 0};
    expect(statusBarMetrics({...base, backgroundProcessCount: 2}).statusDetailLabel).toContain('⏵ 2 bg');
    expect(statusBarMetrics({...base, backgroundProcessCount: 0}).statusDetailLabel).not.toContain(' bg');
  });
});
