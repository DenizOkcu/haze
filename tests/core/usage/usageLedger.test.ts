import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {appendUsageEntry, readUsageEntries, readUsageRange} from '../../../src/core/usage/usageLedger.js';

describe('usageLedger', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-usage-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  it('appends and reads a usage entry with a computed cost', async () => {
    const config = {
      providerName: 'openai',
      baseURL: 'https://api.openai.com/v1',
      modelName: 'gpt-4o-mini',
      cacheKey: 'k',
      capabilities: {} as Record<string, boolean>,
    };
    const usage = {
      inputTokens: 1000,
      outputTokens: 500,
      systemPrompt: 0,
      messages: 0,
      toolSchemas: 0,
      outputEstimate: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      noCacheTokens: 1000,
      reasoningTokens: 0,
      logicalInputEstimate: 1000,
      effectiveNonCachedInput: 1000,
    };
    await appendUsageEntry(config, usage, {baseDir: tmp});
    const entries = await readUsageEntries({baseDir: tmp});
    expect(entries).toHaveLength(1);
    expect(entries[0].provider).toBe('openai');
    expect(entries[0].model).toBe('gpt-4o-mini');
    expect(entries[0].cost).toBeGreaterThan(0);
  });

  it('returns an empty array when no usage file exists', async () => {
    const entries = await readUsageEntries({baseDir: tmp});
    expect(entries).toEqual([]);
  });

  it('reads a range of days', async () => {
    const config = {
      providerName: 'openai',
      baseURL: 'x',
      modelName: 'gpt-4o-mini',
      cacheKey: 'k',
      capabilities: {},
    };
    const usage = {inputTokens: 1, outputTokens: 0, systemPrompt: 0, messages: 0, toolSchemas: 0, outputEstimate: 0, cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 1, reasoningTokens: 0, logicalInputEstimate: 1, effectiveNonCachedInput: 1};
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await appendUsageEntry(config, usage, {baseDir: tmp});
    await appendUsageEntry(config, usage, {baseDir: tmp, date: yesterday});
    const entries = await readUsageRange(2, {baseDir: tmp});
    expect(entries).toHaveLength(2);
  });
});
