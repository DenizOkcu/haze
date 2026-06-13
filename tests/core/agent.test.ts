import {describe, expect, it} from 'vitest';
import type {ModelMessage} from 'ai';
import {compactModelMessages, modelMessageText} from '../../src/core/agent/compaction.js';
import {createWorkState} from '../../src/core/agent/workState.js';
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

  it('uses the token budget for the recent tail and preserves structured work state', () => {
    const state = createWorkState('finish the implementation', 'implementation', ['tests pass']);
    state.files.push({path: 'src/index.ts', action: 'modified'});
    state.nextAction = 'Run npm test.';
    const messages = [
      msg('user', 'old '.repeat(200)),
      msg('assistant', 'middle '.repeat(200)),
      msg('user', 'recent request'),
      msg('assistant', 'recent answer'),
    ];
    const result = compactModelMessages(messages, {tokenBudget: 20, workState: state});
    expect(result.compacted).toBe(true);
    expect(result.keptCount).toBeGreaterThan(0);
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
    expect(result.summary).toContain('<work_state>');
    expect(result.summary).toContain('src/index.ts');
    expect(result.summary).toContain('Run npm test.');
  });

  it('extracts text from array content safely', () => {
    const message = {role: 'user', content: [{type: 'text', text: 'hello'}, {type: 'image', image: 'ignored'}]} as unknown as ModelMessage;
    expect(modelMessageText(message)).toBe('hello');
  });

  it('does not split a retained tool result from its preceding tool call', () => {
    const messages = [
      msg('user', 'old request '.repeat(100)),
      {role: 'assistant', content: [{type: 'tool-call', toolCallId: 'call-1', toolName: 'readFile', input: {path: 'a.ts'}}]},
      {role: 'tool', content: [{type: 'tool-result', toolCallId: 'call-1', toolName: 'readFile', output: {type: 'json', value: {ok: true}}}]},
    ] as unknown as ModelMessage[];
    const result = compactModelMessages(messages, {tokenBudget: 20});
    expect(result.compacted).toBe(true);
    expect(result.messages.slice(1)).toEqual(messages.slice(1));
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
