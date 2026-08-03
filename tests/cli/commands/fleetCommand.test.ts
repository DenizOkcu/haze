import {describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import type {CommandContext} from '../../../src/cli/commands/commands.js';
import {handleFleetCommand, parseFleetArgs} from '../../../src/cli/commands/fleetCommand.js';

function mockContext(overrides?: Partial<CommandContext>): CommandContext {
  return {
    settings: {provider: 'openrouter', apiKey: 'test-key', model: 'test-model'}, contextFiles: [],
    setMode: vi.fn(), addSystemMessage: vi.fn(), clearConversation: vi.fn(), runAgentTurn: vi.fn(),
    refreshContextFiles: vi.fn(() => Promise.resolve([])), updateSettings: vi.fn(() => Promise.resolve({model: 'new-model'})), ...overrides,
  };
}

describe('fleet argument parsing', () => {
  it('parses explicit ephemeral overrides without placing them in runtime policy text', () => {
    const parsed = parseFleetArgs('--review --profile local-safe --workers local:qwen --concurrency 2 audit auth');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.prompt).toBe('audit auth');
    expect(parsed.value.options.subagentOverrides).toEqual({forceMode: 'inspect', profile: 'local-safe', workerModel: 'local:qwen', maxConcurrency: 2});
    expect(parsed.value.options.ephemeralControl).toContain('parallel-only');
  });

  it('supports -- for a prompt beginning with flags', () => {
    expect(parseFleetArgs('-- --literal prompt')).toMatchObject({ok: true, value: {prompt: '--literal prompt'}});
  });

  it.each(['--auto x', '--profile', '--workers --review x', '--concurrency 0 x', '--concurrency 11 x', ''])('rejects malformed input %j', value => {
    expect(parseFleetArgs(value).ok).toBe(false);
  });
});

describe('handleFleetCommand', () => {
  it('shows usage and starts no turn for invalid input', async () => {
    const ctx = mockContext();
    expect(await handleFleetCommand('', ctx)).toBe('handled');
    expect(ctx.runAgentTurn).not.toHaveBeenCalled();
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('/fleet ['));
  });

  it('keeps only the original invocation durable and passes fleet guidance ephemerally', async () => {
    const ctx = mockContext();
    await handleFleetCommand('--profile local-safe audit auth and retries', ctx);
    expect(ctx.runAgentTurn).toHaveBeenCalledTimes(1);
    const [value, display, options] = (ctx.runAgentTurn as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(value).toBe('/fleet --profile local-safe audit auth and retries');
    expect(display).toBe(value);
    expect(value).not.toContain('Runtime owns queueing');
    expect(options.ephemeralControl).toContain('subagent');
    expect(options.ephemeralControl).toContain('parallel-only');
    expect(options.ephemeralControl.length).toBeLessThan(1200);
    expect(options.subagentOverrides).toMatchObject({profile: 'local-safe'});
  });
});

describe('fleet ephemeral control text', () => {
  function controlText() {
    const parsed = parseFleetArgs('x');
    if (!parsed.ok) throw new Error('expected parse to succeed');
    return parsed.value.options.ephemeralControl;
  }

  it('is concise and leaves scheduling/deadlines/mutation serialization to runtime', () => {
    const lower = controlText().toLowerCase();
    expect(lower).toContain('runtime owns queueing, concurrency, deadlines');
    expect(lower).toContain('mutation serialization');
    expect(lower).toContain('aggregate every capsule truthfully');
    expect(lower).toContain('requires objective, deliverable, and mode');
    expect(lower).toContain('objective under 1000 characters');
    expect(lower).toContain('never call subagent with {}');
    expect(lower).toContain('retry a failed/limited worker at most once');
    expect(lower).not.toContain('spawn all');
    expect(lower).not.toContain('wave');
  });
});

const commandHome = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-fleet-cmd-'));
vi.doMock('../../../src/config/paths.js', () => ({HAZE_DIR: commandHome, GLOBAL_SKILLS_DIR: path.join(commandHome, 'skills')}));
const {handleSlashCommand} = await import('../../../src/cli/commands/commands.js');

describe('handleSlashCommand /fleet routing', () => {
  it('routes a valid invocation with ephemeral options', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/fleet --review audit auth', ctx)).toBe('handled');
    expect(ctx.runAgentTurn).toHaveBeenCalledWith('/fleet --review audit auth', '/fleet --review audit auth', expect.objectContaining({subagentOverrides: expect.objectContaining({forceMode: 'inspect'})}));
  });

  it('lists fleet flags in help', async () => {
    const ctx = mockContext();
    await handleSlashCommand('/help', ctx);
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('/fleet'));
  });
});
