import {afterEach, describe, expect, it, vi} from 'vitest';

const PROVIDER_SETTINGS = {providers: [{name: 'openai', url: 'https://x/v1', key: 'k', models: ['gpt-4o-mini']}], provider: 'openai'};

function fullUsage(partial: {inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number}) {
  return {
    inputTokens: partial.inputTokens, outputTokens: partial.outputTokens,
    systemPrompt: 0, messages: 0, toolSchemas: 0, outputEstimate: 0,
    cacheReadTokens: partial.cacheReadTokens ?? 0, cacheWriteTokens: partial.cacheWriteTokens ?? 0,
    noCacheTokens: 0, reasoningTokens: partial.reasoningTokens ?? 0, logicalInputEstimate: 0, effectiveNonCachedInput: undefined,
  };
}

async function loadRunCommand(opts: {runAgentTurnImpl?: (callbacks: any) => void | Promise<void>; status?: 'complete' | 'aborted' | 'failed'; settings?: unknown}) {
  const status = opts.status ?? 'complete';
  const runAgentTurn = vi.fn(async (_value: unknown, _display: unknown, _ctx: unknown, callbacks: any) => {
    await opts.runAgentTurnImpl?.(callbacks);
    return {status};
  });
  vi.doMock('../../../src/cli/commands/streaming.js', () => ({runAgentTurn}));
  vi.doMock('../../../src/config/contextFiles.js', () => ({readContextFiles: async () => []}));
  vi.doMock('../../../src/config/settings.js', () => ({readSettings: async () => opts.settings ?? PROVIDER_SETTINGS}));
  vi.resetModules();
  const mod = await import('../../../src/cli/commands/runCommand.js');
  return {...mod, runAgentTurn};
}

function captureStdout() {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((b: any) => {
    writes.push(String(b));
    return true;
  });
  return writes;
}

function captureStderr() {
  const errs: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((b: any) => {
    errs.push(String(b));
    return true;
  });
  return errs;
}

describe('runHeadless: output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('joins finalized assistant segments, patching streamed text via updateMessage', async () => {
    const writes = captureStdout();
    const {runHeadless} = await loadRunCommand({
      runAgentTurnImpl: (cb) => {
        // Real two-stage protocol: streaming addMessage carries a partial, updateMessage finalizes.
        cb.addMessage({id: 'a1', role: 'assistant', text: 'First', streaming: true});
        cb.updateMessage('a1', {text: 'First part.', streaming: false, hidden: false});
        cb.addMessage({id: 't1', role: 'tool', text: '...'}); // ignored (not assistant)
        cb.addMessage({id: 'a2', role: 'assistant', text: 'Second part.', streaming: false, hidden: false});
      },
    });
    await runHeadless({prompt: 'do it', output: 'text'});
    expect(writes.join('')).toBe('First part.\nSecond part.\n');
  });

  it('drops a segment finalized as hidden', async () => {
    const writes = captureStdout();
    const {runHeadless} = await loadRunCommand({
      runAgentTurnImpl: (cb) => {
        cb.addMessage({id: 'a1', role: 'assistant', text: 'Visible.', streaming: false});
        cb.addMessage({id: 'a2', role: 'assistant', text: 'bridge', streaming: true});
        cb.updateMessage('a2', {text: 'bridge', streaming: false, hidden: true});
      },
    });
    await runHeadless({prompt: 'do it', output: 'text'});
    expect(writes.join('')).toBe('Visible.\n');
  });

  it('emits a JSON envelope with status, result, and a pinned usage shape', async () => {
    const writes = captureStdout();
    const {runHeadless} = await loadRunCommand({
      runAgentTurnImpl: (cb) => {
        cb.addMessage({id: 'a1', role: 'assistant', text: 'Done.', streaming: false});
        cb.recordTokenUsage?.(fullUsage({inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2, reasoningTokens: 3}));
      },
    });
    await runHeadless({prompt: 'do it', output: 'json'});
    const parsed = JSON.parse(writes.join(''));
    expect(parsed).toMatchObject({type: 'result', result: 'Done.', status: 'complete'});
    expect(parsed.usage).toEqual({inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2, reasoningTokens: 3});
    // Internal estimation fields must not leak into the CI parse contract.
    expect(parsed.usage).not.toHaveProperty('systemPrompt');
    expect(parsed.usage).not.toHaveProperty('logicalInputEstimate');
  });

  it('treats an empty assistant response as status complete with an empty result', async () => {
    const writes = captureStdout();
    const {runHeadless} = await loadRunCommand({runAgentTurnImpl: () => undefined});
    const code = await runHeadless({prompt: 'do it', output: 'json'});
    const parsed = JSON.parse(writes.join(''));
    expect(parsed).toMatchObject({status: 'complete', result: ''});
    expect(code).toBe(0);
  });

  it('reports a failed turn status to stderr with a non-zero exit (text mode)', async () => {
    const errs = captureStderr();
    captureStdout();
    const {runHeadless} = await loadRunCommand({
      status: 'failed',
      runAgentTurnImpl: (cb) => cb.addMessage({role: 'assistant', text: 'Model call failed: boom'}),
    });
    const code = await runHeadless({prompt: 'do it', output: 'text'});
    expect(code).toBe(1);
    expect(errs.join('')).toMatch(/Model call failed: boom/);
  });

  it('emits status failed in the JSON envelope and exits non-zero', async () => {
    const writes = captureStdout();
    const {runHeadless} = await loadRunCommand({
      status: 'failed',
      runAgentTurnImpl: (cb) => cb.addMessage({role: 'assistant', text: 'Model call failed: boom'}),
    });
    const code = await runHeadless({prompt: 'do it', output: 'json'});
    expect(JSON.parse(writes.join('')).status).toBe('failed');
    expect(code).toBe(1);
  });
});

describe('runHeadless: model pre-resolution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('errors with a non-zero exit and never invokes the agent when no provider is configured', async () => {
    const errs = captureStderr();
    captureStdout();
    const {runHeadless, runAgentTurn} = await loadRunCommand({settings: {providers: []}});
    const code = await runHeadless({prompt: 'hi', output: 'text'});
    expect(code).toBe(1);
    expect(errs.join('')).toMatch(/No model provider configured/);
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it('reports a precise "no configured model" error for an unknown --model selector', async () => {
    const errs = captureStderr();
    captureStdout();
    const {runHeadless, runAgentTurn} = await loadRunCommand({settings: PROVIDER_SETTINGS});
    const code = await runHeadless({prompt: 'hi', modelOverride: 'nonexistent', output: 'text'});
    expect(code).toBe(1);
    expect(errs.join('')).toMatch(/No configured model named nonexistent/);
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it('reports an ambiguous --model selector across multiple providers', async () => {
    const errs = captureStderr();
    captureStdout();
    const {runHeadless, runAgentTurn} = await loadRunCommand({
      settings: {providers: [
        {name: 'a', url: 'https://a/v1', models: ['shared']},
        {name: 'b', url: 'https://b/v1', models: ['shared']},
      ]},
    });
    const code = await runHeadless({prompt: 'hi', modelOverride: 'shared', output: 'text'});
    expect(code).toBe(1);
    expect(errs.join('')).toMatch(/exists on multiple providers/);
    expect(runAgentTurn).not.toHaveBeenCalled();
  });
});
