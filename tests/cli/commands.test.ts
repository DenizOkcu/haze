import {afterAll, describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import type {CommandContext} from '../../src/cli/commands/commands.js';

const commandHome = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-commands-test-'));
vi.doMock('../../src/config/paths.js', () => ({
  HAZE_DIR: commandHome,
  GLOBAL_SKILLS_DIR: path.join(commandHome, 'skills'),
}));
const openPathSpy = vi.fn();
vi.doMock('../../src/utils/openPath.js', () => ({openPath: openPathSpy}));
const {handleSlashCommand} = await import('../../src/cli/commands/commands.js');

afterAll(async () => {
  await fs.remove(commandHome);
});

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
    getSessionReasoning: vi.fn(() => undefined),
    setSessionReasoning: vi.fn(),
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
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('/lsp'));
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('/context'));
  });

  it('opens the skills picker from /skills', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/skills', ctx)).toBe('handled');
    expect(ctx.setMode).toHaveBeenCalledWith('skills');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('add skill'));
  });

  it('rejects removed /skill X and /skills X subcommand forms', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/skill list', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Unknown command'));
    const ctx2 = mockContext();
    expect(await handleSlashCommand('/skills list', ctx2)).toBe('handled');
    expect(ctx2.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Unknown command'));
  });

  it('clears conversation for /clear without duplicating the Cleared. message', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/clear', ctx)).toBe('handled');
    expect(ctx.clearConversation).toHaveBeenCalled();
    // "Cleared. …" is owned by clearConversation(); the handler must not add it again (CR-002).
    expect(ctx.addSystemMessage).not.toHaveBeenCalled();
  });

  it('shows settings for /settings', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/settings', ctx)).toBe('handled');
    const msg = (ctx.addSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain('openrouter');
    expect(msg).toContain('test-model');
    expect(msg).toContain('saved');
    expect(msg).toContain('Skills:');
  });

  it('shows missing api key in settings', async () => {
    const ctx = mockContext({settings: {}});
    await handleSlashCommand('/settings', ctx);
    const msg = (ctx.addSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain('missing');
  });

  it('opens the settings file via the platform handler for /settings open', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/settings open', ctx)).toBe('handled');
    expect(openPathSpy).toHaveBeenCalledTimes(1);
    expect(openPathSpy.mock.calls[0]?.[0]).toContain('settings.json');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Opened settings file'));
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

  it('opens the theme picker from /themes', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/themes', ctx)).toBe('handled');
    expect(ctx.setMode).toHaveBeenCalledWith('themes');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Choose a theme'));
  });

  it('sets the theme directly with /themes <name>', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/themes robbyrussell', ctx)).toBe('handled');
    expect(ctx.updateSettings).toHaveBeenCalledWith({theme: 'robbyrussell'});
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Theme set to robbyrussell'));
  });

  it('rejects unknown theme names with the valid names listed', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/themes nope', ctx)).toBe('handled');
    expect(ctx.updateSettings).not.toHaveBeenCalled();
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Unknown theme name "nope"'));
  });

  it('opens the reasoning picker from /reasoning', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/reasoning', ctx)).toBe('handled');
    expect(ctx.setMode).toHaveBeenCalledWith('reasoning');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Choose a reasoning effort level'));
  });

  it('sets the session per-model reasoning level with /reasoning <level>', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/reasoning xhigh', ctx)).toBe('handled');
    expect(ctx.setSessionReasoning).toHaveBeenCalledWith('openrouter:test-model', 'xhigh');
    expect(ctx.updateSettings).not.toHaveBeenCalled();
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Reasoning effort set to xhigh'));
  });

  it('accepts every reasoning level through the slash command', async () => {
    for (const level of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const) {
      const ctx = mockContext();
      expect(await handleSlashCommand(`/reasoning ${level}`, ctx)).toBe('handled');
      expect(ctx.setSessionReasoning, level).toHaveBeenCalledWith('openrouter:test-model', level);
      expect(ctx.updateSettings, level).not.toHaveBeenCalled();
    }
  });

  it('stores unset as the provider-default sentinel per model with /reasoning unset', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/reasoning unset', ctx)).toBe('handled');
    expect(ctx.setSessionReasoning).toHaveBeenCalledWith('openrouter:test-model', 'provider-default');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Reasoning effort unset'));
  });

  it('removes the session override with /reasoning reset and reports the fallback', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/reasoning reset', ctx)).toBe('handled');
    expect(ctx.setSessionReasoning).toHaveBeenCalledWith('openrouter:test-model', undefined);
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Session reasoning override removed'));
  });

  it('rejects an unknown reasoning level with the valid levels listed', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/reasoning max', ctx)).toBe('handled');
    expect(ctx.setSessionReasoning).not.toHaveBeenCalled();
    expect(ctx.updateSettings).not.toHaveBeenCalled();
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Unknown reasoning level "max"'));
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('none, minimal, low, medium, high, xhigh'));
  });

  it('shows the effective reasoning level per model from /reasoning status', async () => {
    const ctx = mockContext({settings: {provider: 'openrouter', model: 'test-model', reasoning: 'medium'} as Partial<CommandContext['settings']>});
    expect(await handleSlashCommand('/reasoning status', ctx)).toBe('handled');
    expect(ctx.updateSettings).not.toHaveBeenCalled();
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('medium (from settings)'));
    const defaultCtx = mockContext();
    expect(await handleSlashCommand('/reasoning status', defaultCtx)).toBe('handled');
    expect(defaultCtx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('medium (default)'));
    const overrideCtx = mockContext({getSessionReasoning: () => 'xhigh'});
    expect(await handleSlashCommand('/reasoning status', overrideCtx)).toBe('handled');
    expect(overrideCtx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('xhigh (session override)'));
    const unsetCtx = mockContext({settings: {provider: 'openrouter', model: 'test-model', reasoning: 'provider-default'} as Partial<CommandContext['settings']>});
    expect(await handleSlashCommand('/reasoning status', unsetCtx)).toBe('handled');
    expect(unsetCtx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('provider default (no parameter sent)'));
  });


  it('treats /create-skill as an unknown command now that skills use the picker', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/create-skill ignored inline args', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Unknown command'));
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

  it('opens the lsp picker from /lsp', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/lsp', ctx)).toBe('handled');
    expect(ctx.setMode).toHaveBeenCalledWith('lsp');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('add server'));
  });

  it('opens the mcp picker from /mcp (and forgives trailing args)', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/mcp', ctx)).toBe('handled');
    expect(ctx.setMode).toHaveBeenCalledWith('mcp');
    const ctx2 = mockContext();
    expect(await handleSlashCommand('/mcp add context7', ctx2)).toBe('handled');
    expect(ctx2.setMode).toHaveBeenCalledWith('mcp');
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

  it('renders the context report for /context when getContextReport is wired', async () => {
    const ctx = mockContext({getContextReport: async () => 'Context overview — model: openrouter:test\nEstimated input: ~1,000 tokens'});
    expect(await handleSlashCommand('/context', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Context overview'));
  });

  it('reports context overview unavailable for /context without a callback', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/context', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
  });

  it('renders session info for /session when wired', async () => {
    const ctx = mockContext({sessionInfo: () => 'session abc-123 (5 turns)'});
    expect(await handleSlashCommand('/session', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith('session abc-123 (5 turns)');
  });

  it('reports session persistence unavailable for /session without a callback', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/session', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
  });

  it('resumes the session for /resume when wired', async () => {
    const resumeSession = vi.fn().mockResolvedValue(undefined);
    const ctx = mockContext({resumeSession});
    expect(await handleSlashCommand('/resume', ctx)).toBe('handled');
    expect(resumeSession).toHaveBeenCalled();
  });

  it('forwards an exact id from /resume <id>', async () => {
    const resumeSession = vi.fn().mockResolvedValue(undefined);
    const ctx = mockContext({resumeSession});
    expect(await handleSlashCommand('/resume 2026-session-id', ctx)).toBe('handled');
    expect(resumeSession).toHaveBeenCalledWith('2026-session-id');
  });

  it('reports session persistence unavailable for /resume without a callback', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/resume', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
  });

  it('starts a new session for /new when wired', async () => {
    const newSession = vi.fn().mockResolvedValue(undefined);
    const ctx = mockContext({newSession});
    expect(await handleSlashCommand('/new', ctx)).toBe('handled');
    expect(newSession).toHaveBeenCalled();
  });

  it('reports session persistence unavailable for /new without a callback', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/new', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
  });

  it('compacts the conversation for /compact when wired, forwarding args', async () => {
    const compactConversation = vi.fn();
    const ctx = mockContext({compactConversation});
    expect(await handleSlashCommand('/compact keep the plan', ctx)).toBe('handled');
    expect(compactConversation).toHaveBeenCalledWith('keep the plan');
  });

  it('compacts with no args when /compact is bare', async () => {
    const compactConversation = vi.fn();
    const ctx = mockContext({compactConversation});
    expect(await handleSlashCommand('/compact', ctx)).toBe('handled');
    expect(compactConversation).toHaveBeenCalledWith(undefined);
  });

  it('reports compaction unavailable for /compact without a callback', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/compact', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Compaction is unavailable'));
  });
});

describe('handleSlashCommand /logs', () => {
  it('shows no log files message when empty', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/logs', ctx)).toBe('handled');
    const msg = (ctx.addSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(typeof msg).toBe('string');
  });

  it('shows specific log summary with /logs <id>', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/logs nonexistent-id', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('No log found'));
  });

  it('shows log summary for a real log file', async () => {
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

  it('/logs <id> view pages the raw log through viewInPager when provided', async () => {
    const {createLog, appendLogEntry} = await import('../../src/core/log/llmLog.js');
    const log = await createLog();
    await appendLogEntry(log, {at: new Date().toISOString(), type: 'request', stream: 'main'});
    const viewInPager = vi.fn(async () => true);
    const ctx = mockContext({viewInPager});
    expect(await handleSlashCommand(`/logs ${log.id} view`, ctx)).toBe('handled');
    expect(viewInPager).toHaveBeenCalledTimes(1);
    const pagedText = viewInPager.mock.calls[0][0] as string;
    expect(pagedText).toContain('"type":"request"');
    expect(ctx.addSystemMessage).not.toHaveBeenCalledWith(expect.stringContaining('Log:'));
    await fs.remove(log.file);
  });

  it.each(['short', 'long', 'no pager'])('/logs <id> view shows bounded raw content when paging is skipped: %s', async scenario => {
    const {createLog, appendLogEntry} = await import('../../src/core/log/llmLog.js');
    const {SESSION_PREVIEW_CHARS} = await import('../../src/core/limits.js');
    const log = await createLog();
    const warning = 'synthetic log content' + (scenario === 'long' ? 'x'.repeat(SESSION_PREVIEW_CHARS * 2) : '');
    await appendLogEntry(log, {at: new Date().toISOString(), type: 'warning', warning});
    const ctx = mockContext({viewInPager: scenario === 'no pager' ? undefined : vi.fn(async () => false)});
    expect(await handleSlashCommand(`/logs ${log.id} view`, ctx)).toBe('handled');
    const message = vi.mocked(ctx.addSystemMessage).mock.calls[0]![0];
    expect(message).toContain('inline view; pager not used');
    expect(message).toContain('synthetic log content');
    expect(message).not.toContain('fits on screen');
    if (scenario === 'long') {
      expect(message).toContain('preview truncated');
      expect(message.length).toBeLessThan(SESSION_PREVIEW_CHARS + 250);
    } else {
      expect(message).toContain(JSON.stringify(warning));
      expect(message).not.toContain('truncated');
    }
    await log.writer?.close();
    await fs.remove(log.file);
  });
});

describe('handleSlashCommand /editor', () => {
  it('requires an interactive terminal affordance', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/editor', ctx)).toBe('handled');
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('interactive'));
  });

  it('submits the composed text as a turn', async () => {
    const composeInEditor = vi.fn(async () => 'multi-line\nprompt');
    const ctx = mockContext({composeInEditor});
    expect(await handleSlashCommand('/editor', ctx)).toBe('handled');
    expect(ctx.runAgentTurn).toHaveBeenCalledWith('multi-line\nprompt');
  });

  it('does not submit an empty compose', async () => {
    const ctx = mockContext({composeInEditor: vi.fn(async () => undefined)});
    expect(await handleSlashCommand('/editor', ctx)).toBe('handled');
    expect(ctx.runAgentTurn).not.toHaveBeenCalled();
  });
});
