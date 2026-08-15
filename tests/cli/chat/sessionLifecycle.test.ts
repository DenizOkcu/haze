import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {ModelMessage} from 'ai';
import type {SessionLifecycle, SessionLifecycleDeps} from '../../../src/cli/chat/sessionLifecycle.js';
import type {Message, TokenUsage} from '../../../src/cli/commands/streaming.js';
import {EMPTY_TOKEN_USAGE} from '../../../src/cli/chat/turnState.js';

async function loadLifecycle(deps: SessionLifecycleDeps): Promise<SessionLifecycle> {
  const {createSessionLifecycle} = await import('../../../src/cli/chat/sessionLifecycle.js');
  return createSessionLifecycle(deps);
}

function makeDeps(over: Partial<SessionLifecycleDeps> = {}): SessionLifecycleDeps {
  return {
    version: 'test',
    continueSession: false,
    noSession: true,
    debug: false,
    contextFiles: () => [],
    sessionRef: {current: undefined},
    sessionRecorder: () => undefined,
    sessionStartRef: {current: new Date()},
    conversationRef: {current: []},
    workStateRef: {current: undefined},
    lastAssistantTextRef: {current: ''},
    llmLogRef: {current: undefined},
    contextFileSignaturesRef: {current: new Map()},
    setMessages: () => undefined,
    setLiveMessagesState: () => undefined,
    setTokenUsage: (_usage: TokenUsage) => undefined,
    debugLog: () => undefined,
    showPersistenceWarning: () => undefined,
    ...over,
  };
}

function history(): ModelMessage[] {
  const older = Array.from({length: 30}, (_, i) => ({role: 'user' as const, content: `older request ${i} ${'x'.repeat(80)}`}));
  return [...older, {role: 'user', content: 'the recent ask'}];
}

const recordedMessages: Message[] = [];

function recordingDeps(over: Partial<SessionLifecycleDeps> = {}): SessionLifecycleDeps {
  recordedMessages.length = 0;
  return makeDeps({
    setMessages: updater => {
      // Apply the updater to a shadow list so assertions can see appended system messages.
      const shadow = [...recordedMessages];
      const next = updater(shadow);
      recordedMessages.length = 0;
      recordedMessages.push(...next);
    },
    ...over,
  });
}

const summarizer = {mode: 'ok' as 'ok' | 'fail', calls: 0};

describe('sessionLifecycle LLM-summarized /compact (F-09)', () => {
  beforeEach(() => {
    // One switchable mock instead of re-mocking inside tests: overriding a
    // doMock from within a test body is order-sensitive when other suites have
    // touched the module registry, which made the fallback test flaky under the
    // full run.
    summarizer.mode = 'ok';
    summarizer.calls = 0;
    vi.resetModules();
    vi.doMock('../../../src/llm/client.js', () => ({
      modelWithConfig: async () => ({model: {modelId: 'test'}, config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}}}),
    }));
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      return {...actual, generateText: async (config: {prompt?: string}) => {
        summarizer.calls++;
        if (!config.prompt?.includes('<older_conversation>')) throw new Error('unexpected generateText call');
        if (summarizer.mode === 'fail') throw new Error('provider down');
        return {text: 'THE MODEL SUMMARY'};
      }};
    });
  });

  afterEach(() => {
    vi.doUnmock('ai');
    vi.doUnmock('../../../src/llm/client.js');
    vi.resetModules();
  });

  it('replaces older history with the model-written summary', async () => {
    const conversation = history();
    const deps = recordingDeps({conversationRef: {current: conversation}, noSession: true});
    const lifecycle = await loadLifecycle(deps);
    await expect(lifecycle.compactConversationWithModel('focus on decisions')).resolves.toBe(true);
    const compacted = deps.conversationRef.current;
    expect(compacted.length).toBeLessThan(conversation.length);
    const first = compacted[0] as {role: string; content: string};
    expect(first.content).toContain('<haze_compaction>');
    expect(first.content).toContain('THE MODEL SUMMARY');
    expect(compacted.at(-1)).toEqual({role: 'user', content: 'the recent ask'});
    expect(recordedMessages.some(m => m.role === 'system' && /model-written summary/.test(m.text))).toBe(true);
  });

  it('falls back to the heuristic excerpt when the summarization call fails', async () => {
    summarizer.mode = 'fail';
    const conversation = history();
    const debug: string[] = [];
    const deps = recordingDeps({conversationRef: {current: conversation}, debugLog: line => debug.push(line)});
    const lifecycle = await loadLifecycle(deps);
    await expect(lifecycle.compactConversationWithModel()).resolves.toBe(true);
    const first = deps.conversationRef.current[0] as {content: string};
    expect(first.content).toContain('Older context excerpt');
    expect(debug.some(line => /LLM compaction failed/.test(line))).toBe(true);
  });

  it('honors the heuristic setting and skips the model call entirely', async () => {
    const conversation = history();
    const deps = recordingDeps({conversationRef: {current: conversation}, manualCompaction: () => 'heuristic'});
    const lifecycle = await loadLifecycle(deps);
    await expect(lifecycle.compactConversationWithModel()).resolves.toBe(true);
    expect(summarizer.calls).toBe(0);
    const first = deps.conversationRef.current[0] as {content: string};
    expect(first.content).toContain('Older context excerpt');
  });

  it('skips compaction when there is nothing older to fold', async () => {
    const deps = recordingDeps({conversationRef: {current: [{role: 'user', content: 'only message'}]}});
    const lifecycle = await loadLifecycle(deps);
    await expect(lifecycle.compactConversationWithModel()).resolves.toBe(false);
    expect(recordedMessages.some(m => m.role === 'system' && /Compaction skipped/.test(m.text))).toBe(true);
  });

  it('keeps the sync heuristic path untouched for overflow recovery', async () => {
    const conversation = history();
    const deps = recordingDeps({conversationRef: {current: conversation}});
    const lifecycle = await loadLifecycle(deps);
    expect(lifecycle.compactConversation('auto')).toBe(true);
    const first = deps.conversationRef.current[0] as {content: string};
    expect(first.content).toContain('Older context excerpt');
    expect(EMPTY_TOKEN_USAGE.inputTokens).toBeUndefined();
  });
});
