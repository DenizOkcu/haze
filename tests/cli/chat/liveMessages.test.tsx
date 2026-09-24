import React from 'react';
import {describe, expect, it} from 'vitest';
import {render} from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import {useLiveMessages} from '../../../src/cli/chat/liveMessages.js';
import type {Message} from '../../../src/cli/commands/streaming.js';

/**
 * Harness that mirrors ChatScreen's callback wiring: streaming adds/updates
 * go through the live-tail store; settled messages are finalized into a
 * plain transcript array. All state transitions happen synchronously — the
 * same window a fast model stream produces before React flushes a batch.
 */
function setupHarness() {
  const finalized: Message[] = [];
  let store: ReturnType<typeof useLiveMessages>;
  function Probe() {
    // Mirrors ChatScreen.finalizeMessage: hidden fragments are dropped, not recorded.
    store = useLiveMessages(message => {
      if (message.hidden) return;
      finalized.push(message);
    });
    return null;
  }
  render(<Probe />);
  return {
    addStreaming: (message: Message) => store.addStreaming(message),
    patch: (id: string, update: Partial<Message>) => store.patch(id, update),
    drain: () => store.drain(),
    finalized,
    tailFrame: () => finalized.map(message => message.text),
  };
}

describe('live-tail store', () => {
  it('routes a synchronous add → deltas → finalize burst without losing text', () => {
    const harness = setupHarness();
    // One synchronous burst, as a buffered stream delivers it inside a single
    // React batch window: the add, two deltas, then the finalize.
    harness.addStreaming({id: 'a1', role: 'assistant', text: 'Down to', streaming: true, startedAt: 1_000});
    harness.patch('a1', {text: 'Down to a'});
    harness.patch('a1', {text: 'Down to a single pass.'});
    harness.patch('a1', {text: 'Down to a single pass.', streaming: false, finishedAt: 1_200});

    expect(harness.finalized).toHaveLength(1);
    expect(harness.finalized[0]).toMatchObject({id: 'a1', text: 'Down to a single pass.', streaming: false});
  });

  it('keeps deltas routing to the live tail across interleaved tool-group updates', () => {
    const harness = setupHarness();
    harness.addStreaming({id: 'a1', role: 'assistant', text: 'Checking', streaming: true, startedAt: 1_000});
    harness.addStreaming({id: 'tool-1', role: 'tool', text: '1 calls · 0s', streaming: true});
    harness.patch('a1', {text: 'Checking the fix.'});
    harness.patch('tool-1', {text: '1 calls · 1s', streaming: false});
    harness.patch('a1', {text: 'Checking the fix.', streaming: false, finishedAt: 2_000});

    expect(harness.finalized.map(message => message.id)).toEqual(['tool-1', 'a1']);
    expect(harness.finalized[1]).toMatchObject({text: 'Checking the fix.'});
  });

  it('drains still-streaming messages at the turn boundary, finalizing them verbatim', () => {
    const harness = setupHarness();
    harness.addStreaming({id: 'a1', role: 'assistant', text: 'Isolation pass confirms', streaming: true, startedAt: 1_000});
    harness.addStreaming({id: 'tool-1', role: 'tool', text: '1 calls · 0s', streaming: true});
    harness.drain();

    expect(harness.finalized.map(message => message.id)).toEqual(['a1', 'tool-1']);
    expect(harness.finalized.every(message => message.streaming === false)).toBe(true);
    // Re-draining is a no-op.
    harness.drain();
    expect(harness.finalized).toHaveLength(2);
  });

  it('drops hidden finalizations and keeps draining the remaining tail', () => {
    const harness = setupHarness();
    harness.addStreaming({id: 'a1', role: 'assistant', text: 'lead-in', streaming: true});
    harness.patch('a1', {text: 'lead-in', streaming: false, hidden: true});
    expect(harness.finalized).toHaveLength(0);
    harness.addStreaming({id: 'tool-1', role: 'tool', text: '1 calls · 0s', streaming: true});
    harness.drain();
    expect(harness.finalized.filter(message => message.id === 'tool-1')).toHaveLength(1);
  });
});

describe('live-tail rendering', () => {
  it('a finalized streaming message enters the transcript with its full text', () => {
    const harness = setupHarness();
    harness.addStreaming({id: 'a1', role: 'assistant', text: 'Done.', streaming: true, startedAt: 1_000});
    harness.patch('a1', {streaming: false, finishedAt: 1_100});
    const frame = stripAnsi(harness.finalized.map(message => `haze\n${message.text}`).join('\n'));
    expect(frame).toContain('Done.');
    expect(frame).not.toContain('0s');
  });
});
