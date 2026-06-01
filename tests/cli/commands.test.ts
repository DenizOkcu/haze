import {describe, it, expect, vi} from 'vitest';
import {handleSlashCommand, type CommandContext} from '../../src/cli/commands/commands.js';

function mockContext(overrides?: Partial<CommandContext>): CommandContext {
  return {
    settings: {provider: 'openrouter', apiKey: 'test-key', model: 'test-model'},
    contextFiles: [],
    setMode: vi.fn(),
    addSystemMessage: vi.fn(),
    clearConversation: vi.fn(),
    runAgentTurn: vi.fn(),
    refreshContextFiles: vi.fn(() => Promise.resolve([])),
    updateSettings: vi.fn(() => Promise.resolve({model: 'new-model'})),
    ...overrides,
  };
}

describe('handleSlashCommand', () => {
  it('returns exit for /exit', async () => {
    expect(await handleSlashCommand('/exit', mockContext())).toBe('exit');
  });

  it('returns exit for /quit', async () => {
    expect(await handleSlashCommand('/quit', mockContext())).toBe('exit');
  });

  it('shows help for /help', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/help', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('/login'));
  });

  it('clears conversation for /clear', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/clear', ctx)).toBe('handled');
    expect(ctx.clearConversation).toHaveBeenCalled();
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Cleared'));
  });

  it('shows settings for /settings', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/settings', ctx)).toBe('handled');
    const msg = (ctx.addSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain('openrouter');
    expect(msg).toContain('test-model');
    expect(msg).toContain('saved');
  });

  it('shows missing api key in settings', async () => {
    const ctx = mockContext({settings: {}});
    await handleSlashCommand('/settings', ctx);
    const msg = (ctx.addSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain('missing');
  });

  it('enters apiKey mode for /login', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/login', ctx)).toBe('handled');
    expect(ctx.setMode).toHaveBeenCalledWith('apiKey');
  });

  it('enters model mode for /model', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/model', ctx)).toBe('handled');
    expect(ctx.setMode).toHaveBeenCalledWith('model');
  });

  it('sets model directly with /model <name>', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/model gpt-4', ctx)).toBe('handled');
    expect(ctx.updateSettings).toHaveBeenCalledWith({model: 'gpt-4'});
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('~/.haze/settings.json'));
  });

  it('calls runAgentTurn for /init', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/init', ctx)).toBe('handled');
    expect(ctx.runAgentTurn).toHaveBeenCalledWith(expect.any(String), '/init');
    expect(ctx.refreshContextFiles).toHaveBeenCalled();
  });

  it('reports unknown commands', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/unknown', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Unknown command'));
  });

  it('returns unhandled for non-slash input', async () => {
    expect(await handleSlashCommand('hello', mockContext())).toBe('unhandled');
  });

  it('returns unhandled for empty string', async () => {
    expect(await handleSlashCommand('', mockContext())).toBe('unhandled');
  });
});
