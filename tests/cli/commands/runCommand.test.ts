import {afterEach, describe, expect, it, vi} from 'vitest';

async function loadRunCommand(runAgentTurnImpl: (callbacks: any) => Promise<void>) {
  // runAgentTurn signature: (value, displayValue, contextFiles, callbacks, ...) — callbacks is the 4th arg.
  const wrapped = async (_value: unknown, _display: unknown, _ctx: unknown, callbacks: any) => runAgentTurnImpl(callbacks);
  vi.doMock('../../../src/cli/commands/streaming.js', () => ({runAgentTurn: vi.fn(wrapped)}));
  vi.doMock('../../../src/config/contextFiles.js', () => ({readContextFiles: async () => []}));
  vi.resetModules();
  return import('../../../src/cli/commands/runCommand.js');
}

describe('runHeadless', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('joins visible assistant segments and prints text', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((b: any) => {
      writes.push(String(b));
      return true;
    });
    const {runHeadless} = await loadRunCommand(async (cb: any) => {
      cb.addMessage({id: 'a1', role: 'assistant', text: 'First part.', streaming: false});
      cb.addMessage({id: 't1', role: 'tool', text: '...'}); // ignored
      cb.addMessage({id: 'a2', role: 'assistant', text: 'Second part.', streaming: false, hidden: false});
    });
    await runHeadless({prompt: 'do it', output: 'text'});
    expect(writes.join('')).toBe('First part.\nSecond part.\n');
  });

  it('emits a JSON envelope with result and usage', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((b: any) => {
      writes.push(String(b));
      return true;
    });
    const {runHeadless} = await loadRunCommand(async (cb: any) => {
      cb.addMessage({id: 'a1', role: 'assistant', text: 'Done.', streaming: false});
      cb.recordTokenUsage?.({inputTokens: 10, outputTokens: 5});
    });
    await runHeadless({prompt: 'do it', output: 'json'});
    const parsed = JSON.parse(writes.join(''));
    expect(parsed).toMatchObject({type: 'result', result: 'Done.', status: 'complete'});
    expect(parsed.usage).toMatchObject({inputTokens: 10, outputTokens: 5});
  });

  it('prints guidance to stderr and returns non-zero when no model is configured', async () => {
    const errs: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((b: any) => {
      errs.push(String(b));
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const {runHeadless} = await loadRunCommand(async (cb: any) => {
      // runAgentTurn's "no model" branch emits the guidance assistant message and returns.
      cb.addMessage({role: 'assistant', text: 'No model provider configured. Run /provider to choose or add a provider. Haze cannot hallucinate without a model. Progress.'});
    });
    const code = await runHeadless({prompt: 'hi', output: 'text'});
    expect(code).not.toBe(0);
    expect(errs.join('')).toMatch(/No model provider configured|\/provider/);
  });
});