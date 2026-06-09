import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {handleSlashCommand, type CommandContext} from '../../src/cli/commands/commands.js';

let tmp: string;
let originalCwd: typeof process.cwd;

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
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('/provider'));
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('/skills'));
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('/tasks'));
  });

  it('shows skill command help inside the app', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/skills', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('/list-skills'));
  });

  it('handles one-word and legacy skill list commands', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/list-skills', ctx)).toBe('handled');
    expect(await handleSlashCommand('/skill list', ctx)).toBe('handled');
    expect(await handleSlashCommand('/skills list', ctx)).toBe('handled');
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

  it('enters model mode for /model', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/model', ctx)).toBe('handled');
    expect(ctx.setMode).toHaveBeenCalledWith('model');
  });

  it('sets model directly with /model <name>', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/model gpt-4', ctx)).toBe('handled');
    expect(ctx.updateSettings).toHaveBeenCalledWith(expect.objectContaining({provider: 'openrouter', model: 'gpt-4'}));
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('~/.haze/settings.json'));
  });

  it('enters provider mode for /provider', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/provider', ctx)).toBe('handled');
    expect(ctx.setMode).toHaveBeenCalledWith('provider');
  });

  it('sets provider and model for qualified model selectors', async () => {
    const ctx = mockContext({
      settings: {providers: [{name: 'local', url: 'http://localhost:1234/v1', models: ['llama3.1']}]},
    });
    expect(await handleSlashCommand('/model local:llama3.1', ctx)).toBe('handled');
    expect(ctx.updateSettings).toHaveBeenCalledWith({provider: 'local', model: 'llama3.1'});
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

describe('handleSlashCommand /tasks', () => {
  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-tasks-cmd-test-'));
    await fs.ensureDir(tmp);
    originalCwd = process.cwd;
    process.cwd = () => tmp;
  });

  afterAll(async () => {
    process.cwd = originalCwd;
    await fs.remove(tmp);
  });

  it('shows empty tasks message', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/tasks', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('No tasks'));
  });

  it('adds a task', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/tasks add Write tests', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Added'));
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Write tests'));
  });

  it('shows error when add has no title', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/tasks add', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });

  it('shows task list after adding', async () => {
    const ctx = mockContext();
    await handleSlashCommand('/tasks add First task', ctx);
    const ctx2 = mockContext();
    await handleSlashCommand('/tasks', ctx2);
    expect(ctx2.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('First task'));
  });

  it('removes a task by number', async () => {
    const ctx = mockContext();
    await handleSlashCommand('/tasks add To remove', ctx);
    const ctx2 = mockContext();
    expect(await handleSlashCommand('/tasks remove 1', ctx2)).toBe('handled');
    expect(ctx2.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Removed'));
  });

  it('removes with rm alias', async () => {
    const ctx = mockContext();
    await handleSlashCommand('/tasks add Alias test', ctx);
    const ctx2 = mockContext();
    expect(await handleSlashCommand('/tasks rm 1', ctx2)).toBe('handled');
    expect(ctx2.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Removed'));
  });

  it('shows error when remove has no number', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/tasks remove', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });

  it('shows error for invalid task number', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/tasks remove abc', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('valid task number'));
  });

  it('shows error for out-of-range task number', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/tasks remove 99', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  it('clears all tasks', async () => {
    const ctx = mockContext();
    await handleSlashCommand('/tasks add Task A', ctx);
    const ctx2 = mockContext();
    expect(await handleSlashCommand('/tasks clear', ctx2)).toBe('handled');
    expect(ctx2.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('cleared'));
    const ctx3 = mockContext();
    await handleSlashCommand('/tasks', ctx3);
    expect(ctx3.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('No tasks'));
  });

  it('treats unknown subcommand as task title', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/tasks Fix the bug', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Fix the bug'));
  });

  it('case-insensitive subcommands', async () => {
    const ctx = mockContext();
    await handleSlashCommand('/tasks ADD Upper task', ctx);
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Upper task'));
  });
});
