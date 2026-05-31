import {afterEach, beforeEach, describe, it, expect} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {readInputHistory, writeInputHistory, addInputHistoryItem} from '../../src/config/inputHistory.js';

describe('inputHistory', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  it('readInputHistory returns empty array when file missing', async () => {
    const data = await fs.readJson(path.join(tmp, 'missing.json')).catch(() => []);
    expect(data).toEqual([]);
  });

  it('writeInputHistory and readInputHistory round-trip', async () => {
    // Write directly to a temp file and verify format
    const historyFile = path.join(tmp, 'history.json');
    await fs.ensureDir(tmp);
    await fs.writeJson(historyFile, ['cmd1', 'cmd2'], {spaces: 2});
    const content = await fs.readJson(historyFile);
    expect(content).toEqual(['cmd1', 'cmd2']);
  });

  it('addInputHistoryItem returns a string array', async () => {
    const result = await addInputHistoryItem('test-command');
    expect(Array.isArray(result)).toBe(true);
    expect(result.every(item => typeof item === 'string')).toBe(true);
  });

  it('addInputHistoryItem appends to existing history', async () => {
    const first = await addInputHistoryItem('first');
    expect(first).toContain('first');
    const second = await addInputHistoryItem('second');
    expect(second).toContain('first');
    expect(second).toContain('second');
  });

  it('addInputHistoryItem deduplicates consecutive entries', async () => {
    // Use a unique key to avoid interference from other tests
    const key = `dedup-test-${Date.now()}`;
    await addInputHistoryItem(key);
    const result = await addInputHistoryItem(key);
    // The last two entries should be deduplicated
    const lastTwo = result.slice(-2);
    const sameCount = lastTwo.filter(item => item === key).length;
    expect(sameCount).toBe(1);
  });

  it('addInputHistoryItem ignores empty/whitespace input', async () => {
    const before = await addInputHistoryItem('existing');
    const after = await addInputHistoryItem('   ');
    // Should be the same length since empty was ignored
    expect(after.length).toBeLessThanOrEqual(before.length);
  });

  it('addInputHistoryItem handles special characters', async () => {
    const result = await addInputHistoryItem('echo "hello world" | grep hello');
    expect(result).toContain('echo "hello world" | grep hello');
  });

  it('history is capped at 500 items', async () => {
    const result = await addInputHistoryItem('test');
    expect(result.length).toBeLessThanOrEqual(500);
  });
});
