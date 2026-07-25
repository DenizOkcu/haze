import {describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import type {CommandContext} from '../../../src/cli/commands/commands.js';
import {buildFleetPrompt, handleFleetCommand} from '../../../src/cli/commands/fleetCommand.js';

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

describe('handleFleetCommand', () => {
  it('rejects an empty prompt with a usage message and does not fan out', async () => {
    const ctx = mockContext();
    expect(await handleFleetCommand('', ctx)).toBe('handled');
    expect(ctx.runAgentTurn).not.toHaveBeenCalled();
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('/fleet <prompt>'));
  });

  it('rejects a whitespace-only prompt', async () => {
    const ctx = mockContext();
    expect(await handleFleetCommand('   \t  ', ctx)).toBe('handled');
    expect(ctx.runAgentTurn).not.toHaveBeenCalled();
  });

  it('delegates to a model turn carrying the fleet guidance and the prompt', async () => {
    const ctx = mockContext();
    const result = await handleFleetCommand('audit auth and research retries', ctx);
    expect(result).toBe('handled');
    expect(ctx.runAgentTurn).toHaveBeenCalledTimes(1);
    const call = (ctx.runAgentTurn as ReturnType<typeof vi.fn>).mock.calls[0];
    const [prompt, displayValue] = call as [string, string];
    // The turn is displayed as the original /fleet invocation, not the giant guidance blob.
    expect(displayValue).toBe('/fleet audit auth and research retries');
    // The user's prompt is the payload.
    expect(prompt).toContain('audit auth and research retries');
    // The fleet behavioral guidance is embedded in the directive.
    expect(prompt).toContain('subagent');
    expect(prompt.toLowerCase()).toContain('not parallelizable');
    expect(prompt.toLowerCase()).toContain('aggregate');
  });
});

describe('buildFleetPrompt', () => {
  it('embeds the full behavioral contract (B1-B7) and the user payload', () => {
    const prompt = buildFleetPrompt('do x, y, and z');
    const lower = prompt.toLowerCase();
    expect(lower).toContain('analyze for parallelism'); // B1
    expect(lower).toMatch(/at most 5/); // B2 fan-out cap
    expect(lower).toContain('disjoint set of files'); // B3
    expect(lower).toContain('do not auto-run'); // B4 non-parallelizable decline
    expect(lower).toContain('aggregate'); // B5
    expect(lower).toContain('decomposition plan'); // B6
    expect(lower).toContain('empty prompt guard'); // B7
    expect(prompt).toContain('do x, y, and z'); // payload
  });
});

// Routing through the real slash-command dispatcher. Mock the paths module so the
// command registry never touches the real ~/.haze (mirrors commands.test.ts).
const commandHome = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-fleet-cmd-'));
vi.doMock('../../../src/config/paths.js', () => ({
  HAZE_DIR: commandHome,
  GLOBAL_SKILLS_DIR: path.join(commandHome, 'skills'),
}));
const {handleSlashCommand} = await import('../../../src/cli/commands/commands.js');

describe('handleSlashCommand /fleet routing (native command)', () => {
  it('routes /fleet <prompt> to the fleet handler and runs a turn', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/fleet audit auth and research retries', ctx)).toBe('handled');
    expect(ctx.runAgentTurn).toHaveBeenCalledTimes(1);
    const call = (ctx.runAgentTurn as ReturnType<typeof vi.fn>).mock.calls[0];
    const [prompt, displayValue] = call as [string, string];
    expect(displayValue).toBe('/fleet audit auth and research retries');
    expect(prompt).toContain('audit auth and research retries');
  });

  it('bare /fleet shows usage and does not fan out', async () => {
    const ctx = mockContext();
    expect(await handleSlashCommand('/fleet', ctx)).toBe('handled');
    expect(ctx.runAgentTurn).not.toHaveBeenCalled();
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('/fleet <prompt>'));
  });

  it('lists /fleet in /help as a native command', async () => {
    const ctx = mockContext();
    await handleSlashCommand('/help', ctx);
    expect(ctx.addSystemMessage).toHaveBeenCalledWith(expect.stringContaining('/fleet <prompt>'));
  });
});
