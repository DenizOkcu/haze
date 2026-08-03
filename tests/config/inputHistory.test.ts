import {afterEach, beforeEach, describe, it, expect} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {readInputHistory, writeInputHistory, addInputHistoryItem} from '../../src/config/inputHistory.js';

describe('inputHistory', () => {
  let tmp: string;
  let historyFile: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-history-test-'));
    historyFile = path.join(tmp, 'input-history.json');
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  it('returns an empty array when the file is missing', async () => {
    await expect(readInputHistory(historyFile)).resolves.toEqual([]);
  });

  it('round-trips written history through a temp file', async () => {
    await writeInputHistory(['cmd1', 'cmd2'], historyFile);
    await expect(readInputHistory(historyFile)).resolves.toEqual(['cmd1', 'cmd2']);
  });

  it('drops non-string and blank entries on read', async () => {
    await fs.writeJson(historyFile, ['keep', '', '   ', 42, null, 'also keep']);
    await expect(readInputHistory(historyFile)).resolves.toEqual(['keep', 'also keep']);
  });

  it('appends to existing history', async () => {
    const first = await addInputHistoryItem('first', historyFile);
    expect(first).toContain('first');
    const second = await addInputHistoryItem('second', historyFile);
    expect(second).toEqual(['first', 'second']);
  });

  it('deduplicates consecutive entries', async () => {
    await addInputHistoryItem('same', historyFile);
    const result = await addInputHistoryItem('same', historyFile);
    expect(result).toEqual(['same']);
  });

  it('ignores empty/whitespace input', async () => {
    await addInputHistoryItem('existing', historyFile);
    const after = await addInputHistoryItem('   ', historyFile);
    expect(after).toEqual(['existing']);
  });

  it('handles special characters', async () => {
    const result = await addInputHistoryItem('echo "hello world" | grep hello', historyFile);
    expect(result).toContain('echo "hello world" | grep hello');
  });

  it('caps history at 500 items', async () => {
    await writeInputHistory(Array.from({length: 600}, (_unused, index) => `item-${index}`), historyFile);
    const result = await addInputHistoryItem('newest', historyFile);
    expect(result).toHaveLength(500);
    expect(result.at(-1)).toBe('newest');
    expect(result[0]).toBe('item-101');
  });
});
