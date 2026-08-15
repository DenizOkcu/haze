import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {RESCUE_BOUNDARY} from '../../../src/core/agent/completionController.js';
import {restrictToRescueTools} from '../../../src/cli/commands/streaming.js';

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
  availableTools?: Record<string, unknown>;
  failFirstNAgents?: number;
  idle?: boolean;
  hangUntilAbort?: boolean;
  stepEnds?: Array<{stepNumber: number; text: string; toolCalls: unknown[]; toolResults?: unknown[]; finishReason?: string; response?: {messages: unknown[]}}>;
  /** Per-call stream parts, indexed by agent call number (1-based). Enables recovery-slice scenarios. */
  callStreams?: FakeFullStreamPart[][];
  /** Per-call step ends, indexed by agent call number (1-based). */
  callStepEnds?: Array<Array<{stepNumber: number; text: string; toolCalls: unknown[]; toolResults?: unknown[]; finishReason?: string; response?: {messages: unknown[]}}>>;
  /** 1-based agent call numbers whose stream yields its parts, then hangs with no further events until aborted (model-stream idle stall). */
  stallCalls?: number[];
}

const mocks = vi.hoisted(() => {
  return {
    assembledCalls: [] as unknown[],
    streamedMessages: [] as unknown[][],
    agentOptions: [] as Array<Record<string, unknown>>,
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
        availableTools: config.availableTools ?? {bash: {description: 'bash', execute: async () => ({ok: true})}},
        toolCategories: new Map(Object.keys(config.availableTools ?? {bash: {}}).map(name => [name, 'builtin'])),
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
        mocks.agentOptions.push(options);
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
        const callIndex = agentCallCount - 1;
        const activeParts = config.callStreams ? config.callStreams[Math.min(callIndex, config.callStreams.length - 1)] : parts;
        const stepEnds = config.callStepEnds ? config.callStepEnds[Math.min(callIndex, config.callStepEnds.length - 1)] : (config.stepEnds ?? []);
        if (config.stallCalls?.includes(agentCallCount)) {
          let onAbort: (() => void) | undefined;
          const waitForAbort = new Promise<void>(resolve => {
            onAbort = () => resolve();
            if (abortSignal.aborted) resolve();
            else abortSignal.addEventListener('abort', onAbort);
          });
          const cleanup = () => {
            if (onAbort && !abortSignal.aborted) abortSignal.removeEventListener('abort', onAbort);
          };
          void waitForAbort.then(cleanup, cleanup);
          return {
            stream: (async function* () {
              for (const step of stepEnds) onStepEnd?.({...step, toolResults: step.toolResults ?? [], finishReason: step.finishReason ?? 'tool-calls', usage: {}, response: {messages: step.response?.messages ?? []}});
              for (const part of activeParts) {
                if (typeof part.testNow === 'number') vi.setSystemTime(part.testNow);
                yield part;
              }
              // Model stream hangs: no further parts until the idle timer aborts.
              await waitForAbort;
              throw new Error('aborted');
            })(),
            response: waitForAbort.then(() => {
              cleanup();
              return {messages: []};
            }),
            responseMessages: waitForAbort.then(() => {
              cleanup();
              return [];
            }),
          };
        }
        return {
          ...this._fake,
          stream: (async function* () {
            for (const step of stepEnds) onStepEnd?.({...step, toolResults: step.toolResults ?? [], finishReason: step.finishReason ?? 'tool-calls', usage: {}, response: {messages: step.response?.messages ?? []}});
            for (const part of activeParts) {
              if (typeof part.testNow === 'number') vi.setSystemTime(part.testNow);
              yield part;
            }
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
    getConversation: () => conversationSets.at(-1) ?? [],
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
  mocks.agentOptions.length = 0;
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
    expect(outcome).toMatchObject({status: 'complete'});
  });

  it('steers malformed write input into a forced smaller retry', async () => {
    mocks.assembleContextResult = {
      systemPrompt: 'You are haze.',
      availableTools: {writeFile: {description: 'write'}},
      toolCategories: new Map([['writeFile', 'builtin']]),
    };
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {model: {modelId: 'test'}, config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}}},
      streamParts: [{type: 'text-delta', text: 'Done.'}, {type: 'finish', finishReason: 'stop'}],
    });
    await runAgentTurn('write a large file', undefined, [], makeCallbacks());
    const options = mocks.agentOptions.at(-1)!;
    const repair = options.experimental_repairToolCall as (input: unknown) => Promise<unknown>;
    const error = new Error('JSON parsing failed');
    error.name = 'AI_InvalidToolInputError';
    await expect(repair({toolCall: {toolName: 'writeFile'}, error})).resolves.toBeNull();
    const prepare = options.prepareStep as (input: unknown) => {toolChoice: {type: string; toolName: string}; messages: unknown[]};
    const prepared = prepare({steps: [], messages: []});
    expect(prepared.toolChoice).toEqual({type: 'tool', toolName: 'writeFile'});
    expect(JSON.stringify(prepared.messages)).toMatch(/append=true/);
    await repair({toolCall: {toolName: 'writeFile'}, error});
    expect(prepare({steps: [], messages: []}).toolChoice).toEqual({type: 'tool', toolName: 'writeFile'});
    await repair({toolCall: {toolName: 'writeFile'}, error});
    expect(prepare({steps: [], messages: []}).toolChoice).toBe('none');
  });

  it('updates edit recovery before the next prepareStep instead of waiting for streamed tool results', async () => {
    mocks.assembleContextResult = {
      systemPrompt: 'You are haze.',
      availableTools: {readFile: {description: 'read'}, editFile: {description: 'edit'}},
      toolCategories: new Map([['readFile', 'builtin'], ['editFile', 'builtin']]),
    };
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {model: {modelId: 'test'}, config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}}},
      streamParts: [{type: 'text-delta', text: 'Done.'}, {type: 'finish', finishReason: 'stop'}],
    });
    await runAgentTurn('fix a.ts', undefined, [], makeCallbacks());
    const options = mocks.agentOptions.at(-1)!;
    const onStepEnd = options.onStepEnd as (input: Record<string, unknown>) => void;
    const prepare = options.prepareStep as (input: {steps: unknown[]; messages: unknown[]}) => {activeTools?: string[]} | undefined;
    const base = {stepNumber: 0, text: '', toolCalls: [], toolResults: [], finishReason: 'tool-calls', usage: {}, response: {messages: []}};

    onStepEnd({...base, content: [{type: 'tool-result', toolName: 'editFile', input: {path: './a.ts'}, output: {ok: false, recoveryTool: 'readFile'}}]});
    expect(prepare({steps: [], messages: []})?.activeTools).toEqual(['readFile']);

    onStepEnd({...base, stepNumber: 1, content: [{type: 'tool-result', toolName: 'readFile', input: {path: 'a.ts'}, output: {ok: true, content: 'x'}}]});
    expect(prepare({steps: [], messages: []})?.activeTools).toBeUndefined();
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

  it('measures only execution time, not streamed tool-input generation time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {model: {modelId: 'test'}, config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}}},
      streamParts: [
        {type: 'tool-input-start', id: 't1', toolName: 'bash', testNow: 1_000},
        {type: 'tool-call', toolCallId: 't1', toolName: 'bash', input: {command: 'ls'}, testNow: 101_000},
        {type: 'tool-result', toolCallId: 't1', toolName: 'bash', input: {command: 'ls'}, output: {ok: true}, testNow: 101_025},
        {type: 'text-delta', text: 'Done.'},
        {type: 'finish', finishReason: 'stop'},
      ],
    });
    const cb = makeCallbacks();
    await runAgentTurn('run', undefined, [], cb);
    expect(cb.events.find(event => event.type === 'tool_end')).toMatchObject({durationMs: 25});
  });

  it('publishes structured tool failure consistently to events, logs, work state, and status', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {model: {modelId: 'test'}, config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}}},
      streamParts: [
        {type: 'tool-call', toolCallId: 't1', toolName: 'bash', input: {command: 'npm test'}},
        {type: 'tool-result', toolCallId: 't1', toolName: 'bash', input: {command: 'npm test'}, output: {ok: false, code: 1, validationSummary: {kind: 'test', status: 'failed', summaryText: 'test failed: 1 failed test', failedFiles: [], failedTests: ['suite'], diagnostics: [], rawOutputTruncated: false}}},
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
    expect(outcome).toMatchObject({status: 'failed'});
  });

  it('cannot report complete after the hard step budget is reached', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {model: {modelId: 'test'}, config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}}},
      stepEnds: Array.from({length: 64}, (_, stepNumber) => ({stepNumber, text: '', toolCalls: []})),
      streamParts: [{type: 'text-delta', text: 'A final answer arrived only after exhausting the budget.'}, {type: 'finish', finishReason: 'stop'}],
    });
    await expect(runAgentTurn('work', undefined, [], makeCallbacks())).resolves.toMatchObject({status: 'failed'});
  });
});

describe('restrictToRescueTools (F-08)', () => {
  it('keeps only built-in mutation and validation-capable tools', () => {
    const tools = {
      readFile: {description: 'r'},
      grep: {description: 'g'},
      editFile: {description: 'e'},
      writeFile: {description: 'w'},
      replaceLines: {description: 'l'},
      bash: {description: 'b'},
      someMcpTool: {description: 'm'},
    };
    expect(Object.keys(restrictToRescueTools(tools as never)).sort()).toEqual(['bash', 'editFile', 'replaceLines', 'writeFile']);
  });

  it('returns an empty set when nothing qualifies instead of the full tool set', () => {
    const tools = {readFile: {description: 'r'}, grep: {description: 'g'}, mcp: {description: 'm'}};
    expect(restrictToRescueTools(tools as never)).toEqual({});
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

  it('reports honestly when the mode cannot compact instead of a misleading history message (F-10)', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {
        model: {modelId: 'test'},
        config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}},
      },
      contextOverflow: true,
      streamParts: [{type: 'finish', finishReason: 'stop'}],
    });
    const cb = makeCallbacks();
    // No compactConversation callback at all (the pre-F-10 headless shape).
    delete (cb as {compactConversation?: unknown}).compactConversation;
    await runAgentTurn('big', undefined, [], cb);
    expect(cb.messages.some((m) => /does not attempt automatic compaction/.test(m.text))).toBe(true);
    expect(cb.messages.some((m) => /not enough conversation history/.test(m.text))).toBe(false);
    expect(cb.events.find((event) => event.type === 'context_overflow')).toMatchObject({recovered: false});
  });

  it('reports insufficient history only when compaction was available and declined it (F-10)', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {
        model: {modelId: 'test'},
        config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}},
      },
      contextOverflow: true,
      streamParts: [{type: 'finish', finishReason: 'stop'}],
    });
    const cb = makeCallbacks();
    cb.compactConversation = () => false;
    await runAgentTurn('big', undefined, [], cb);
    expect(cb.messages.some((m) => /not enough conversation history to compact/.test(m.text))).toBe(true);
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
    expect(outcome).toMatchObject({status: 'failed'});
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
    expect(outcome).toMatchObject({status: 'aborted'});
  });
});

describe('runAgentTurn: model-stream idle timeout', () => {
  const stallModelHandle = {
    model: {modelId: 'test'},
    config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}},
  };

  // Integration scenario from the field report: successful tool steps, then the
  // next stream hangs, the idle timer fires, a bounded retry resumes from the
  // salvaged step, and the turn ends with exactly one turn_end.
  it('treats an idle stall as retryable, resumes from the salvaged step, and completes', async () => {
    vi.useFakeTimers();
    const salvagedStep = [
      {role: 'assistant', content: [{type: 'tool-call', toolCallId: 't1', toolName: 'bash', input: {command: 'ls'}}]},
      {role: 'tool', content: [{type: 'tool-result', toolCallId: 't1', toolName: 'bash', output: {ok: true, stdout: 'src'}}]},
    ];
    const {runAgentTurn} = await loadStreaming({
      modelHandle: stallModelHandle,
      stallCalls: [1],
      stepEnds: [{stepNumber: 0, text: '', toolCalls: [{toolCallId: 't1', toolName: 'bash'}], response: {messages: salvagedStep}}],
      callStreams: [
        [
          {type: 'tool-call', toolCallId: 't1', toolName: 'bash', input: {command: 'ls'}},
          {type: 'tool-result', toolCallId: 't1', toolName: 'bash', input: {command: 'ls'}, output: {ok: true, stdout: 'src'}},
        ],
        [{type: 'text-delta', text: 'The inspection finished and the requested summary is complete.'}, {type: 'finish', finishReason: 'stop'}],
      ],
    });
    const cb = makeCallbacks();
    const promise = runAgentTurn('inspect the project', undefined, [], cb);
    await vi.runAllTimersAsync();
    const outcome = await promise;
    expect(cb.events.filter(event => event.type === 'turn_start')).toHaveLength(1);
    expect(cb.events.filter(event => event.type === 'turn_end')).toHaveLength(1);
    expect(cb.events.find(event => event.type === 'timeout')).toMatchObject({phase: 'model-stream', stallEmission: 'none', retryEligible: true});
    expect(cb.events.find(event => event.type === 'retry')).toMatchObject({attempt: 1});
    expect(cb.messages.some(m => m.role === 'system' && /Model stream stalled for 5 minutes; retrying attempt 1\/2/.test(m.text))).toBe(true);
    // The retry resumed from the salvaged conversation: exactly one user message
    // and the completed step's tool messages ride along instead of being re-run.
    expect(mocks.streamedMessages).toHaveLength(2);
    const retryMessages = mocks.streamedMessages[1] as Array<{role: string}>;
    expect(retryMessages.filter(message => message.role === 'user')).toHaveLength(1);
    expect(retryMessages.some(message => message.role === 'tool')).toBe(true);
    expect(outcome).toMatchObject({status: 'complete'});
    expect(outcome.resume).toBeUndefined();
  });

  it('pauses with a resume affordance when idle retries are exhausted', async () => {
    vi.useFakeTimers();
    const {runAgentTurn} = await loadStreaming({
      modelHandle: stallModelHandle,
      stallCalls: [1, 2, 3],
      stepEnds: [{stepNumber: 0, text: '', toolCalls: [{toolCallId: 't1', toolName: 'bash'}]}],
      callStreams: [[{type: 'finish', finishReason: 'tool-calls'}]],
    });
    const cb = makeCallbacks();
    const promise = runAgentTurn('plan the feature', undefined, [], cb);
    await vi.runAllTimersAsync();
    const outcome = await promise;
    // Two bounded retries (three stalled attempts), then pause — never a retry loop.
    expect(mocks.streamedMessages).toHaveLength(3);
    expect(cb.events.filter(event => event.type === 'retry')).toHaveLength(2);
    expect(cb.events.filter(event => event.type === 'turn_end')).toHaveLength(1);
    expect(cb.messages.some(m => m.role === 'system' && /Model stream stalled for 5 minutes; unfinished task paused after step \d+\. Press R to retry/.test(m.text))).toBe(true);
    expect(cb.messages.some(m => /Thinking aborted/.test(m.text))).toBe(false);
    expect(outcome).toMatchObject({status: 'failed', resume: {kind: 'model-stream-idle', request: 'plan the feature', retryAttempt: 2}});
  });

  it('does not auto-retry an idle stall after the stalled step emitted partial text', async () => {
    vi.useFakeTimers();
    const {runAgentTurn} = await loadStreaming({
      modelHandle: stallModelHandle,
      stallCalls: [1],
      callStreams: [[{type: 'text-delta', text: 'Half of an answ'}]],
    });
    const cb = makeCallbacks();
    const promise = runAgentTurn('explain the module', undefined, [], cb);
    await vi.runAllTimersAsync();
    const outcome = await promise;
    expect(mocks.streamedMessages).toHaveLength(1);
    expect(cb.events.find(event => event.type === 'retry')).toBeUndefined();
    expect(cb.events.find(event => event.type === 'timeout')).toMatchObject({stallEmission: 'text', retryEligible: false});
    expect(cb.messages.some(m => m.role === 'system' && /unfinished task paused\. Press R to retry/.test(m.text))).toBe(true);
    expect(outcome).toMatchObject({status: 'failed', resume: {kind: 'model-stream-idle'}});
  });

  it('distinguishes the absolute turn deadline from a user abort', async () => {
    vi.useFakeTimers();
    const {runAgentTurn} = await loadStreaming({
      modelHandle: stallModelHandle,
      hangUntilAbort: true,
    });
    const cb = makeCallbacks();
    const promise = runAgentTurn('long work', undefined, [], cb, 0, false, false, undefined, undefined, {turnDeadlineMs: 5_000});
    await vi.runAllTimersAsync();
    const outcome = await promise;
    expect(cb.events.find(event => event.type === 'timeout')).toMatchObject({phase: 'turn'});
    expect(cb.messages.some(m => m.role === 'system' && /turn budget elapsed/.test(m.text))).toBe(true);
    expect(cb.messages.some(m => /Thinking aborted/.test(m.text))).toBe(false);
    expect(outcome).toMatchObject({status: 'aborted'});
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

describe('runAgentTurn: bounded completion recovery', () => {
  const fullTools = {
    listFiles: {description: 'list', execute: async () => ({ok: true})},
    readFile: {description: 'read', execute: async () => ({ok: true})},
    grep: {description: 'grep', execute: async () => ({ok: true})},
    editFile: {description: 'edit', execute: async () => ({ok: true})},
    writeFile: {description: 'write', execute: async () => ({ok: true})},
    bash: {description: 'bash', execute: async () => ({ok: true})},
  };

  it('a normal successful turn makes no extra recovery call', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {model: {modelId: 'test'}, config: {providerName: 't', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}}},
      streamParts: [{type: 'text-delta', text: 'Done, the file is written.'}, {type: 'finish', finishReason: 'stop'}],
    });
    const cb = makeCallbacks();
    const outcome = await runAgentTurn('add a feature', undefined, [], cb);
    expect(mocks.streamedMessages).toHaveLength(1);
    expect(outcome).toMatchObject({status: 'complete'});
  });

  it('a length finish triggers one continuation slice that writes the file and completes', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {model: {modelId: 'test'}, config: {providerName: 't', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}}},
      availableTools: fullTools,
      callStreams: [
        // Main attempt: truncated mid-answer.
        [{type: 'text-delta', text: 'Here is the start of the'}, {type: 'finish', finishReason: 'length'}],
        // Recovery slice: finish writing the file, validate it, then a substantive answer.
        [
          {type: 'tool-call', toolCallId: 'w1', toolName: 'writeFile', input: {path: 'out.txt', content: 'done'}},
          {type: 'tool-result', toolCallId: 'w1', toolName: 'writeFile', input: {path: 'out.txt'}, output: {ok: true}},
          {type: 'tool-call', toolCallId: 'v1', toolName: 'bash', input: {command: 'cat out.txt'}},
          {type: 'tool-result', toolCallId: 'v1', toolName: 'bash', input: {command: 'cat out.txt'}, output: {ok: true, code: 0, validationSummary: {kind: 'test', status: 'passed', summaryText: 'ok', failedFiles: [], failedTests: [], diagnostics: [], rawOutputTruncated: false}}},
          {type: 'text-delta', text: 'Wrote out.txt.'},
          {type: 'finish', finishReason: 'stop'},
        ],
      ],
    });
    const cb = makeCallbacks();
    const outcome = await runAgentTurn('write out.txt with the result', undefined, [], cb);
    await new Promise(resolve => queueMicrotask(resolve));
    expect(mocks.streamedMessages).toHaveLength(2);
    // The recovery slice carries the continuation control, not a re-added user message.
    expect(JSON.stringify(mocks.streamedMessages[1])).toMatch(/truncated by the output-token limit/);
    expect(outcome).toMatchObject({status: 'complete'});
  });

  it('a repeated length finish terminates cleanly (single continuation credit)', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {model: {modelId: 'test'}, config: {providerName: 't', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}}},
      callStreams: [
        [{type: 'text-delta', text: 'partial'}, {type: 'finish', finishReason: 'length'}],
        [{type: 'text-delta', text: 'still partial'}, {type: 'finish', finishReason: 'length'}],
      ],
    });
    const cb = makeCallbacks();
    const outcome = await runAgentTurn('write a long answer', undefined, [], cb);
    expect(mocks.streamedMessages).toHaveLength(2);
    expect(outcome).toMatchObject({status: 'failed'});
  });

  it('rescue near the tool-only boundary runs a restricted slice and saves the value', async () => {
    // 23 trailing tool-only steps exhaust the reserved boundary with no answer.
    const boundaryStepEnds = Array.from({length: RESCUE_BOUNDARY}, (_, i) => ({stepNumber: i, text: '', toolCalls: [{id: `c${i}`}]}));
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {model: {modelId: 'test'}, config: {providerName: 't', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}}},
      availableTools: fullTools,
      callStepEnds: [
        boundaryStepEnds,
        [],
      ],
      callStreams: [
        [{type: 'finish', finishReason: 'stop'}],
        [
          {type: 'tool-call', toolCallId: 'e1', toolName: 'editFile', input: {path: 'a.ts', edits: [{oldText: 'x', newText: 'y'}]}},
          {type: 'tool-result', toolCallId: 'e1', toolName: 'editFile', input: {path: 'a.ts'}, output: {ok: true}},
          {type: 'tool-call', toolCallId: 'v1', toolName: 'bash', input: {command: 'npm test -- a.ts'}},
          {type: 'tool-result', toolCallId: 'v1', toolName: 'bash', input: {command: 'npm test -- a.ts'}, output: {ok: true, code: 0, validationSummary: {kind: 'test', status: 'passed', summaryText: 'ok', failedFiles: [], failedTests: [], diagnostics: [], rawOutputTruncated: false}}},
          {type: 'text-delta', text: 'Applied the discovered fix to a.ts.'},
          {type: 'finish', finishReason: 'stop'},
        ],
      ],
    });
    const cb = makeCallbacks();
    const outcome = await runAgentTurn('add a feature to a.ts', undefined, [], cb);
    expect(mocks.streamedMessages).toHaveLength(2);
    expect(JSON.stringify(mocks.streamedMessages[1])).toMatch(/tool-boundary without a substantive final answer/);
    // Rescue exposes only mutation + validation-capable tools; discovery/read are dropped.
    const rescueTools = Object.keys((mocks.agentOptions[1] as {tools?: Record<string, unknown>}).tools ?? {});
    expect(rescueTools).toContain('editFile');
    expect(rescueTools).toContain('writeFile');
    expect(rescueTools).toContain('bash');
    expect(rescueTools).not.toContain('listFiles');
    expect(rescueTools).not.toContain('readFile');
    expect(rescueTools).not.toContain('grep');
    expect(outcome).toMatchObject({status: 'complete'});
  });

  it('does not rescue a non-mutating (answer) request even at the boundary', async () => {
    const boundaryStepEnds = Array.from({length: RESCUE_BOUNDARY}, (_, i) => ({stepNumber: i, text: '', toolCalls: [{id: `c${i}`}]}));
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {model: {modelId: 'test'}, config: {providerName: 't', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}}},
      availableTools: fullTools,
      callStepEnds: [boundaryStepEnds],
      callStreams: [[{type: 'finish', finishReason: 'stop'}]],
    });
    await runAgentTurn('explain how the module works', undefined, [], makeCallbacks());
    expect(mocks.streamedMessages).toHaveLength(1);
  });
});

describe('runAgentTurn: autonomous goal continuation', () => {
  const modelHandle = {model: {modelId: 'test'}, config: {providerName: 't', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}}};
  const tools = {
    readFile: {description: 'read', execute: async () => ({ok: true})},
    editFile: {description: 'edit', execute: async () => ({ok: true})},
    writeFile: {description: 'write', execute: async () => ({ok: true})},
    bash: {description: 'bash', execute: async () => ({ok: true})},
    writeTasks: {description: 'tasks', execute: async () => ({ok: true})},
  };
  const pendingTasksOutput = {ok: true, taskCount: 5, counts: {pending: 5, in_progress: 0, completed: 0}, summary: 'Tasks: 5 pending.'};
  const completedTasksOutput = {ok: true, taskCount: 5, counts: {pending: 0, in_progress: 0, completed: 5}, summary: 'Tasks: 5 completed.'};
  const passedValidation = (toolCallId: string) => [
    {type: 'tool-call', toolCallId, toolName: 'bash', input: {command: 'npm test'}},
    {type: 'tool-result', toolCallId, toolName: 'bash', input: {command: 'npm test'}, output: {ok: true, code: 0, validationSummary: {kind: 'test', status: 'passed', summaryText: 'ok', failedFiles: [], failedTests: [], diagnostics: [], rawOutputTruncated: false}}},
  ];

  it('continues automatically after a partial final while tasks are pending (roadmap regression)', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle,
      availableTools: tools,
      callStreams: [
        [
          {type: 'tool-call', toolCallId: 't1', toolName: 'writeTasks', input: {tasks: []}},
          {type: 'tool-result', toolCallId: 't1', toolName: 'writeTasks', input: {tasks: []}, output: pendingTasksOutput},
          {type: 'tool-call', toolCallId: 'e1', toolName: 'editFile', input: {path: 'a.ts', edits: []}},
          {type: 'tool-result', toolCallId: 'e1', toolName: 'editFile', input: {path: 'a.ts'}, output: {ok: true}},
          {type: 'text-delta', text: 'Next unfinished action: wire the tool.'},
          {type: 'finish', finishReason: 'stop'},
        ],
        [{type: 'text-delta', text: 'Resuming work now.'}, {type: 'finish', finishReason: 'stop'}],
      ],
    });
    const cb = makeCallbacks();
    await runAgentTurn('implement the roadmap feature', undefined, [], cb);
    // The partial final was rejected: a continuation attempt started automatically.
    expect(mocks.streamedMessages.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(mocks.streamedMessages[1])).toMatch(/final message was rejected/);
    expect(JSON.stringify(mocks.streamedMessages[1])).toMatch(/pending or in progress/);
  });

  it('completes when the continuation finishes tasks and runs fresh validation, with no extra model call', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle,
      availableTools: tools,
      callStreams: [
        [
          {type: 'tool-call', toolCallId: 't1', toolName: 'writeTasks', input: {tasks: []}},
          {type: 'tool-result', toolCallId: 't1', toolName: 'writeTasks', input: {tasks: []}, output: pendingTasksOutput},
          {type: 'text-delta', text: 'Next unfinished action: wire the tool.'},
          {type: 'finish', finishReason: 'stop'},
        ],
        [
          ...passedValidation('v1'),
          {type: 'tool-call', toolCallId: 't2', toolName: 'writeTasks', input: {tasks: []}},
          {type: 'tool-result', toolCallId: 't2', toolName: 'writeTasks', input: {tasks: []}, output: completedTasksOutput},
          {type: 'text-delta', text: 'All five tasks are done and validation passes.'},
          {type: 'finish', finishReason: 'stop'},
        ],
      ],
    });
    const cb = makeCallbacks();
    const outcome = await runAgentTurn('implement the roadmap feature', undefined, [], cb);
    expect(mocks.streamedMessages).toHaveLength(2);
    expect(outcome).toMatchObject({status: 'complete', evidence: {recoveryUsed: {goal: 1}}});
    expect(outcome.evidence?.taskProgress).toEqual({total: 5, pending: 0, inProgress: 0, completed: 5});
    expect(outcome.resume).toBeUndefined();
  });

  it('pauses as failed with bounded retries after repeated no-progress partial finals', async () => {
    const partial = [
      {type: 'tool-call', toolCallId: 't1', toolName: 'writeTasks', input: {tasks: []}},
      {type: 'tool-result', toolCallId: 't1', toolName: 'writeTasks', input: {tasks: []}, output: pendingTasksOutput},
      {type: 'text-delta', text: 'Next unfinished action: wire the tool.'},
      {type: 'finish', finishReason: 'stop'},
    ];
    const again = [{type: 'text-delta', text: 'Still not started; next action remains.'}, {type: 'finish', finishReason: 'stop'}];
    const {runAgentTurn} = await loadStreaming({
      modelHandle,
      availableTools: tools,
      callStreams: [partial, again, again],
    });
    const cb = makeCallbacks();
    const outcome = await runAgentTurn('implement the roadmap feature', undefined, [], cb);
    // Main attempt + one corrective nudge + pause: bounded, no loop.
    expect(mocks.streamedMessages).toHaveLength(3);
    expect(cb.messages.some(m => m.role === 'system' && /Unfinished task paused/.test(m.text))).toBe(true);
    expect(cb.messages.some(m => m.role === 'system' && /Press R to resume/.test(m.text))).toBe(true);
    expect(outcome).toMatchObject({status: 'failed', resume: {kind: 'incomplete-goal', reason: 'pending_tasks', taskCounts: {total: 5, pending: 5}}});
  });

  it('keeps continuing across cycles while measurable progress accumulates', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle,
      availableTools: tools,
      callStreams: [
        [
          {type: 'tool-call', toolCallId: 't1', toolName: 'writeTasks', input: {tasks: []}},
          {type: 'tool-result', toolCallId: 't1', toolName: 'writeTasks', input: {tasks: []}, output: pendingTasksOutput},
          {type: 'text-delta', text: 'Next unfinished action: task one.'},
          {type: 'finish', finishReason: 'stop'},
        ],
        [
          {type: 'tool-call', toolCallId: 'e1', toolName: 'editFile', input: {path: 'a.ts', edits: []}},
          {type: 'tool-result', toolCallId: 'e1', toolName: 'editFile', input: {path: 'a.ts'}, output: {ok: true}},
          {type: 'tool-call', toolCallId: 't2', toolName: 'writeTasks', input: {tasks: []}},
          {type: 'tool-result', toolCallId: 't2', toolName: 'writeTasks', input: {tasks: []}, output: {ok: true, taskCount: 5, counts: {pending: 4, in_progress: 0, completed: 1}, summary: 'x'}},
          {type: 'text-delta', text: 'One task done; next up: task two.'},
          {type: 'finish', finishReason: 'stop'},
        ],
        [
          ...passedValidation('v1'),
          {type: 'tool-call', toolCallId: 't3', toolName: 'writeTasks', input: {tasks: []}},
          {type: 'tool-result', toolCallId: 't3', toolName: 'writeTasks', input: {tasks: []}, output: completedTasksOutput},
          {type: 'text-delta', text: 'All tasks complete and validation passes.'},
          {type: 'finish', finishReason: 'stop'},
        ],
      ],
    });
    const cb = makeCallbacks();
    const outcome = await runAgentTurn('implement the roadmap feature', undefined, [], cb);
    expect(mocks.streamedMessages).toHaveLength(3);
    expect(outcome).toMatchObject({status: 'complete', evidence: {recoveryUsed: {goal: 2}}});
  });

  it('pauses (never completes) when the global step budget is exhausted with tasks pending', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle,
      availableTools: tools,
      stepEnds: Array.from({length: 64}, (_, stepNumber) => ({stepNumber, text: '', toolCalls: []})),
      streamParts: [
        {type: 'tool-call', toolCallId: 't1', toolName: 'writeTasks', input: {tasks: []}},
        {type: 'tool-result', toolCallId: 't1', toolName: 'writeTasks', input: {tasks: []}, output: pendingTasksOutput},
        {type: 'text-delta', text: 'Next unfinished action remains.'},
        {type: 'finish', finishReason: 'stop'},
      ],
    });
    const cb = makeCallbacks();
    const outcome = await runAgentTurn('implement the roadmap feature', undefined, [], cb);
    // Budget was consumed by the main attempt; continuation cannot reset it.
    expect(mocks.streamedMessages).toHaveLength(1);
    expect(outcome).toMatchObject({status: 'failed', resume: {kind: 'incomplete-goal', reason: 'pending_tasks'}, evidence: {budgetBoundary: true}});
    expect(cb.messages.some(m => m.role === 'system' && /Unfinished task paused/.test(m.text))).toBe(true);
  });

  it('does not continue when the declared task list is already complete', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle,
      availableTools: tools,
      streamParts: [
        {type: 'tool-call', toolCallId: 'e1', toolName: 'editFile', input: {path: 'a.ts', edits: []}},
        {type: 'tool-result', toolCallId: 'e1', toolName: 'editFile', input: {path: 'a.ts'}, output: {ok: true}},
        ...passedValidation('v1'),
        {type: 'tool-call', toolCallId: 't1', toolName: 'writeTasks', input: {tasks: []}},
        {type: 'tool-result', toolCallId: 't1', toolName: 'writeTasks', input: {tasks: []}, output: completedTasksOutput},
        {type: 'text-delta', text: 'Everything is done.'},
        {type: 'finish', finishReason: 'stop'},
      ],
    });
    const cb = makeCallbacks();
    const outcome = await runAgentTurn('implement the roadmap feature', undefined, [], cb);
    expect(mocks.streamedMessages).toHaveLength(1);
    expect(outcome).toMatchObject({status: 'complete', evidence: {recoveryUsed: {goal: 0}}});
  });

  it('does not force mutation/validation continuation on a plan request', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle,
      availableTools: tools,
      streamParts: [{type: 'text-delta', text: 'Here is the requested plan.'}, {type: 'finish', finishReason: 'stop'}],
    });
    const cb = makeCallbacks();
    const outcome = await runAgentTurn('create a plan for the refactor', undefined, [], cb);
    expect(mocks.streamedMessages).toHaveLength(1);
    expect(outcome).toMatchObject({status: 'complete'});
  });

  it('continues when edits land without validation, then completes after a fresh validation', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle,
      availableTools: tools,
      callStreams: [
        [
          {type: 'tool-call', toolCallId: 'e1', toolName: 'editFile', input: {path: 'a.ts', edits: []}},
          {type: 'tool-result', toolCallId: 'e1', toolName: 'editFile', input: {path: 'a.ts'}, output: {ok: true}},
          {type: 'text-delta', text: 'I stopped here without validating.'},
          {type: 'finish', finishReason: 'stop'},
        ],
        [
          ...passedValidation('v1'),
          {type: 'text-delta', text: 'Validation passes after the edit.'},
          {type: 'finish', finishReason: 'stop'},
        ],
      ],
    });
    const cb = makeCallbacks();
    const outcome = await runAgentTurn('fix the failing build in a.ts', undefined, [], cb);
    expect(mocks.streamedMessages).toHaveLength(2);
    expect(JSON.stringify(mocks.streamedMessages[1])).toMatch(/edits landed without any relevant validation/);
    expect(outcome).toMatchObject({status: 'complete', evidence: {validationOutcome: 'passed', recoveryUsed: {goal: 1}}});
  });
});

describe('runAgentTurn: completion evidence', () => {
  it('surfaces validation evidence in the turn_end event', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {model: {modelId: 'test'}, config: {providerName: 't', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}}},
      streamParts: [
        {type: 'tool-call', toolCallId: 'v1', toolName: 'bash', input: {command: 'npm test'}},
        {type: 'tool-result', toolCallId: 'v1', toolName: 'bash', input: {command: 'npm test'}, output: {ok: true, code: 0, validationSummary: {kind: 'test', status: 'passed', summaryText: 'ok', failedFiles: [], failedTests: [], diagnostics: [], rawOutputTruncated: false}}},
        {type: 'text-delta', text: 'All tests pass.'},
        {type: 'finish', finishReason: 'stop'},
      ],
    });
    const cb = makeCallbacks();
    await runAgentTurn('add a feature', undefined, [], cb);
    const turnEnd = cb.events.find(event => event.type === 'turn_end') as {evidence?: {validationOutcome?: string; validationKind?: string; finishCause?: string}};
    expect(turnEnd?.evidence?.validationOutcome).toBe('passed');
    expect(turnEnd?.evidence?.validationKind).toBe('test');
    expect(turnEnd?.evidence?.finishCause).toBe('stop');
  });

  it('reports length recovery in the turn_end evidence', async () => {
    const {runAgentTurn} = await loadStreaming({
      modelHandle: {model: {modelId: 'test'}, config: {providerName: 't', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}}},
      callStreams: [
        [{type: 'text-delta', text: 'partial'}, {type: 'finish', finishReason: 'length'}],
        [{type: 'text-delta', text: 'completed now.'}, {type: 'finish', finishReason: 'stop'}],
      ],
    });
    const cb = makeCallbacks();
    await runAgentTurn('write a long doc', undefined, [], cb);
    const turnEnd = cb.events.find(event => event.type === 'turn_end') as {evidence?: {recoveryUsed?: {length?: boolean}}};
    expect(turnEnd?.evidence?.recoveryUsed?.length).toBe(true);
  });
});
