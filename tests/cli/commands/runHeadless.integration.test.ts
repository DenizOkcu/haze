import {afterEach, describe, expect, it, vi} from 'vitest';

// These tests exercise the REAL runAgentTurn (not a stub) wired into runHeadless, with only
// the model/provider/context boundaries mocked. This is the regression guard for the bug where
// headless dropped the finalized assistant text emitted via updateMessage and only kept the
// initial streamed partial from addMessage.

const PROVIDER_SETTINGS = {providers: [{name: 'openai', url: 'https://x/v1', key: 'k', models: ['gpt-4o-mini']}], provider: 'openai'};

interface FakePart {
  type: string;
  [key: string]: unknown;
}

async function loadRunHeadless(parts: FakePart[], responseMessages: unknown[] = []) {
  vi.doMock('../../../src/llm/client.js', () => ({
    modelWithConfig: async () => ({
      model: {modelId: 'test'},
      config: {providerName: 'test', baseURL: 'http://x', modelName: 'm', cacheKey: 'k', capabilities: {}},
    }),
    providerRequestSettings: () => ({}),
  }));
  vi.doMock('../../../src/llm/requestContext.js', () => ({
    assembleRequestContext: async () => ({
      systemPrompt: 'You are Haze.',
      availableTools: {bash: {description: 'bash', execute: async () => ({ok: true})}},
      toolCategories: new Map([['bash', 'builtin']]),
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
        return {
          fullStream: (async function* () {
            for (const part of parts) yield part;
          })(),
          response: Promise.resolve({messages: responseMessages}),
        };
      }
    }
    return {...actual, ToolLoopAgent: FakeToolLoopAgent, stepCountIs: (n: number) => ({steps: n})};
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
      {type: 'tool-input-start', id: 't1', toolName: 'bash'},
      {type: 'tool-call', toolCallId: 't1', toolName: 'bash', input: {command: 'ls'}},
      {type: 'tool-result', toolCallId: 't1', toolName: 'bash', input: {command: 'ls'}, output: {ok: true, stdout: 'x'}},
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

  it('returns status complete with an empty result when the model streams no text', async () => {
    const writes = captureStdout();
    const {runHeadless} = await loadRunHeadless([{type: 'finish', finishReason: 'stop'}]);
    const code = await runHeadless({prompt: 'go', output: 'json'});
    expect(JSON.parse(writes.join(''))).toMatchObject({status: 'complete', result: ''});
    expect(code).toBe(0);
  });
});
