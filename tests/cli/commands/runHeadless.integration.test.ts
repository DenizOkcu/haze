import {afterEach, describe, expect, it, vi} from 'vitest';

// These tests exercise the REAL runAgentTurn (not a stub) wired into runHeadless, with only
// the model/provider/context boundaries mocked. This is the regression guard for the bug where
// headless dropped the finalized assistant text emitted via updateMessage and only kept the
// initial streamed partial from addMessage.

const PROVIDER_SETTINGS = {providers: [{name: 'openai', url: 'https://x/v1', key: 'k', models: ['gpt-4o-mini']}], provider: 'openai', model: 'gpt-4o-mini'};

interface FakePart {
  type: string;
  [key: string]: unknown;
}

async function loadRunHeadless(parts: FakePart[], responseMessages: unknown[] = [], responseError?: Error) {
  vi.doMock('../../../src/llm/client.js', () => ({
    modelWithConfig: async () => ({
      model: {modelId: 'test'},
      config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}},
    }),
    providerRequestSettings: () => ({}),
  }));
  vi.doMock('../../../src/llm/requestContext.js', () => ({
    assembleRequestContext: async () => ({
      systemPrompt: 'You are haze.',
      availableTools: {
        shell: {description: 'shell', execute: async () => ({ok: true})},
        readFile: {description: 'read', execute: async () => ({ok: true})},
      },
      toolCategories: new Map([['shell', 'builtin'], ['readFile', 'builtin']]),
    }),
  }));
  vi.doMock('../../../src/llm/mcp.js', () => ({closeMcpClients: async () => undefined}));
  vi.doMock('../../../src/config/contextFiles.js', () => ({readContextFiles: async () => []}));
  vi.doMock('../../../src/config/settings.js', () => ({readSettings: async () => PROVIDER_SETTINGS}));
  vi.doMock('ai', async () => {
    const actual = await vi.importActual<typeof import('ai')>('ai');
    class FakeToolLoopAgent {
      options: Record<string, unknown>;
      constructor(options: Record<string, unknown>) {
        this.options = options;
      }
      stream() {
        const onStepStart = this.options.onStepStart as ((event: Record<string, unknown>) => void | Promise<void>) | undefined;
        const onStepEnd = this.options.onStepEnd as ((event: Record<string, unknown>) => void | Promise<void>) | undefined;
        return {
          stream: (async function* () {
            await onStepStart?.({stepNumber: 0});
            for (const part of parts) yield part;
            await onStepEnd?.({
              stepNumber: 0,
              text: '',
              toolCalls: [],
              toolResults: [],
              finishReason: 'stop',
              usage: {inputTokens: 10, outputTokens: 2, inputTokenDetails: {cacheReadTokens: 4}},
              response: {messages: responseMessages},
            });
          })(),
          response: Promise.resolve({messages: responseMessages}),
          responseMessages: responseError ? Promise.reject(responseError) : Promise.resolve(responseMessages),
        };
      }
    }
    return {...actual, ToolLoopAgent: FakeToolLoopAgent, isStepCount: (n: number) => ({steps: n})};
  });
  vi.resetModules();
  return import('../../../src/cli/commands/runCommand.js');
}

function captureStdout() {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((b: any) => {
    writes.push(String(b));
    return true;
  });
  return writes;
}

describe('runHeadless integration (real runAgentTurn)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('captures the full finalized text across multiple streamed text-delta parts', async () => {
    const writes = captureStdout();
    // The first delta is substantive enough to start streaming (>=24 chars), so addMessage
    // fires with a partial; the rest only arrives via updateMessage. Old behavior would print
    // just the partial.
    const {runHeadless} = await loadRunHeadless([
      {type: 'text-delta', text: 'This is a sufficiently long first'},
      {type: 'text-delta', text: ' chunk of streamed text.'},
      {type: 'finish', finishReason: 'stop'},
    ]);
    const code = await runHeadless({prompt: 'go', output: 'text'});
    expect(writes.join('')).toBe('This is a sufficiently long first chunk of streamed text.\n');
    expect(code).toBe(0);
  });

  it('joins multi-segment text (text-delta + tool-call + text-delta) with full finalized text', async () => {
    const writes = captureStdout();
    const {runHeadless} = await loadRunHeadless([
      {type: 'text-delta', text: 'This is the first segment of the reply'},
      {type: 'text-delta', text: ' with extra trailing words.'},
      {type: 'tool-input-start', id: 't1', toolName: 'shell'},
      {type: 'tool-call', toolCallId: 't1', toolName: 'shell', input: {command: 'ls'}},
      {type: 'tool-result', toolCallId: 't1', toolName: 'shell', input: {command: 'ls'}, output: {ok: true, stdout: 'x'}},
      {type: 'text-delta', text: 'Here is the second segment of the'},
      {type: 'text-delta', text: ' answer, all done.'},
      {type: 'finish', finishReason: 'stop'},
    ]);
    await runHeadless({prompt: 'go', output: 'text'});
    expect(writes.join('')).toBe(
      'This is the first segment of the reply with extra trailing words.\n' +
      'Here is the second segment of the answer, all done.\n',
    );
  });

  it('returns failed with an empty result when the model streams no authoritative answer', async () => {
    const writes = captureStdout();
    const {runHeadless} = await loadRunHeadless([{type: 'finish', finishReason: 'stop'}]);
    const code = await runHeadless({prompt: 'go', output: 'json'});
    expect(JSON.parse(writes.join(''))).toMatchObject({status: 'failed', result: ''});
    expect(code).toBe(1);
  });

  it('--output json emits exactly one line (no event stream) — koan parser stays compatible', async () => {
    const writes = captureStdout();
    const {runHeadless} = await loadRunHeadless([
      {type: 'text-delta', text: 'A reasonably long first chunk of'},
      {type: 'text-delta', text: ' assistant text here.'},
      {type: 'finish', finishReason: 'stop'},
    ]);
    await runHeadless({prompt: 'go', output: 'json'});
    const lines = writes.join('').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({type: 'result', status: 'complete'});
  });

  it('--output stream-json streams NDJSON agent events, then the final result envelope', async () => {
    const writes = captureStdout();
    const {runHeadless} = await loadRunHeadless([
      {type: 'text-delta', text: 'This is the first segment of the reply'},
      {type: 'text-delta', text: ' with extra trailing words.'},
      {type: 'tool-input-start', id: 't1', toolName: 'shell'},
      {type: 'tool-call', toolCallId: 't1', toolName: 'shell', input: {command: 'ls'}},
      {type: 'tool-result', toolCallId: 't1', toolName: 'shell', input: {command: 'ls'}, output: {ok: true, stdout: 'x'}},
      {type: 'text-delta', text: 'Here is the second segment of the'},
      {type: 'text-delta', text: ' answer, all done.'},
      {type: 'finish', finishReason: 'stop'},
    ]);
    const code = await runHeadless({prompt: 'go', output: 'stream-json'});
    const lines = writes.join('').split('\n').filter(Boolean);
    // Every line is standalone valid JSON (true NDJSON — pipeable through `jq -c .`).
    const parsed = lines.map((l) => JSON.parse(l) as {type: string; status?: string; result?: string; attempt?: number; step?: number; finishReason?: string; toolCallCount?: number; usage?: Record<string, number>});
    expect(parsed.length).toBeGreaterThan(2);
    // The logical goal opens the stream, then the first physical turn starts.
    expect(parsed[0]).toMatchObject({type: 'goal_start'});
    expect(parsed[1]).toMatchObject({type: 'turn_start'});
    const types = parsed.map((p) => p.type);
    expect(types).toContain('step_start');
    expect(types).toContain('step_end');
    expect(types).toContain('tool_start');
    expect(types).toContain('tool_end');
    expect(types).toContain('turn_end');
    expect(types.filter((type) => type === 'turn_end')).toHaveLength(1);
    const stepEvents = parsed.filter((p) => p.type === 'step_start' || p.type === 'step_end');
    expect(stepEvents[0]).toMatchObject({type: 'step_start', attempt: 1, step: 1});
    expect(stepEvents[1]).toMatchObject({type: 'step_end', attempt: 1, step: 1, finishReason: 'stop', toolCallCount: 0});
    expect(stepEvents[1]?.usage).toEqual({inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 0, reasoningTokens: 0});
    const toolEvents = parsed.filter((p) => p.type === 'tool_start' || p.type === 'tool_end');
    expect(toolEvents.some((event) => 'input' in event || 'output' in event)).toBe(false);
    // The final line is the same envelope as --output json, so harnesses parse the last line identically.
    const last = parsed[parsed.length - 1];
    expect(last).toMatchObject({type: 'result', status: 'complete'});
    expect(last.result).toBe(
      'This is the first segment of the reply with extra trailing words.\n' +
      'Here is the second segment of the answer, all done.',
    );
    expect(Object.keys(last.usage ?? {}).sort()).toEqual(
      ['cacheReadTokens', 'cacheWriteTokens', 'inputTokens', 'outputTokens', 'reasoningTokens'],
    );
    expect(code).toBe(0);
  });

  it('--output stream-json exposes bounded structured tool failure diagnostics without raw output', async () => {
    const writes = captureStdout();
    const {runHeadless} = await loadRunHeadless([
      {type: 'tool-input-start', id: 't1', toolName: 'readFile'},
      {type: 'tool-call', toolCallId: 't1', toolName: 'readFile', input: {path: 'missing.ts'}},
      {type: 'tool-result', toolCallId: 't1', toolName: 'readFile', input: {path: 'missing.ts'}, output: {ok: false, toolName: 'readFile', recoverable: true, reasonCode: 'path_not_found', error: 'File not found'}},
      {type: 'finish', finishReason: 'stop'},
    ]);

    await runHeadless({prompt: 'go', output: 'stream-json'});

    const parsed = writes.join('').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    const toolEnd = parsed.find(event => event.type === 'tool_end');
    expect(toolEnd).toMatchObject({type: 'tool_end', name: 'readFile', success: false, errorCode: 'path_not_found', error: 'File not found'});
    expect(toolEnd).not.toHaveProperty('output');
  });

  it('--output stream-json still prints a final failed envelope when the turn fails', async () => {
    const writes = captureStdout();
    const {runHeadless} = await loadRunHeadless(
      [{type: 'text-delta', text: 'Some partial work before the failure here.'}],
      [],
      new Error('boom'),
    );
    const code = await runHeadless({prompt: 'go', output: 'stream-json'});
    const lines = writes.join('').split('\n').filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l) as {type: string; status?: string});
    // Events streamed before the failure, then one public turn_end/goal_end and a terminal result envelope.
    expect(parsed[0]).toMatchObject({type: 'goal_start'});
    expect(parsed[parsed.length - 3]).toMatchObject({type: 'turn_end', status: 'failed'});
    expect(parsed[parsed.length - 2]).toMatchObject({type: 'goal_end', status: 'failed'});
    expect(parsed[parsed.length - 1]).toMatchObject({type: 'result', status: 'failed'});
    expect(code).toBe(1);
  });
});
