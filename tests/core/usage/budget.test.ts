import {beforeEach, describe, expect, it, vi} from 'vitest';
import {checkBudget} from '../../../src/core/usage/budget.js';
import {clearCorruptedLedgerFiles} from '../../../src/core/usage/usageLedger.js';

vi.mock('../../../src/config/settings.js', () => ({readSettings: vi.fn(async () => ({}))}));
vi.mock('../../../src/core/usage/usageLedger.js', () => ({
  readUsageEntries: vi.fn(async () => []),
  clearCorruptedLedgerFiles: vi.fn(() => undefined),
}));

beforeEach(() => {
  clearCorruptedLedgerFiles();
});

describe('checkBudget', () => {
  it('warns when session spend crosses 80% of the session budget', async () => {
    const warning = await checkBudget({
      settings: {budget: {session: 1, enabled: true}},
      sessionCost: 0.9,
    });
    expect(warning).toBeDefined();
    expect(warning!.message).toContain('Session spend estimate');
  });

  it('returns undefined when budget is disabled', async () => {
    const warning = await checkBudget({
      settings: {budget: {session: 1, enabled: false}},
      sessionCost: 100,
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
    });
    expect(warning).toBeDefined();
    expect(warning!.message).toContain('Daily spend estimate');
  });

  it('does not warn for a session budget when no session cost is tracked', async () => {
    const warning = await checkBudget({
      settings: {budget: {session: 1, enabled: true}},
    });
    expect(warning).toBeUndefined();
  });
});
