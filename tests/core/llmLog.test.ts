import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

describe('llmLog path safety', () => {
  let tmp: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-log-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tmp;
    vi.resetModules();
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    vi.resetModules();
    await fs.remove(tmp);
  });

  it('rejects traversal and absolute log ids before reading files', async () => {
    const escapedFile = path.join(tmp, '.haze', 'escape.jsonl');
    await fs.ensureFile(escapedFile);
    await fs.writeFile(escapedFile, `${JSON.stringify({at: 'now', type: 'response', stream: 'main', text: 'outside logs'})}\n`);
    const {readLogEntries, summarizeLog} = await import('../../src/core/log/llmLog.js');

    await expect(readLogEntries('../escape')).resolves.toEqual([]);
    await expect(summarizeLog('../escape')).resolves.toBeUndefined();
    await expect(readLogEntries('/absolute')).resolves.toEqual([]);
    await expect(summarizeLog('/absolute')).resolves.toBeUndefined();
  });
});
