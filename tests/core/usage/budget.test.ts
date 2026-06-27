import {describe, expect, it, vi} from 'vitest';
import {checkBudget} from '../../../src/core/usage/budget.js';

vi.mock('../../../src/config/settings.js', () => ({readSettings: vi.fn(async () => ({}))}));
vi.mock('../../../src/core/usage/usageLedger.js', () => ({
  readUsageEntries: vi.fn(async () => []),
}));

describe('checkBudget', () => {
  it('warns when session spend crosses 80% of the session budget', async () => {
    const warning = await checkBudget({
      settings: {budget: {session: 1, enabled: true}},
      sessionUsage: {inputTokens: 6000, outputTokens: 0, systemPrompt: 0, messages: 0, toolSchemas: 0, outputEstimate: 0, cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 6000, reasoningTokens: 0, logicalInputEstimate: 6000, effectiveNonCachedInput: 6000},
      runtime: {providerName: 'openai', modelName: 'gpt-4o-mini'},
    });
    expect(warning).toBeDefined();
    expect(warning!.message).toContain('Session spend estimate');
  });

  it('returns undefined when budget is disabled', async () => {
    const warning = await checkBudget({
      settings: {budget: {session: 1, enabled: false}},
      sessionUsage: {inputTokens: 100000, outputTokens: 0, systemPrompt: 0, messages: 0, toolSchemas: 0, outputEstimate: 0, cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 100000, reasoningTokens: 0, logicalInputEstimate: 100000, effectiveNonCachedInput: 100000},
    });
    expect(warning).toBeUndefined();
  });

  it('warns when daily spend crosses 80% of the daily budget', async () => {
    const {readUsageEntries} = await import('../../../src/core/usage/usageLedger.js');
    readUsageEntries.mockResolvedValue([
      {ts: new Date().toISOString(), provider: 'openai', model: 'gpt-4o-mini', inputTokens: 12000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cost: 1.8},
    ]);
    const warning = await checkBudget({
      settings: {budget: {daily: 2, enabled: true}},
      sessionUsage: {inputTokens: 0, outputTokens: 0, systemPrompt: 0, messages: 0, toolSchemas: 0, outputEstimate: 0, cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 0, reasoningTokens: 0, logicalInputEstimate: 0, effectiveNonCachedInput: 0},
    });
    expect(warning).toBeDefined();
    expect(warning!.message).toContain('Daily spend estimate');
  });
});
