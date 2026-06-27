import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import type {CommandContext} from '../../src/cli/commands/commands.js';
import {handleCostCommand} from '../../src/cli/commands/costCommand.js';

function mockContext(overrides?: Partial<CommandContext>): CommandContext {
  return {
    settings: {},
    contextFiles: [],
    setMode: vi.fn(),
    addSystemMessage: vi.fn(),
    clearConversation: vi.fn(),
    runAgentTurn: vi.fn(),
    refreshContextFiles: vi.fn(() => Promise.resolve([])),
    updateSettings: vi.fn(() => Promise.resolve({})),
    sessionStart: new Date('2026-06-27T10:00:00Z'),
    ...overrides,
  };
}

describe('handleCostCommand', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-cost-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  it('reports today and week totals even with no data', async () => {
    const ctx = mockContext();
    await handleCostCommand('', ctx, {baseDir: tmp});
    const msg = (ctx.addSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain('Usage / cost');
    expect(msg).toContain('Today');
    expect(msg).toContain('Last 7 days');
  });

  it('filters to session scope when requested', async () => {
    const sessionStart = new Date('2026-06-27T10:00:00Z');
    const ctx = mockContext({sessionStart});
    await handleCostCommand('session', ctx, {baseDir: tmp});
    const msg = (ctx.addSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain('Session');
    expect(msg).not.toContain('Today');
    expect(msg).not.toContain('Last 7 days');
  });

  it('shows per-model breakdown when entries exist', async () => {
    const usageDir = path.join(tmp, 'usage');
    await fs.ensureDir(usageDir);
    const entry = {
      ts: new Date().toISOString(),
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens: 2000,
      outputTokens: 1000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      cost: 0.45,
    };
    await fs.appendFile(path.join(usageDir, '2026-06-27.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
    const ctx = mockContext();
    await handleCostCommand('today', ctx, {baseDir: tmp});
    const msg = (ctx.addSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain('openai:gpt-4o-mini');
    expect(msg).toContain('~$0.4500');
  });
});
