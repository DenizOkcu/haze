import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

interface FakeFullStreamPart {
  type: string;
  [key: string]: unknown;
}

interface FakeAgent {
  streamArgs: Array<{messages: unknown[]; abortSignal: AbortSignal}>;
  stream: AsyncIterable<FakeFullStreamPart>;
  response: Promise<{messages: unknown[]}>;
  responseMessages: Promise<unknown[]>;
  options: Record<string, unknown>;
  prepareStep: ((args: unknown) => unknown) | undefined;
  onStepEnd: ((args: unknown) => void) | undefined;
  onEnd: ((event: {usage?: unknown; responseMessages: unknown[]; response: {messages: unknown[]}}) => void) | undefined;
}

interface FakeModelHandle {
  model: unknown;
  config: {providerName: string; baseURL: string; modelName: string; cacheKey: string; capabilities: Record<string, boolean>};
}

interface MocksConfig {
  modelHandle: FakeModelHandle | undefined;
  contextOverflow?: boolean;
  retryable?: boolean;
  streamParts?: FakeFullStreamPart[];
  responseMessages?: unknown[];
  failFirstNAgents?: number;
  idle?: boolean;
  hangUntilAbort?: boolean;
  stepEnds?: Array<{stepNumber: number; text: string; toolCalls: unknown[]; toolResults?: unknown[]; finishReason?: string}>;
}

const mocks = vi.hoisted(() => {
  return {
    assembledCalls: [] as unknown[],
    streamedMessages: [] as unknown[][],
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
    stream: (async function* () {
      for (const part of parts) yield part;
    })(),
    response: Promise.resolve({messages: responseMessages}),
    responseMessages: Promise.resolve(responseMessages),
    options: {},
    prepareStep: undefined,
    onStepEnd: undefined,
    onEnd: undefined,
  };
  return agent;
}

async function loadStreaming(config: MocksConfig) {
  const parts = config.streamParts ?? [];
  const responseMessages = config.responseMessages ?? [];
  let agentCallCount = 0;

  vi.doMock('../../../src/llm/client.js', () => ({
    modelWithConfig: async () => config.modelHandle ?? undefined,
    providerRequestSettings: () => ({}),
  }));

  vi.doMock('../../../src/llm/requestContext.js', () => ({
    assembleRequestContext: async (input: {executionScope?: unknown}) => {
      const executionScope = input.executionScope ?? {coordinator: {scope: 'shared'}, mutationPolicy: {scope: 'shared'}};
      mocks.assembledCalls.push({input, executionScope});
      return mocks.assembleContextResult ?? {
        systemPrompt: 'You are haze.',
        availableTools: {bash: {description: 'bash', execute: async () => ({ok: true})}},
        toolCategories: new Map([['bash', 'builtin']]),
        executionScope,
      };
    },
  }));

  vi.doMock('../../../src/llm/mcp.js', () => ({
    closeMcpClients: async (clients: unknown) => {
      mocks.closeMcpCalls.push(clients);
    },
  }));

  // The turn reads settings once at start (CR-024); keep tests home-isolated.
  vi.doMock('../../../src/config/settings.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/config/settings.js')>();
    return {...actual, readSettings: async () => ({})};
  });

  vi.doMock('ai', async () => {
    const actual = await vi.importActual<typeof import('ai')>('ai');
    class FakeToolLoopAgent {
      options: Record<string, unknown>;
      prepareStep: ((args: unknown) => unknown) | undefined;
      onStepEnd: ((args: unknown) => void) | undefined;
      onEnd: ((event: unknown) => void) | undefined;
      _fake: FakeAgent;
      constructor(options: Record<string, unknown>) {
        this.options = options;
        this.prepareStep = options.prepareStep as never;
        this.onStepEnd = options.onStepEnd as never;
        this.onEnd = options.onEnd as never;
        this._fake = makeAgent(parts, responseMessages);
      }
      stream({messages, abortSignal}: {messages: unknown[]; abortSignal: AbortSignal}) {
        agentCallCount += 1;
        const isFirstCall = agentCallCount === 1;
        this._fake.streamArgs.push({messages, abortSignal});
        mocks.streamedMessages.push(messages);
        this._fake.options = this.options;
        this._fake.prepareStep = this.prepareStep;
        this._fake.onStepEnd = this.onStepEnd;
        this._fake.onEnd = this.onEnd;
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
            stream: streamAbort(),
            response: waitForAbort.then(() => {
              cleanup();
              return {messages: []};
            }),
            responseMessages: waitForAbort.then(() => []),
          };
        }
        if (isFirstCall && config.contextOverflow) {
          const error = new Error('Request exceeds maximum context length');
          (error as Error & {cause?: unknown}).cause = 'context';
          return {
            stream: (async function* () {
              yield {type: 'error', error};
            })(),
            response: Promise.resolve({messages: []}),
            responseMessages: Promise.reject(error),
          };
        }
        if (isFirstCall && config.retryable) {
          const error = new Error('Service overloaded (503)');
          return {
            stream: (async function* () {
              yield {type: 'error', error};
            })(),
            response: Promise.resolve({messages: []}),
            responseMessages: Promise.reject(error),
          };
        }
        const onStepEnd = this.onStepEnd;
        const stepEnds = config.stepEnds ?? [];
        return {
          ...this._fake,
          stream: (async function* () {
            for (const step of stepEnds) onStepEnd?.({...step, toolResults: step.toolResults ?? [], finishReason: step.finishReason ?? 'tool-calls', usage: {}, response: {messages: []}});
            for (const part of parts) yield part;
          })(),
          response: this._fake.response,
          responseMessages: this._fake.responseMessages,
        };
      }
    }
    return {
      ...actual,
      ToolLoopAgent: FakeToolLoopAgent,
      isStepCount: (n: number) => ({steps: n}),
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
  mocks.streamedMessages.length = 0;
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
      streamParts: [{type: 'text-delta', text: 'The requested answer is complete.'}, {type: 'finish', finishReason: 'stop'}],
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
      streamParts: [{type: 'finish', finishReason: 'stop'}],
    });
    const cb = makeCallbacks();
    await runAgentTurn('raw', 'display', [], cb);
    expect(cb.messages[0]).toEqual({role: 'user', text: 'display'});
  });

  it('sends image attachments as multipart user content and keeps text-only turns as strings (F03, AC1)', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {model: {modelId: 'test'}, config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}}},
      streamParts: [{type: 'text-delta', text: 'Fixed.'}, {type: 'finish', finishReason: 'stop'}],
      responseMessages: [{role: 'assistant', content: 'done'}],
    });
    const attachment = {
      displayPath: 'shot.png', absolutePath: '/tmp/shot.png', fileName: 'shot.png',
      mediaType: 'image/png', bytes: 3, data: new Uint8Array([1, 2, 3]),
    };

    // With attachments: the user message is multipart (text + file part).
    const withImage = makeCallbacks();
    await runAgentTurn('fix this layout', undefined, [], withImage, 0, false, false, undefined, undefined, {attachments: [attachment]});
    const multipartCall = mocks.streamedMessages[0] as Array<{role: string; content: unknown}>;
    const multipartUser = multipartCall.filter(message => message.role === 'user').at(-1);
    expect(Array.isArray(multipartUser?.content)).toBe(true);
    const parts = multipartUser?.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({type: 'text', text: 'fix this layout'});
    expect(parts[1]).toMatchObject({type: 'file', mediaType: 'image/png', filename: 'shot.png'});
    expect((parts[1]?.data as Uint8Array).byteLength).toBe(3);

    // Without attachments: the user message stays a plain string.
    const textOnly = makeCallbacks();
    await runAgentTurn('plain prompt', undefined, [], textOnly);
    const textCall = mocks.streamedMessages[1] as Array<{role: string; content: unknown}>;
    const textUser = textCall.filter(message => message.role === 'user').at(-1);
    expect(textUser?.content).toBe('plain prompt');
  });

  it('applies ephemeral control to every request but never durable conversation/events', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {model: {modelId: 'test'}, config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}}},
      streamParts: [{type: 'finish', finishReason: 'stop'}], responseMessages: [{role: 'assistant', content: 'done'}],
    });
    const cb = makeCallbacks();
    await runAgentTurn('/fleet audit', '/fleet audit', [], cb, 0, false, false, undefined, undefined, {ephemeralControl: 'PRIVATE FLEET CONTROL'});
    expect(JSON.stringify(mocks.streamedMessages)).toContain('PRIVATE FLEET CONTROL');
    expect(JSON.stringify(cb.conversationSets)).not.toContain('PRIVATE FLEET CONTROL');
    expect(JSON.stringify(cb.events)).not.toContain('PRIVATE FLEET CONTROL');
    expect(JSON.stringify(cb.events)).toContain('/fleet audit');
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
          return {stream: (async function* () { yield {type: 'finish', finishReason: 'stop'}; })(), response: Promise.resolve({messages: []}), responseMessages: Promise.resolve([])};
        }
      }
      return {...actual, ToolLoopAgent: NoopAgent, isStepCount: (n: number) => ({steps: n})};
    });
    vi.resetModules();
    const {runAgentTurn} = await import('../../../src/cli/commands/streaming.js');
    // No session: cwd must still be forwarded (undefined) alongside the selector so the
    // cache-seed behavior matches the no-override path.
    await runAgentTurn('hi', undefined, [], makeCallbacks(), 0, false, false, undefined, 'openai:gpt-4o-mini');
    expect(modelWithConfigCalls[0]).toEqual({cwd: undefined, modelSelector: 'openai:gpt-4o-mini'});
    // Session present: its cwd is forwarded.
    await runAgentTurn('hi', undefined, [], makeCallbacks(), 0, false, false, {start: new Date(), cwd: '/work'}, 'openai:gpt-4o-mini');
    expect(modelWithConfigCalls[1]).toEqual({cwd: '/work', modelSelector: 'openai:gpt-4o-mini'});
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
      streamParts: [
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
      streamParts: [
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

  it('publishes structured tool failure consistently to events, logs, work state, and status', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {model: {modelId: 'test'}, config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}}},
      streamParts: [
        {type: 'tool-call', toolCallId: 't1', toolName: 'bash', input: {command: 'npm test'}},
        {type: 'tool-result', toolCallId: 't1', toolName: 'bash', input: {command: 'npm test'}, output: {ok: false, code: 1}},
        {type: 'text-delta', text: 'The validation failed and remains unresolved.'},
        {type: 'finish', finishReason: 'stop'},
      ],
    });
    const logEntries: Array<{toolResult?: {success: boolean}}> = [];
    const workStates: Array<{validations: Array<{status: string}>}> = [];
    const cb = makeCallbacks();
    cb.log = {id: 'test', file: 'unused', writer: {append: async (entry: {toolResult?: {success: boolean}}) => { logEntries.push(entry); }}} as never;
    cb.setWorkState = (state: {validations: Array<{status: string}>}) => { workStates.push(structuredClone(state)); };
    const outcome = await runAgentTurn('run tests', undefined, [], cb);
    await new Promise(resolve => queueMicrotask(resolve));
    expect(cb.events.find(event => event.type === 'tool_end')).toMatchObject({success: false});
    expect(logEntries.find(entry => entry.toolResult)?.toolResult?.success).toBe(false);
    expect(workStates.some(state => state.validations.some(validation => validation.status === 'failed'))).toBe(true);
    expect(outcome).toEqual({status: 'failed'});
  });

  it('cannot report complete after the hard step budget is reached', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {model: {modelId: 'test'}, config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}}},
      stepEnds: Array.from({length: 64}, (_, stepNumber) => ({stepNumber, text: '', toolCalls: []})),
      streamParts: [{type: 'text-delta', text: 'A final answer arrived only after exhausting the budget.'}, {type: 'finish', finishReason: 'stop'}],
    });
    await expect(runAgentTurn('work', undefined, [], makeCallbacks())).resolves.toEqual({status: 'failed'});
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
      streamParts: [{type: 'finish', finishReason: 'stop'}],
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

  it('reuses one execution scope and reapplies ephemeral control across retries', async () => {
    vi.useFakeTimers();
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {model: {modelId: 'test'}, config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}}},
      retryable: true,
      streamParts: [{type: 'finish', finishReason: 'stop'}],
      responseMessages: [{role: 'assistant', content: 'done'}],
    });
    const promise = runAgentTurn('/fleet audit', undefined, [], makeCallbacks(), 0, false, false, undefined, undefined, {ephemeralControl: 'PRIVATE FLEET CONTROL'});
    await vi.runAllTimersAsync();
    await promise;
    expect(mocks.assembledCalls).toHaveLength(2);
    const first = mocks.assembledCalls[0] as {executionScope: unknown};
    const second = mocks.assembledCalls[1] as {input: {executionScope?: unknown}};
    expect(second.input.executionScope).toBe(first.executionScope);
    expect(mocks.streamedMessages).toHaveLength(2);
    expect(mocks.streamedMessages.every(messages => JSON.stringify(messages).includes('PRIVATE FLEET CONTROL'))).toBe(true);
  });

  it('retries a retryable error up to maxRetries with backoff', async () => {
    vi.useFakeTimers();
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {
        model: {modelId: 'test'},
        config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}},
      },
      retryable: true,
      streamParts: [{type: 'finish', finishReason: 'stop'}],
    });
    const cb = makeCallbacks();
    const promise = runAgentTurn('flaky', undefined, [], cb);
    await vi.runAllTimersAsync();
    await promise;
    expect(cb.messages.some((m) => /Transient model error/.test(m.text))).toBe(true);
    expect(cb.messages.some((m) => /retrying attempt 1\/2/.test(m.text))).toBe(true);
    expect(cb.events.filter(event => event.type === 'turn_start')).toHaveLength(1);
    expect(cb.events.filter(event => event.type === 'turn_end')).toHaveLength(1);
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
      streamParts: [{type: 'finish', finishReason: 'stop'}],
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
      streamParts: [{type: 'finish', finishReason: 'stop'}],
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
      streamParts: [{type: 'finish', finishReason: 'stop'}],
    });
    const cb = makeCallbacks();
    await runAgentTurn('hi', undefined, [], cb);
    expect(cb.messages.some((m) => m.role === 'system' && /mcp:\/\/broken/.test(m.text))).toBe(true);
  });
});
