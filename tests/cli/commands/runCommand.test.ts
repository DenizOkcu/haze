import {afterEach, describe, expect, it, vi} from 'vitest';

const PROVIDER_SETTINGS = {providers: [{name: 'openai', url: 'https://x/v1', key: 'k', models: ['gpt-4o-mini']}], provider: 'openai', model: 'gpt-4o-mini'};

function fullUsage(partial: {inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number}) {
  return {
    inputTokens: partial.inputTokens, outputTokens: partial.outputTokens,
    systemPrompt: 0, messages: 0, toolSchemas: 0, outputEstimate: 0,
    cacheReadTokens: partial.cacheReadTokens ?? 0, cacheWriteTokens: partial.cacheWriteTokens ?? 0,
    noCacheTokens: 0, reasoningTokens: partial.reasoningTokens ?? 0, logicalInputEstimate: 0, effectiveNonCachedInput: undefined,
  };
}

async function loadRunCommand(opts: {runAgentTurnImpl?: (callbacks: any) => void | Promise<void>; status?: 'complete' | 'aborted' | 'failed'; evidence?: unknown; settings?: unknown; sessionFound?: boolean; sessionMessages?: unknown[]; sessionParseErrors?: string[]}) {
  const status = opts.status ?? 'complete';
  const runAgentTurn = vi.fn(async (_value: unknown, _display: unknown, _ctx: unknown, callbacks: any) => {
    await opts.runAgentTurnImpl?.(callbacks);
    return {status, ...(opts.evidence ? {evidence: opts.evidence} : {})};
  });
  vi.doMock('../../../src/cli/commands/streaming.js', () => ({runAgentTurn}));
  vi.doMock('../../../src/config/contextFiles.js', () => ({readContextFiles: async () => []}));
  vi.doMock('../../../src/config/settings.js', () => ({readSettings: async () => opts.settings ?? PROVIDER_SETTINGS}));
  vi.doMock('../../../src/core/log/llmLog.js', () => ({createLog: async () => ({file: '/tmp/stub-llm.jsonl'}), endLog: async () => undefined}));
  vi.doMock('../../../src/core/session/sessionStore.js', () => ({
    findSession: async (id: string) => opts.sessionFound === false ? undefined : ({id, file: `/tmp/${id}.jsonl`, cwd: process.cwd()}),
    restoreSessionState: async () => ({messages: opts.sessionMessages ?? [], workState: undefined, parseErrors: opts.sessionParseErrors ?? []}),
  }));
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

  it('includes bounded completion evidence additively in the JSON envelope', async () => {
    const writes = captureStdout();
    const {runHeadless} = await loadRunCommand({
      runAgentTurnImpl: (cb) => {
        cb.addMessage({id: 'a1', role: 'assistant', text: 'Done.', streaming: false});
      },
      evidence: {validationOutcome: 'passed', validationKind: 'test', validationAfterMutation: true, mutationCount: 1, finishCause: 'stop', recoveryUsed: {length: false, rescue: false}, budgetBoundary: false},
    });
    await runHeadless({prompt: 'do it', output: 'json'});
    const parsed = JSON.parse(writes.join(''));
    expect(parsed.evidence).toMatchObject({validationOutcome: 'passed', finishCause: 'stop', recoveryUsed: {length: false, rescue: false}});
    // Evidence must never carry raw commands, output, or secrets.
    const json = JSON.stringify(parsed.evidence);
    for (const forbidden of ['command', 'stdout', 'stderr', 'error', 'key', 'token']) {
      expect(json).not.toContain(forbidden);
    }
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
    // The documented CI contract is exactly these five keys — no undefined leakage via
    // JSON.stringify drop, no extra fields. Guards the pinnedUsage normalization.
    expect(Object.keys(parsed.usage).sort()).toEqual(['cacheReadTokens', 'cacheWriteTokens', 'inputTokens', 'outputTokens', 'reasoningTokens']);
  });

  it('treats an empty assistant response as status complete with an empty result', async () => {
    const writes = captureStdout();
    const {runHeadless} = await loadRunCommand({runAgentTurnImpl: () => undefined});
    const code = await runHeadless({prompt: 'do it', output: 'json'});
    const parsed = JSON.parse(writes.join(''));
    expect(parsed).toMatchObject({status: 'complete', result: ''});
    // Even with no token reports, the usage envelope must be the full documented shape
    // (all five fields present as 0, no undefined dropped by JSON.stringify).
    expect(parsed.usage).toEqual({inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0});
    expect(Object.keys(parsed.usage).sort()).toEqual(['cacheReadTokens', 'cacheWriteTokens', 'inputTokens', 'outputTokens', 'reasoningTokens']);
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

describe('runHeadless: debug output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints [haze] debug lines on stderr when --debug is set', async () => {
    const errs = captureStderr();
    captureStdout();
    const {runHeadless} = await loadRunCommand({
      runAgentTurnImpl: (cb) => cb.debugLog('tool start: bash ls'),
    });
    await runHeadless({prompt: 'do it', output: 'text', debug: true});
    expect(errs.some((line) => line.startsWith('[haze] tool start: bash ls'))).toBe(true);
  });

  it('keeps stderr clean without --debug (regression CR-003)', async () => {
    const errs = captureStderr();
    captureStdout();
    const {runHeadless} = await loadRunCommand({
      runAgentTurnImpl: (cb) => cb.debugLog('tool start: bash ls'),
    });
    const code = await runHeadless({prompt: 'do it', output: 'text'});
    expect(code).toBe(0);
    expect(errs.join('')).not.toContain('[haze]');
  });
});

describe('runHeadless: exact session resume', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads a selected session as the initial one-turn context without writing it (F02)', async () => {
    captureStdout();
    const saved = [{role: 'user', content: 'saved request'}, {role: 'assistant', content: 'saved answer'}];
    const {runHeadless, runAgentTurn} = await loadRunCommand({
      sessionMessages: saved,
      runAgentTurnImpl: cb => {
        expect(cb.getConversation()).toEqual(saved);
        cb.addMessage({role: 'assistant', text: 'continued'});
      },
    });
    const code = await runHeadless({prompt: 'next', resumeSessionId: 'session-1', output: 'text'});
    expect(code).toBe(0);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });

  it('fails loudly for an unknown selected session before invoking the model (F02)', async () => {
    captureStdout();
    const errs = captureStderr();
    const {runHeadless, runAgentTurn} = await loadRunCommand({sessionFound: false});
    const code = await runHeadless({prompt: 'next', resumeSessionId: 'missing', output: 'text'});
    expect(code).toBe(1);
    expect(errs.join('')).toContain('No session named missing exists for this workspace.');
    expect(runAgentTurn).not.toHaveBeenCalled();
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

describe('runHeadless: stream-json deltas (RH-006)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits message_update as deltas that reconstruct message_end and stay linear', async () => {
    const writes = captureStdout();
    const {runHeadless} = await loadRunCommand({
      runAgentTurnImpl: (cb) => {
        cb.onEvent?.({type: 'message_start', id: 'a1', role: 'assistant', at: 't'} as any);
        const cumulative = ['Hello', 'Hello world', 'Hello world this is', 'Hello world this is a test'];
        for (const text of cumulative) cb.onEvent?.({type: 'message_update', id: 'a1', text, at: 't'} as any);
        cb.onEvent?.({type: 'message_end', id: 'a1', text: 'Hello world this is a test', at: 't'} as any);
      },
    });
    await runHeadless({prompt: 'hi', output: 'stream-json'});
    const lines = writes.join('').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    const updates = lines.filter(line => line.type === 'message_update');
    const end = lines.find(line => line.type === 'message_end');
    expect(end?.text).toBe('Hello world this is a test');
    // Deltas reconstruct the authoritative final text exactly.
    const reconstructed = updates.map(update => String(update.delta)).join('');
    expect(reconstructed).toBe(end?.text);
    // Total update payload is linear in the final text size, not quadratic.
    const totalDeltaBytes = updates.reduce((sum, update) => sum + String(update.delta).length, 0);
    expect(totalDeltaBytes).toBeLessThanOrEqual(String(end?.text).length);
  });
});

describe('parseTurnTimeoutMs', () => {
  it('accepts ms/s/m/h units and raw ms', async () => {
    const {parseTurnTimeoutMs} = await loadRunCommand({});
    expect(parseTurnTimeoutMs(undefined)).toBeUndefined();
    expect(parseTurnTimeoutMs('')).toBeUndefined();
    expect(parseTurnTimeoutMs('2000ms')).toBe(2000);
    expect(parseTurnTimeoutMs('30s')).toBe(30_000);
    expect(parseTurnTimeoutMs('10m')).toBe(600_000);
    expect(parseTurnTimeoutMs('2h')).toBe(7_200_000);
    expect(parseTurnTimeoutMs('1500')).toBe(1500);
  });

  it('rejects malformed or out-of-range durations', async () => {
    const {parseTurnTimeoutMs} = await loadRunCommand({});
    expect(() => parseTurnTimeoutMs('soon')).toThrow();
    expect(() => parseTurnTimeoutMs('100ms')).toThrow(/at least 1 second/);
    expect(() => parseTurnTimeoutMs('48h')).toThrow(/at most 24 hours/);
  });
});
