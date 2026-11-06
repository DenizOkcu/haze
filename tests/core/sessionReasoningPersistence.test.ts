import {expect, it} from 'vitest';
import {prepareSessionEntryForWrite} from '../../src/core/session/sessionSlimming.js';

it('preserves long reasoning content and opaque provider metadata in snapshots', () => {
  const long = 'x'.repeat(12000);
  const message = {role: 'assistant' as const, content: [{type: 'reasoning' as const, text: long, providerOptions: {openrouter: {reasoning_details: [{type: 'reasoning.encrypted', data: long}]}}}]};
  const entry = {type: 'conversation_snapshot' as const, at: 'now', messages: [message]};
  expect(prepareSessionEntryForWrite(entry)).toEqual(entry);
});
