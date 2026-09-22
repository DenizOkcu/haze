import {describe, expect, it, vi} from 'vitest';
import type {StreamCallbacks} from '../../../../src/cli/commands/streaming.js';
import {createQuarantinableCallbacks} from '../../../../src/cli/commands/streaming/attemptLifecycle.js';

 describe('callback quarantine', () => {
  it('blocks every state mutation, including durable compaction records', () => {
    const callbacks = {
      addMessage: vi.fn(), updateMessage: vi.fn(), setConversation: vi.fn(),
      setBusy: vi.fn(), setBusyLabel: vi.fn(), setLastAssistantText: vi.fn(),
      setAbortController: vi.fn(), setGoalStatus: vi.fn(), onEvent: vi.fn(),
      compactConversation: vi.fn(() => true), recordCompaction: vi.fn(),
      recordTokenUsage: vi.fn(), setWorkState: vi.fn(), onTasksChanged: vi.fn(),
      debugLog: vi.fn(), getConversation: vi.fn(() => []), getLastAssistantText: vi.fn(() => ''),
      log: undefined, contextFileSignatures: new Map<string, string>(),
    } satisfies Record<keyof StreamCallbacks, unknown>;
    const guard = createQuarantinableCallbacks(callbacks);
    guard.callbacks.recordCompaction?.({method: 'llm', olderCount: 1, keptCount: 1, summary: 'before'});
    expect(callbacks.recordCompaction).toHaveBeenCalledOnce();
    vi.clearAllMocks();
    guard.quarantine();
    const readOnly = new Set(['debugLog', 'getConversation', 'getLastAssistantText']);
    for (const [key, callback] of Object.entries(guard.callbacks)) {
      if (typeof callback === 'function' && !readOnly.has(key)) {
        // Quarantined callbacks must not inspect arguments or call their owners.
        Reflect.apply(callback, undefined, []);
        expect(callbacks[key as keyof typeof callbacks]).not.toHaveBeenCalled();
      }
    }
    expect(guard.callbacks.compactConversation?.()).toBe(false);
    expect(guard.callbacks.getConversation()).toEqual([]);
    expect(callbacks.getConversation).toHaveBeenCalledOnce();
  });
});
