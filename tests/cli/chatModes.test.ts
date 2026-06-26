import {describe, expect, it} from 'vitest';
import {MASKED_MODES, PICKER_MODES, SUBMIT_EMPTY_MODES, placeholderForMode} from '../../src/cli/commands/chatModes.js';

describe('chatModes', () => {
  it('keeps modal input behavior grouped outside ChatScreen', () => {
    expect(PICKER_MODES.has('provider')).toBe(true);
    expect(PICKER_MODES.has('mcpAddTransport')).toBe(true);
    expect(MASKED_MODES.has('providerSetKey')).toBe(true);
    expect(SUBMIT_EMPTY_MODES.has('mcpAddKey')).toBe(true);
  });

  it('returns mode-specific and fallback placeholders', () => {
    expect(placeholderForMode('providerAddUrl', false)).toBe('https://example.com/v1');
    expect(placeholderForMode('chat', false)).toBe('Ask Haze to help build your app');
    expect(placeholderForMode('chat', true)).toBe('Queue a follow-up, or Esc to interrupt');
  });
});
