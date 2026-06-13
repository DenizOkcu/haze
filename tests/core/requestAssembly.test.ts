import {describe, expect, it} from 'vitest';
import type {ModelMessage} from 'ai';
import {compactToolHistory, stripSyntheticControls, toolRequestSettings, withSyntheticControl} from '../../src/core/agent/requestAssembly.js';

describe('toolRequestSettings', () => {
  it('omits tool schemas when a continuation cannot call tools', () => {
    expect(toolRequestSettings({readFile: {description: 'read'}} as never, false)).toEqual({});
  });

  it('attaches tools only to tool-capable requests', () => {
    const tools = {readFile: {description: 'read'}} as never;
    expect(toolRequestSettings(tools, true)).toEqual({tools, toolChoice: 'auto'});
  });

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
});
