import {describe, expect, it} from 'vitest';
import {agentEvent, type AgentEventInput} from '../../src/core/agent/events.js';

describe('agentEvent', () => {
  it('stamps turn_start with a current ISO timestamp', () => {
    const before = Date.now();
    const event = agentEvent({type: 'turn_start', request: 'hello'});
    const after = Date.now();
    expect(event.type).toBe('turn_start');
    expect(event.request).toBe('hello');
    const stampedAt = Date.parse(event.at);
    expect(stampedAt).toBeGreaterThanOrEqual(before);
    expect(stampedAt).toBeLessThanOrEqual(after + 5);
  });

  it('preserves every input field and only adds the at field', () => {
    const input: AgentEventInput = {
      type: 'tool_end',
      id: 'call-1',
      name: 'readFile',
      success: false,
      error: new Error('boom'),
      durationMs: 42,
    };
    const event = agentEvent(input);
    expect(event).toMatchObject({type: 'tool_end', id: 'call-1', name: 'readFile', success: false, durationMs: 42, error: input.error});
    expect(typeof event.at).toBe('string');
  });

  it('produces strictly monotonic timestamps across rapid calls', async () => {
    const first = agentEvent({type: 'message_start', id: 'm1', role: 'assistant'});
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = agentEvent({type: 'message_start', id: 'm2', role: 'assistant'});
    expect(Date.parse(second.at)).toBeGreaterThan(Date.parse(first.at));
  });
});
