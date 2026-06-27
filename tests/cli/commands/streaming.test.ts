import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

interface FakeFullStreamPart {
  type: string;
  [key: string]: unknown;
}

interface FakeAgent {
  streamArgs: Array<{messages: unknown[]; abortSignal: AbortSignal}>;
  fullStream: AsyncIterable<FakeFullStreamPart>;
  response: Promise<{messages: unknown[]}>;
  options: Record<string, unknown>;
  prepareStep: ((args: unknown) => unknown) | undefined;
  onStepFinish: ((args: unknown) => void) | undefined;
  onFinish: ((event: {totalUsage?: unknown; usage?: unknown; response: {messages: unknown[]}}) => void) | undefined;
}

interface FakeModelHandle {
  model: unknown;
  config: {providerName: string; baseURL: string; modelName: string; cacheKey: string; capabilities: Record<string, boolean>};
}

interface MocksConfig {
  modelHandle: FakeModelHandle | undefined;
  contextOverflow?: boolean;
  retryable?: boolean;
  fullStreamParts?: FakeFullStreamPart[];
  responseMessages?: unknown[];
  failFirstNAgents?: number;
  idle?: boolean;
  hangUntilAbort?: boolean;
}

const mocks = vi.hoisted(() => {
  return {
    assembledCalls: [] as unknown[],
    closeMcpCalls: [] as unknown[],
    assembleContextResult: null as null | {
      systemPrompt: string;
      availableTools: Record<string, unknown>;
      toolCategories: Map<string, string>;
      loadedMcp?: {clients: Array<{close: () => Promise<void>} | {close: () => Promise<void>}>; tools: Record<string, unknown>; errors: string[]};
    },
  };
});

function makeAgent(parts: FakeFullStreamPart[], responseMessages: unknown[]): FakeAgent {
  const agent: FakeAgent = {
    streamArgs: [],
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
    response: Promise.resolve({messages: responseMessages}),
    options: {},
    prepareStep: undefined,
    onStepFinish: undefined,
    onFinish: undefined,
  };
  return agent;
}

async function loadStreaming(config: MocksConfig) {
  const parts = config.fullStreamParts ?? [];
  const responseMessages = config.responseMessages ?? [];
  let agentCallCount = 0;

  vi.doMock('../../../src/llm/client.js', () => ({
    modelWithConfig: async () => config.modelHandle ?? undefined,
    providerRequestSettings: () => ({}),
  }));

  vi.doMock('../../../src/llm/requestContext.js', () => ({
    assembleRequestContext: async () => {
      mocks.assembledCalls.push(Date.now());
      return mocks.assembleContextResult ?? {
        systemPrompt: 'You are Haze.',
        availableTools: {bash: {description: 'bash', execute: async () => ({ok: true})}},
        toolCategories: new Map([['bash', 'builtin']]),
      };
    },
  }));

  vi.doMock('../../../src/llm/mcp.js', () => ({
    closeMcpClients: async (clients: unknown) => {
      mocks.closeMcpCalls.push(clients);
    },
  }));

  vi.doMock('ai', async () => {
    const actual = await vi.importActual<typeof import('ai')>('ai');
    class FakeToolLoopAgent {
      options: Record<string, unknown>;
      prepareStep: ((args: unknown) => unknown) | undefined;
      onStepFinish: ((args: unknown) => void) | undefined;
      onFinish: ((event: unknown) => void) | undefined;
      _fake: FakeAgent;
      constructor(options: Record<string, unknown>) {
        this.options = options;
        this.prepareStep = options.prepareStep as never;
        this.onStepFinish = options.onStepFinish as never;
        this.onFinish = options.onFinish as never;
        this._fake = makeAgent(parts, responseMessages);
      }
      stream({messages, abortSignal}: {messages: unknown[]; abortSignal: AbortSignal}) {
        agentCallCount += 1;
        const isFirstCall = agentCallCount === 1;
        this._fake.streamArgs.push({messages, abortSignal});
        this._fake.options = this.options;
        this._fake.prepareStep = this.prepareStep;
        this._fake.onStepFinish = this.onStepFinish;
        this._fake.onFinish = this.onFinish;
        if (config.hangUntilAbort) {
          let onAbort: (() => void) | undefined;
          const aborted = new Error('aborted');
          const waitForAbort = new Promise<void>((resolve) => {
            onAbort = () => resolve();
            if (abortSignal.aborted) resolve();
            else abortSignal.addEventListener('abort', onAbort);
          });
          const cleanup = () => {
            if (onAbort && !abortSignal.aborted) abortSignal.removeEventListener('abort', onAbort);
          };
          void waitForAbort.then(cleanup, cleanup);
          const streamAbort = async function* () {
            await waitForAbort;
            cleanup();
            throw aborted;
          };
          return {
            fullStream: streamAbort(),
            response: waitForAbort.then(() => {
              cleanup();
              return {messages: []};
            }),
          };
        }
        if (isFirstCall && config.contextOverflow) {
          const error = new Error('Request exceeds maximum context length');
          (error as Error & {cause?: unknown}).cause = 'context';
          return {
            fullStream: (async function* () {
              yield {type: 'error', error};
            })(),
            response: Promise.reject(error),
          };
        }
        if (isFirstCall && config.retryable) {
          const error = new Error('Service overloaded (503)');
          return {
            fullStream: (async function* () {
              yield {type: 'error', error};
            })(),
            response: Promise.reject(error),
          };
        }
        return {...this._fake, fullStream: this._fake.fullStream, response: this._fake.response};
      }
    }
    return {
      ...actual,
      ToolLoopAgent: FakeToolLoopAgent,
      stepCountIs: (n: number) => ({steps: n}),
    };
  });

  vi.resetModules();
  return import('../../../src/cli/commands/streaming.js');
}

function makeCallbacks() {
  const messages: Array<{role: string; text: string; id?: string}> = [];
  const events: Array<{type: string}> = [];
  const debug: string[] = [];
  const conversationSets: unknown[][] = [];
  let busy = false;
  let lastAssistantText = '';
  return {
    addMessage: (msg: {id?: string; role: string; text: string}) => {
      messages.push(msg);
    },
    updateMessage: () => undefined,
    setConversation: (msgs: unknown[]) => {
      conversationSets.push(msgs);
    },
    setBusy: (b: boolean) => {
      busy = b;
    },
    debugLog: (line: string) => {
      debug.push(line);
    },
    getConversation: () => [],
    getLastAssistantText: () => lastAssistantText,
    setLastAssistantText: (text: string) => {
      lastAssistantText = text;
    },
    onEvent: (event: {type: string}) => {
      events.push(event);
    },
    recordTokenUsage: () => undefined,
    setGoalStatus: () => undefined,
    setWorkState: () => undefined,
    onTasksChanged: () => undefined,
    compactConversation: () => false,
    messages,
    events,
    debug,
    conversationSets,
    isBusy: () => busy,
  };
}

beforeEach(() => {
  mocks.assembledCalls.length = 0;
  mocks.closeMcpCalls.length = 0;
  mocks.assembleContextResult = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('runAgentTurn: setup', () => {
  it('emits a turn_start event and adds the user message', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {
        model: {modelId: 'test'},
        config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}},
      },
      fullStreamParts: [{type: 'finish', finishReason: 'stop'}],
      responseMessages: [{role: 'assistant', content: 'done'}],
    });
    const cb = makeCallbacks();
    const outcome = await runAgentTurn('hello', undefined, [], cb);
    expect(cb.events[0]?.type).toBe('turn_start');
    expect(cb.messages[0]).toEqual({role: 'user', text: 'hello'});
    expect(cb.events.at(-1)?.type).toBe('turn_end');
    expect(outcome).toEqual({status: 'complete'});
  });

  it('uses displayValue when provided instead of the raw value', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {
        model: {modelId: 'test'},
        config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}},
      },
      fullStreamParts: [{type: 'finish', finishReason: 'stop'}],
    });
    const cb = makeCallbacks();
    await runAgentTurn('raw', 'display', [], cb);
    expect(cb.messages[0]).toEqual({role: 'user', text: 'display'});
  });

  it('forwards modelOverride (and cwd) to modelWithConfig for both the session and no-session branches', async () => {
    const modelWithConfigCalls: Array<{cwd?: string; modelSelector?: string} | undefined> = [];
    vi.doMock('../../../src/llm/client.js', () => ({
      modelWithConfig: vi.fn(async (opts?: {cwd?: string; modelSelector?: string}) => {
        modelWithConfigCalls.push(opts);
        return {
          model: {id: 'mock'},
          config: {providerName: 'openai', baseURL: 'https://x/v1', modelName: 'gpt-4o-mini', cacheKey: 'k', capabilities: {}},
        };
      }),
      providerRequestSettings: () => ({}),
    }));
    vi.doMock('../../../src/llm/requestContext.js', () => ({
      assembleRequestContext: vi.fn(async () => ({systemPrompt: '', availableTools: {}, toolCategories: new Map()})),
    }));
    vi.doMock('../../../src/llm/mcp.js', () => ({closeMcpClients: vi.fn(async () => undefined)}));
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      class NoopAgent {
        stream() {
          return {fullStream: (async function* () { yield {type: 'finish', finishReason: 'stop'}; })(), response: Promise.resolve({messages: []})};
        }
      }
      return {...actual, ToolLoopAgent: NoopAgent, stepCountIs: (n: number) => ({steps: n})};
    });
    vi.resetModules();
    const {runAgentTurn} = await import('../../../src/cli/commands/streaming.js');
    // No session: cwd must still be forwarded (undefined) alongside the selector so the
    // cache-seed behavior matches the no-override path.
    await runAgentTurn('hi', undefined, [], makeCallbacks(), 0, false, false, undefined, 'openai:gpt-4o-mini');
    expect(modelWithConfigCalls[0]).toEqual({cwd: undefined, modelSelector: 'openai:gpt-4o-mini', slot: 'primary'});
    // Session present: its cwd is forwarded.
    await runAgentTurn('hi', undefined, [], makeCallbacks(), 0, false, false, {start: new Date(), cwd: '/work'}, 'openai:gpt-4o-mini');
    expect(modelWithConfigCalls[1]).toEqual({cwd: '/work', modelSelector: 'openai:gpt-4o-mini', slot: 'primary'});
  });
});

describe('runAgentTurn: no model', () => {
  it('emits a system message and returns cleanly when no provider is configured', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle: undefined,
    });
    const cb = makeCallbacks();
    await runAgentTurn('hi', undefined, [], cb);
    expect(cb.messages.some((m) => m.role === 'assistant' && /No model provider configured/.test(m.text))).toBe(true);
    expect(cb.events.at(-1)?.type).toBe('turn_end');
  });

  it('skips the user-message add when retrying an existing request', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle: undefined,
    });
    const cb = makeCallbacks();
    await runAgentTurn('retry', undefined, [], cb, 1, true);
    expect(cb.messages.find((m) => m.role === 'user' && m.text === 'retry')).toBeUndefined();
  });
});

describe('runAgentTurn: stream handling', () => {
  it('streams text-delta parts into a single assistant message', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {
        model: {modelId: 'test'},
        config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}},
      },
      fullStreamParts: [
        {type: 'text-delta', id: 'a1', text: 'Hello'},
        {type: 'text-delta', id: 'a1', text: ' world'},
        {type: 'finish', finishReason: 'stop'},
      ],
      responseMessages: [{role: 'assistant', content: 'Hello world'}],
    });
    const cb = makeCallbacks();
    await runAgentTurn('go', undefined, [], cb);
    const assistant = cb.messages.find((m) => m.role === 'assistant');
    expect(assistant?.text).toBe('Hello world');
  });

  it('records tool_start, tool_call, and tool_result events with status changes', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {
        model: {modelId: 'test'},
        config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}},
      },
      fullStreamParts: [
        {type: 'tool-input-start', id: 't1', toolName: 'bash'},
        {type: 'tool-call', toolCallId: 't1', toolName: 'bash', input: {command: 'ls'}},
        {type: 'tool-result', toolCallId: 't1', toolName: 'bash', input: {command: 'ls'}, output: {ok: true, stdout: 'x'}},
        {type: 'finish', finishReason: 'stop'},
      ],
      responseMessages: [{role: 'assistant', content: 'done'}],
    });
    const cb = makeCallbacks();
    await runAgentTurn('run', undefined, [], cb);
    expect(cb.events.find((e) => e.type === 'tool_start')).toBeDefined();
    expect(cb.events.filter((e) => e.type === 'tool_end')).toHaveLength(1);
  });
});

describe('runAgentTurn: error paths', () => {
  it('recovers from context overflow by compacting and retrying once', async () => {
    let compactCalled = false;
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {
        model: {modelId: 'test'},
        config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}},
      },
      contextOverflow: true,
      fullStreamParts: [{type: 'finish', finishReason: 'stop'}],
    });
    const cb = makeCallbacks();
    cb.compactConversation = () => {
      compactCalled = true;
      return true;
    };
    await runAgentTurn('big', undefined, [], cb);
    expect(compactCalled).toBe(true);
    expect(mocks.assembledCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('retries a retryable error up to maxRetries with backoff', async () => {
    vi.useFakeTimers();
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {
        model: {modelId: 'test'},
        config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}},
      },
      retryable: true,
      fullStreamParts: [{type: 'finish', finishReason: 'stop'}],
    });
    const cb = makeCallbacks();
    const promise = runAgentTurn('flaky', undefined, [], cb);
    await vi.runAllTimersAsync();
    await promise;
    expect(cb.messages.some((m) => /Transient model error/.test(m.text))).toBe(true);
    expect(cb.messages.some((m) => /retrying attempt 1\/2/.test(m.text))).toBe(true);
    vi.useRealTimers();
  });

  it('switches to the fallback slot on the first retriable error', async () => {
    vi.useFakeTimers();
    const modelWithConfigCalls: Array<{slot?: string; modelSelector?: string}> = [];
    vi.doMock('../../../src/llm/client.js', () => ({
      modelWithConfig: vi.fn(async (opts?: {slot?: string; modelSelector?: string}) => {
        modelWithConfigCalls.push(opts ?? {});
        return {
          model: {id: 'mock'},
          config: {providerName: opts?.slot === 'fallback' ? 'openai' : 'primary', baseURL: 'https://x/v1', modelName: opts?.slot === 'fallback' ? 'fallback-model' : 'primary-model', cacheKey: 'k', capabilities: {}},
        };
      }),
      providerRequestSettings: () => ({}),
    }));
    vi.doMock('../../../src/llm/requestContext.js', () => ({
      assembleRequestContext: vi.fn(async () => ({systemPrompt: '', availableTools: {}, toolCategories: new Map()})),
    }));
    vi.doMock('../../../src/llm/mcp.js', () => ({closeMcpClients: vi.fn(async () => undefined)}));
    vi.doMock('../../../src/config/settings.js', () => ({
      readSettings: vi.fn(async () => ({
        providers: [
          {name: 'primary', url: 'https://p/v1', models: ['primary-model']},
          {name: 'openai', url: 'https://x/v1', models: ['fallback-model']},
        ],
        provider: 'primary',
        model: 'primary-model',
        models: {fallback: 'openai:fallback-model'},
      })),
    }));
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      let call = 0;
      class ToggleAgent {
        stream() {
          call += 1;
          if (call === 1) {
            const error = new Error('Service overloaded (503)');
            return {fullStream: (async function* () { yield {type: 'error', error}; })(), response: Promise.reject(error)};
          }
          return {fullStream: (async function* () { yield {type: 'finish', finishReason: 'stop'}; })(), response: Promise.resolve({messages: []})};
        }
      }
      return {...actual, ToolLoopAgent: ToggleAgent, stepCountIs: (n: number) => ({steps: n})};
    });
    vi.resetModules();
    const {runAgentTurn} = await import('../../../src/cli/commands/streaming.js');
    const cb = makeCallbacks();
    const promise = runAgentTurn('flaky', undefined, [], cb);
    await vi.runAllTimersAsync();
    await promise;
    expect(cb.messages.some(m => /falling back to openai:fallback-model/.test(m.text))).toBe(true);
    expect(cb.events.some(e => e.type === 'turn_end')).toBe(true);
    vi.useRealTimers();
  });

  it('does not fallback when fallback resolves to the same model as primary', async () => {
    vi.useFakeTimers();
    vi.doMock('../../../src/llm/client.js', () => ({
      modelWithConfig: vi.fn(async () => ({
        model: {id: 'mock'},
        config: {providerName: 'openai', baseURL: 'https://x/v1', modelName: 'same-model', cacheKey: 'k', capabilities: {}},
      })),
      providerRequestSettings: () => ({}),
    }));
    vi.doMock('../../../src/llm/requestContext.js', () => ({
      assembleRequestContext: vi.fn(async () => ({systemPrompt: '', availableTools: {}, toolCategories: new Map()})),
    }));
    vi.doMock('../../../src/llm/mcp.js', () => ({closeMcpClients: vi.fn(async () => undefined)}));
    vi.doMock('../../../src/config/settings.js', () => ({
      readSettings: vi.fn(async () => ({
        providers: [{name: 'openai', url: 'https://x/v1', models: ['same-model']}],
        provider: 'openai',
        model: 'same-model',
        models: {fallback: 'openai:same-model'},
      })),
    }));
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      let call = 0;
      class ToggleAgent {
        stream() {
          call += 1;
          if (call === 1) {
            const error = new Error('Service overloaded (503)');
            return {fullStream: (async function* () { yield {type: 'error', error}; })(), response: Promise.reject(error)};
          }
          return {fullStream: (async function* () { yield {type: 'finish', finishReason: 'stop'}; })(), response: Promise.resolve({messages: []})};
        }
      }
      return {...actual, ToolLoopAgent: ToggleAgent, stepCountIs: (n: number) => ({steps: n})};
    });
    vi.resetModules();
    const {runAgentTurn} = await import('../../../src/cli/commands/streaming.js');
    const cb = makeCallbacks();
    const promise = runAgentTurn('flaky', undefined, [], cb);
    await vi.runAllTimersAsync();
    await promise;
    expect(cb.messages.some(m => /falling back/.test(m.text))).toBe(false);
    expect(cb.messages.some(m => /Transient model error/.test(m.text))).toBe(true);
    vi.useRealTimers();
  });

  it('does not fallback when an explicit model override is active', async () => {
    vi.useFakeTimers();
    const modelWithConfigCalls: Array<{slot?: string; modelSelector?: string}> = [];
    vi.doMock('../../../src/llm/client.js', () => ({
      modelWithConfig: vi.fn(async (opts?: {slot?: string; modelSelector?: string}) => {
        modelWithConfigCalls.push(opts ?? {});
        return {
          model: {id: 'mock'},
          config: {providerName: 'primary', baseURL: 'https://x/v1', modelName: opts?.modelSelector ?? 'primary-model', cacheKey: 'k', capabilities: {}},
        };
      }),
      providerRequestSettings: () => ({}),
    }));
    vi.doMock('../../../src/llm/requestContext.js', () => ({
      assembleRequestContext: vi.fn(async () => ({systemPrompt: '', availableTools: {}, toolCategories: new Map()})),
    }));
    vi.doMock('../../../src/llm/mcp.js', () => ({closeMcpClients: vi.fn(async () => undefined)}));
    vi.doMock('../../../src/config/settings.js', () => ({
      readSettings: vi.fn(async () => ({
        providers: [
          {name: 'primary', url: 'https://p/v1', models: ['primary-model']},
          {name: 'openai', url: 'https://x/v1', models: ['fallback-model']},
        ],
        provider: 'primary',
        model: 'primary-model',
        models: {fallback: 'openai:fallback-model'},
      })),
    }));
    vi.doMock('ai', async () => {
      const actual = await vi.importActual<typeof import('ai')>('ai');
      let call = 0;
      class ToggleAgent {
        stream() {
          call += 1;
          if (call === 1) {
            const error = new Error('Service overloaded (503)');
            return {fullStream: (async function* () { yield {type: 'error', error}; })(), response: Promise.reject(error)};
          }
          return {fullStream: (async function* () { yield {type: 'finish', finishReason: 'stop'}; })(), response: Promise.resolve({messages: []})};
        }
      }
      return {...actual, ToolLoopAgent: ToggleAgent, stepCountIs: (n: number) => ({steps: n})};
    });
    vi.resetModules();
    const {runAgentTurn} = await import('../../../src/cli/commands/streaming.js');
    const cb = makeCallbacks();
    const promise = runAgentTurn('flaky', undefined, [], cb, 0, false, false, undefined, 'primary:primary-model');
    await vi.runAllTimersAsync();
    await promise;
    expect(cb.messages.some(m => /falling back/.test(m.text))).toBe(false);
    expect(cb.messages.some(m => /Transient model error/.test(m.text))).toBe(true);
    expect(modelWithConfigCalls.every(c => c.modelSelector === 'primary:primary-model')).toBe(true);
    vi.useRealTimers();
  });

  it('emits a model-call-failed assistant message for non-retryable errors after retries are exhausted', async () => {
    vi.useFakeTimers();
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {
        model: {modelId: 'test'},
        config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}},
      },
      retryable: true,
      fullStreamParts: [{type: 'finish', finishReason: 'stop'}],
    });
    const cb = makeCallbacks();
    const promise = runAgentTurn('exhaust', undefined, [], cb, 2, true);
    await vi.runAllTimersAsync();
    const outcome = await promise;
    expect(cb.messages.some((m) => /Model call failed/.test(m.text))).toBe(true);
    expect(outcome).toEqual({status: 'failed'});
    vi.useRealTimers();
  });
});

describe('runAgentTurn: abort', () => {
  it('emits a "Thinking aborted" system message when aborted', async () => {
    let abortControllerRef: AbortController | undefined;
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {
        model: {modelId: 'test'},
        config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}},
      },
      hangUntilAbort: true,
    });
    const cb = makeCallbacks();
    cb.setAbortController = (controller) => {
      abortControllerRef = controller;
    };
    const promise = runAgentTurn('quit', undefined, [], cb);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    abortControllerRef?.abort();
    const outcome = await promise;
    expect(cb.messages.some((m) => m.role === 'system' && /aborted/i.test(m.text))).toBe(true);
    expect(outcome).toEqual({status: 'aborted'});
  });
});

describe('runAgentTurn: MCP cleanup', () => {
  it('closes MCP clients loaded for the request in the finally block', async () => {
    const closeMock = vi.fn(async () => undefined);
    mocks.assembleContextResult = {
      systemPrompt: 'sys',
      availableTools: {bash: {description: 'bash'}},
      toolCategories: new Map([['bash', 'builtin']]),
      loadedMcp: {clients: [{close: closeMock}], tools: {}, errors: []},
    };
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {
        model: {modelId: 'test'},
        config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}},
      },
      fullStreamParts: [{type: 'finish', finishReason: 'stop'}],
    });
    const cb = makeCallbacks();
    await runAgentTurn('hi', undefined, [], cb);
    expect(mocks.closeMcpCalls.length).toBe(1);
  });

  it('surfaces MCP load errors as a system message', async () => {
    mocks.assembleContextResult = {
      systemPrompt: 'sys',
      availableTools: {},
      toolCategories: new Map(),
      loadedMcp: {clients: [], tools: {}, errors: ['mcp://broken failed to start']},
    };
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {
        model: {modelId: 'test'},
        config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}},
      },
      fullStreamParts: [{type: 'finish', finishReason: 'stop'}],
    });
    const cb = makeCallbacks();
    await runAgentTurn('hi', undefined, [], cb);
    expect(cb.messages.some((m) => m.role === 'system' && /mcp:\/\/broken/.test(m.text))).toBe(true);
  });
});
