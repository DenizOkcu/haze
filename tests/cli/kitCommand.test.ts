import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {CommandContext} from '../../src/cli/commands/commands.js';
vi.mock('../../src/skills/kits.js', () => ({inspectKit: vi.fn(async () => 'preview'), installKit: vi.fn(async () => 'installed'), listKits: vi.fn(async () => 'list'), removeKit: vi.fn(async () => 'removed')}));
import {inspectKit, installKit, listKits, removeKit} from '../../src/skills/kits.js';
import {handleSlashCommand} from '../../src/cli/commands/commands.js';
import {handleKitCommand, runKitAction} from '../../src/cli/commands/kitCommand.js';
beforeEach(() => vi.clearAllMocks());
describe('/kit', () => {
  it('is routed by the public slash-command dispatcher', async () => {
    const ctx = {addSystemMessage: vi.fn()} as unknown as CommandContext;
    expect(await handleSlashCommand('/kit list', ctx)).toBe('handled');
    expect(listKits).toHaveBeenCalledOnce();
  });
  it('lists by default without running an agent', async () => {
    const ctx = {addSystemMessage: vi.fn(), refreshSkills: vi.fn()} as unknown as CommandContext;
    expect(await handleKitCommand('', ctx)).toBe('handled');
    expect(listKits).toHaveBeenCalled();
    expect(ctx.refreshSkills).not.toHaveBeenCalled();
  });
  it('preserves a quoted local directory with spaces and refreshes skills immediately', async () => {
    const ctx = {addSystemMessage: vi.fn(), refreshSkills: vi.fn()} as unknown as CommandContext;
    await handleKitCommand('install "../my kits/speckit"', ctx);
    expect(installKit).toHaveBeenCalledWith('../my kits/speckit');
    expect(ctx.refreshSkills).toHaveBeenCalledOnce();
    expect(ctx.addSystemMessage).toHaveBeenCalledWith('installed');
  });
  it('routes inspect/remove and rejects unsupported actions', async () => {
    expect(await runKitAction('inspect', '/tmp/kit')).toBe('preview');
    expect(inspectKit).toHaveBeenCalledWith('/tmp/kit');
    expect(await runKitAction('remove', 'demo')).toBe('removed');
    expect(removeKit).toHaveBeenCalledWith('demo');
    await expect(runKitAction('update', 'demo')).rejects.toThrow('Usage:');
    await expect(runKitAction('install')).rejects.toThrow('Usage:');
  });
});
