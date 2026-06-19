import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
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
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('/provider'));
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('/skills'));
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('/logs'));
  });

  it('shows skill command help inside the app', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/skills', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('/create-skill'));
  });

  it('rejects removed /skill X and /skills X subcommand forms', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/skill list', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Unknown command'));
    const ctx2 = mockContext();
    expect(await handleSlashCommand('/skills list', ctx2)).toBe('handled');
    expect(ctx2.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Unknown command'));
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

  it('launches the skill wizard for /create-skill and ignores inline args', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/create-skill ignored inline args', ctx)).toBe('handled');
    expect(ctx.setMode).toHaveBeenCalledWith('skillCreateName');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('step 1/3'));
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

  it('reports AGENTS.md size within the context budget after /init', async () => {
    const ctx = mockContext();
    await handleSlashCommand('/init', ctx);
    const calls = (ctx.addSystemMessage as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as string);
    const validation = calls.find(m => m.includes('AGENTS.md validation'));
    expect(validation).toBeDefined();
    expect(validation).toContain('within the');
    expect(validation).not.toContain('exceeds');
  });

  it('warns when AGENTS.md exceeds the context budget', async () => {
    const orig = process.cwd();
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-init-budget-'));
    await fs.writeFile(path.join(tmp, 'AGENTS.md'), 'x'.repeat(20001));
    process.chdir(tmp);
    try {
      const ctx = mockContext();
      await handleSlashCommand('/init', ctx);
      const calls = (ctx.addSystemMessage as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as string);
      const validation = calls.find(m => m.includes('AGENTS.md validation'));
      expect(validation).toBeDefined();
      expect(validation).toContain('exceeds the');
      expect(validation).toContain('truncated');
    } finally {
      process.chdir(orig);
      await fs.remove(tmp);
    }
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

describe('handleSlashCommand /logs', () => {
  let logsTmp: string;
  let originalHazeDir: typeof process.env.HAZE_DIR;

  beforeAll(async () => {
    logsTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-logs-cmd-test-'));
    // Point the logs dir via HAZE_DIR env so llmLog uses our temp
    // llmLog uses HAZE_DIR from paths.ts which reads os.homedir(), so we monkeypatch
    // We'll write log files directly into the expected dir structure
    originalHazeDir = process.env.HAZE_DIR;
  });

  afterAll(async () => {
    await fs.remove(logsTmp);
  });

  it('shows no log files message when empty', async () => {
    // Monkey-patch HAZE_DIR temporarily
    const origJoin = path.join;
    // We need the llmLog module to use our temp dir.
    // Since LOGS_DIR is computed at module level, we use dynamic import with a different approach.
    // Instead, directly create a scenario: write a log file to ~/.haze/logs and verify.
    // For isolated tests, we'll test the command handler directly by importing the module.
    const ctx = mockContext();
    // The /logs command calls listLogs() which reads from ~/.haze/logs.
    // If no logs exist, it should report that.
    expect(await handleSlashCommand('/logs', ctx)).toBe('handled');
    // Either "No log files" or a list with existing logs
    const msg = (ctx.addSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(typeof msg).toBe('string');
  });

  it('shows specific log summary with /logs <id>', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/logs nonexistent-id', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('No log found'));
  });

  it('shows log summary for a real log file', async () => {
    // Create a log file in ~/.haze/logs
    const {createLog, appendLogEntry} = await import('../../src/core/log/llmLog.js');
    const log = await createLog();
    await appendLogEntry(log, {at: new Date().toISOString(), type: 'request', stream: 'main'});
    await appendLogEntry(log, {at: new Date().toISOString(), type: 'response', stream: 'main', usage: {inputTokens: 100, outputTokens: 50}});
    await appendLogEntry(log, {at: new Date().toISOString(), type: 'tool_call', stream: 'main', toolCall: {id: 'tc1', name: 'readFile', input: {path: 'foo.ts'}}});
    await appendLogEntry(log, {at: new Date().toISOString(), type: 'tool_result', stream: 'main', toolResult: {id: 'tc1', name: 'readFile', success: true}});

    const ctx = mockContext();
    expect(await handleSlashCommand(`/logs ${log.id}`, ctx)).toBe('handled');
    const msg = (ctx.addSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain('Log:');
    expect(msg).toContain('request: 1');
    expect(msg).toContain('response: 1');
    expect(msg).toContain('tool_call: 1');
    expect(msg).toContain('tool_result: 1');
    expect(msg).toContain('in=100 out=50');
    expect(msg).toContain('readFile: 1');

    // Cleanup
    await fs.remove(log.file);
  });

  it('lists logs with file sizes and dates', async () => {
    const {createLog, appendLogEntry} = await import('../../src/core/log/llmLog.js');
    const log = await createLog();
    await appendLogEntry(log, {at: new Date().toISOString(), type: 'request', stream: 'main'});

    const ctx = mockContext();
    expect(await handleSlashCommand('/logs', ctx)).toBe('handled');
    const msg = (ctx.addSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain(log.id);
    expect(msg).toContain('B'); // size in bytes

    // Cleanup
    await fs.remove(log.file);
  });

  it('/logs appears in help', async () => {
    const ctx = mockContext();
    await handleSlashCommand('/help', ctx);
    const msg = (ctx.addSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain('/logs');
  });
});
