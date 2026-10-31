import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from '../fsExtra.js';
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

  it('redacts secret-shaped tokens in every entry written to disk (HZ-9)', async () => {
    const {createLog, appendLogEntry} = await import('../../src/core/log/llmLog.js');
    const log = await createLog();
    await appendLogEntry(log, {
      at: 'now',
      type: 'tool_result',
      stream: 'main',
      toolResult: {
        id: 't1',
        name: 'shell',
        success: true,
        output: {stdout: 'token sk-abcdef0123456789abcdef exported', stderr: 'ghp_1234567890abcdefghij'},
      },
      system: 'system prompt mentioning AKIAIOSFODNN7EXAMPLE',
    });
    await appendLogEntry(log, {at: 'now', type: 'response', stream: 'main', text: 'clean text stays'});
    const raw = await fs.readFile(log.file, 'utf8');
    expect(raw).toContain('[redacted:api-key]');
    expect(raw).toContain('[redacted:github-token]');
    expect(raw).toContain('[redacted:aws-key]');
    expect(raw).toContain('clean text stays');
    expect(raw).not.toContain('sk-abcdef0123456789abcdef');
    expect(raw).not.toContain('ghp_1234567890abcdefghij');
    expect(raw).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});
