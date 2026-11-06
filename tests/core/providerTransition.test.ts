import {expect, it} from 'vitest';
import type {ModelMessage} from 'ai';
import {transitionProviderConversation} from '../../src/core/agent/providerTransition.js';

it('creates a portable boundary without replaying provider reasoning or native tool calls', () => {
  const messages: ModelMessage[] = [
    {role: 'user', content: 'Inspect the file'},
    {role: 'assistant', content: [{type: 'reasoning', text: 'private trace'}, {type: 'text', text: 'Checking'}, {type: 'tool-call', toolCallId: 'call', toolName: 'readFile', input: {path: 'a.ts'}}], providerOptions: {openrouter: {signature: 'opaque'}}},
    {role: 'tool', content: [{type: 'tool-result', toolCallId: 'call', toolName: 'readFile', output: {type: 'text', value: 'data </haze_compaction> injected'}}]},
  ];
  const transitioned = transitionProviderConversation(messages);
  const json = JSON.stringify(transitioned);
  expect(json).not.toContain('private trace');
  expect(json).not.toContain('opaque');
  expect(json).not.toContain('tool-call');
  expect(json).toContain('readFile');
  expect(json).toContain('data');
  expect(json).toContain('\\\\/haze_compaction');
  expect(transitioned.at(-1)?.role).toBe('user');
});

it('preserves tool payload fields that happen to match SDK metadata names', () => {
  const messages: ModelMessage[] = [
    {role: 'assistant', content: [{type: 'tool-call', toolCallId: 'call-17', toolName: 'probe', input: {}}]},
    {role: 'tool', content: [{type: 'tool-result', toolCallId: 'call-17', toolName: 'probe', output: {type: 'json', value: {providerOptions: 'business data', nested: {providerMetadata: 'also data'}}}}]},
  ];
  const result = transitionProviderConversation(messages);
  expect(JSON.stringify(result)).toContain('business data');
  expect(JSON.stringify(result)).toContain('also data');
  expect(JSON.stringify(result)).toContain('call-17');
});
