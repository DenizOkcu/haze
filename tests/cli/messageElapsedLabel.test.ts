import {describe, expect, it} from 'vitest';
import {messageElapsedLabel} from '../../src/cli/chat/messages.js';

describe('messageElapsedLabel substance guard', () => {
  const base = {role: 'assistant' as const, startedAt: 1_000, finishedAt: 2_000, tokensPerSecond: 50};

  it('suppresses the header for non-substantive finished fragments', () => {
    expect(messageElapsedLabel({...base, text: 'Let me read', streaming: false})).toBe('');
    expect(messageElapsedLabel({...base, text: 'Good', streaming: false})).toBe('');
  });

  it('keeps the header for substantive answers', () => {
    expect(messageElapsedLabel({...base, text: 'Done.', streaming: false})).not.toBe('');
    expect(messageElapsedLabel({...base, text: 'I rewrote the parser and all tests pass.', streaming: false})).not.toBe('');
  });

  it('always keeps the streaming label', () => {
    expect(messageElapsedLabel({...base, text: 'Let me', streaming: true, finishedAt: undefined})).not.toBe('');
  });
});
