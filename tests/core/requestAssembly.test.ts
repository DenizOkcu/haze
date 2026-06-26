import {describe, expect, it} from 'vitest';
import type {ModelMessage} from 'ai';
import {compactToolHistory, stripSyntheticControls, withSyntheticControl} from '../../src/core/agent/requestAssembly.js';

describe('requestAssembly', () => {
  it('replaces prior synthetic controls instead of persisting them', () => {
    const base: ModelMessage[] = [{role: 'user', content: 'real request'}];
    const first = withSyntheticControl(base, 'first nudge');
    const second = withSyntheticControl(first, 'second nudge');
    expect(second).toHaveLength(2);
    expect(second[1].content).toContain('second nudge');
    expect(JSON.stringify(second)).not.toContain('first nudge');
    expect(stripSyntheticControls(second)).toEqual(base);
  });

  it('compacts only older successful tool results and preserves protocol messages', () => {
    const messages = [
      {role: 'assistant', content: [{type: 'tool-call', toolCallId: 'old', toolName: 'readFile', input: {path: 'a.ts'}}]},
      {role: 'tool', content: [{type: 'tool-result', toolCallId: 'old', toolName: 'readFile', output: {type: 'json', value: {ok: true, path: 'a.ts', content: 'x'.repeat(2000)}}}]},
      {role: 'assistant', content: [{type: 'tool-call', toolCallId: 'failed', toolName: 'bash', input: {command: 'npm test'}}]},
      {role: 'tool', content: [{type: 'tool-result', toolCallId: 'failed', toolName: 'bash', output: {type: 'json', value: {ok: false, error: 'failure'.repeat(500)}}}]},
      {role: 'assistant', content: [{type: 'tool-call', toolCallId: 'recent', toolName: 'grep', input: {pattern: 'x'}}]},
      {role: 'tool', content: [{type: 'tool-result', toolCallId: 'recent', toolName: 'grep', output: {type: 'json', value: {ok: true, matches: ['x'.repeat(2000)]}}}]},
    ] as unknown as ModelMessage[];
    const result = compactToolHistory(messages, {keepRecentResults: 1, minResultTokens: 10});
    expect(result.compactedResults).toBe(1);
    expect(result.messages).toHaveLength(messages.length);
    expect(JSON.stringify(result.messages[1])).toContain('"compacted":true');
    expect(JSON.stringify(result.messages[3])).toContain('failurefailure');
    expect(JSON.stringify(result.messages[5])).toContain('xxxxxxxx');
  });

  it('compacts old writeFile tool-call inputs but keeps recent ones', () => {
    const bigContent = 'const x = ' + "'y'".repeat(800);
    const messages = [
      {role: 'assistant', content: [{type: 'tool-call', toolCallId: 'old1', toolName: 'writeFile', input: {path: 'src/old1.js', content: bigContent}}]},
      {role: 'tool', content: [{type: 'tool-result', toolCallId: 'old1', toolName: 'writeFile', output: {type: 'json', value: {ok: true, path: 'src/old1.js', bytes: bigContent.length}}}]},
      {role: 'assistant', content: [{type: 'tool-call', toolCallId: 'old2', toolName: 'writeFile', input: {path: 'src/old2.js', content: bigContent}}]},
      {role: 'tool', content: [{type: 'tool-result', toolCallId: 'old2', toolName: 'writeFile', output: {type: 'json', value: {ok: true, path: 'src/old2.js', bytes: bigContent.length}}}]},
      {role: 'assistant', content: [{type: 'tool-call', toolCallId: 'recent1', toolName: 'writeFile', input: {path: 'src/recent1.js', content: bigContent}}]},
      {role: 'tool', content: [{type: 'tool-result', toolCallId: 'recent1', toolName: 'writeFile', output: {type: 'json', value: {ok: true, path: 'src/recent1.js', bytes: bigContent.length}}}]},
      {role: 'assistant', content: [{type: 'tool-call', toolCallId: 'recent2', toolName: 'writeFile', input: {path: 'src/recent2.js', content: bigContent}}]},
      {role: 'tool', content: [{type: 'tool-result', toolCallId: 'recent2', toolName: 'writeFile', output: {type: 'json', value: {ok: true, path: 'src/recent2.js', bytes: bigContent.length}}}]},
    ] as unknown as ModelMessage[];
    const result = compactToolHistory(messages, {keepRecentCalls: 2, minCallTokens: 50});
    expect(result.compactedCalls).toBe(2);
    expect(result.messages).toHaveLength(messages.length);
    const old1 = JSON.stringify(result.messages[0]);
    const old2 = JSON.stringify(result.messages[2]);
    const recent1 = JSON.stringify(result.messages[4]);
    const recent2 = JSON.stringify(result.messages[6]);
    expect(old1).toContain('[Compacted:');
    expect(old1).toContain('src/old1.js');
    expect(old2).toContain('[Compacted:');
    expect(old2).toContain('src/old2.js');
    expect(recent1).toContain(bigContent);
    expect(recent2).toContain(bigContent);
  });

  it('leaves small writeFile inputs alone', () => {
    const messages = [
      {role: 'assistant', content: [{type: 'tool-call', toolCallId: 'small', toolName: 'writeFile', input: {path: 'tiny.txt', content: 'hi'}}]},
      {role: 'tool', content: [{type: 'tool-result', toolCallId: 'small', toolName: 'writeFile', output: {type: 'json', value: {ok: true}}}]},
    ] as unknown as ModelMessage[];
    const result = compactToolHistory(messages, {keepRecentCalls: 0, minCallTokens: 400});
    expect(result.compactedCalls).toBe(0);
    expect(JSON.stringify(result.messages[0])).toContain('"content":"hi"');
  });

  it('compacts old bash tool-call commands but keeps short ones intact', () => {
    const longCommand = 'node -e "const x = ' + "'a'".repeat(300) + '; console.log(x);"';
    const messages = [
      {role: 'assistant', content: [{type: 'tool-call', toolCallId: 'longbash', toolName: 'bash', input: {command: longCommand, allowMutation: false}}]},
      {role: 'tool', content: [{type: 'tool-result', toolCallId: 'longbash', toolName: 'bash', output: {type: 'json', value: {ok: true, code: 0}}}]},
      {role: 'assistant', content: [{type: 'tool-call', toolCallId: 'shortbash', toolName: 'bash', input: {command: 'npm test', allowMutation: false}}]},
      {role: 'tool', content: [{type: 'tool-result', toolCallId: 'shortbash', toolName: 'bash', output: {type: 'json', value: {ok: true, code: 0}}}]},
    ] as unknown as ModelMessage[];
    const result = compactToolHistory(messages, {keepRecentCalls: 0, minCallTokens: 50});
    expect(result.compactedCalls).toBe(1);
    const longJson = JSON.stringify(result.messages[0]);
    const shortJson = JSON.stringify(result.messages[2]);
    expect(longJson).toContain('more chars compacted');
    expect(longJson).not.toContain("'a'".repeat(300));
    expect(shortJson).toContain('"command":"npm test"');
  });
});
