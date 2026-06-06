import {describe, expect, it} from 'vitest';
import type {ModelMessage} from 'ai';
import {compactModelMessages, modelMessageText} from '../../src/core/agent/compaction.js';
import {isContextOverflowError, isRetryableModelError} from '../../src/core/agent/errors.js';

function msg(role: 'user' | 'assistant' | 'system', content: string): ModelMessage {
  return {role, content};
}

describe('agent compaction', () => {
  it('does not compact when message count is below threshold', () => {
    const messages = [msg('user', 'hello'), msg('assistant', 'hi')];
    const result = compactModelMessages(messages, {keepRecentMessages: 3});
    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
    expect(result.keptCount).toBe(2);
  });

  it('adds a summary system message and keeps the recent tail', () => {
    const messages = [
      msg('user', 'old request'),
      msg('assistant', 'old answer'),
      msg('user', 'recent request'),
      msg('assistant', 'recent answer'),
    ];
    const result = compactModelMessages(messages, {keepRecentMessages: 2});
    expect(result.compacted).toBe(true);
    expect(result.olderCount).toBe(2);
    expect(result.keptCount).toBe(2);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toMatchObject({role: 'system'});
    expect(modelMessageText(result.messages[0])).toContain('old request');
    expect(result.messages.slice(1)).toEqual(messages.slice(-2));
  });

  it('includes optional compaction instructions', () => {
    const result = compactModelMessages([
      msg('user', 'a'),
      msg('assistant', 'b'),
      msg('user', 'c'),
    ], {keepRecentMessages: 1, instructions: 'keep validation details'});
    expect(result.summary).toContain('keep validation details');
  });

  it('extracts text from array content safely', () => {
    const message = {role: 'user', content: [{type: 'text', text: 'hello'}, {type: 'image', image: 'ignored'}]} as unknown as ModelMessage;
    expect(modelMessageText(message)).toBe('hello');
  });
});

describe('agent provider error classification', () => {
  it('detects context overflow errors', () => {
    expect(isContextOverflowError(new Error('maximum context length exceeded'))).toBe(true);
    expect(isContextOverflowError('input too long: too many tokens')).toBe(true);
  });

  it('separates retryable transient errors from account/request errors', () => {
    expect(isRetryableModelError(new Error('503 provider overloaded'))).toBe(true);
    expect(isRetryableModelError(new Error('network connection lost'))).toBe(true);
    expect(isRetryableModelError(new Error('insufficient quota'))).toBe(false);
    expect(isRetryableModelError(new Error('invalid api key'))).toBe(false);
    expect(isRetryableModelError(new Error('maximum context length exceeded'))).toBe(false);
  });
});
