import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';

vi.mock('../../src/llm/webFetch.js', () => ({
  fetchUrlContent: vi.fn(),
  BlockedUrlError: class BlockedUrlError extends Error {
    reasonCode = 'blocked_url' as const;
    constructor(message: string) {
      super(message);
      this.name = 'BlockedUrlError';
    }
  },
}));

import {hazeTools} from '../../src/llm/hazeTools.js';
import {fetchUrlContent} from '../../src/llm/webFetch.js';

const mockFetch = fetchUrlContent as unknown as ReturnType<typeof vi.fn>;

describe('fetch tool', () => {
  let originalCwd: string;
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-fetch-test-'));
    originalCwd = process.cwd();
    process.chdir(tmp);
    mockFetch.mockReset();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.remove(tmp);
  });

  it('returns a successful result with content and extraction method', async () => {
    mockFetch.mockResolvedValue({
      url: 'https://example.com/docs',
      status: 200,
      statusText: 'OK',
      contentType: 'text/html',
      bytes: 123,
      redirected: false,
      content: '# Title\n\nBody.',
      extractionMethod: 'markdown',
      truncated: false,
    });
    const result = await hazeTools.fetch.execute({url: 'https://example.com/docs', format: 'auto'}, {abortSignal: undefined});
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.extractionMethod).toBe('markdown');
    expect(result.content).toContain('# Title');
    expect(result.truncated).toBe(false);
  });

  it('forces text extraction when format=text', async () => {
    mockFetch.mockResolvedValue({
      url: 'https://example.com/x',
      status: 200,
      statusText: 'OK',
      contentType: 'text/html',
      bytes: 10,
      redirected: false,
      content: '<h1>raw</h1>',
      extractionMethod: 'markdown',
      truncated: false,
    });
    const result = await hazeTools.fetch.execute({url: 'https://example.com/x', format: 'text'}, {abortSignal: undefined});
    expect(result.extractionMethod).toBe('text');
  });

  it('returns a structured failure with blocked_url for a rejected URL', async () => {
    const {BlockedUrlError} = await import('../../src/llm/webFetch.js');
    mockFetch.mockRejectedValue(new BlockedUrlError('Address 169.254.169.254 is blocked'));
    const result = await hazeTools.fetch.execute({url: 'http://169.254.169.254/', format: 'auto'}, {abortSignal: undefined});
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe('blocked_url');
    expect(result.toolName).toBe('fetch');
    expect(result.suggestedNextStep).toContain('blocked');
  });

  it('returns a generic structured failure for a network error', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));
    const result = await hazeTools.fetch.execute({url: 'https://example.com/x', format: 'auto'}, {abortSignal: undefined});
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBeUndefined();
    expect(result.error).toContain('fetch failed');
  });

  it('caps oversize content behind a readToolOutput handle', async () => {
    const big = 'A'.repeat(60_000);
    mockFetch.mockResolvedValue({
      url: 'https://example.com/big',
      status: 200,
      statusText: 'OK',
      contentType: 'text/plain',
      bytes: 60_000,
      redirected: false,
      content: big,
      extractionMethod: 'text',
      truncated: false,
    });
    const result = await hazeTools.fetch.execute({url: 'https://example.com/big', format: 'auto'}, {abortSignal: undefined});
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.handle).toMatch(/^output-/);
    expect(result.omittedChars).toBeGreaterThan(0);
    expect(result.content.length).toBeLessThan(big.length);
    const page = await hazeTools.readToolOutput.execute({handle: result.handle, offset: 0, limit: 1000}, {abortSignal: undefined});
    expect(page.content).toHaveLength(1000);
  });

  it('deduplicates identical calls within a turn (duplicateSkipped)', async () => {
    mockFetch.mockResolvedValue({
      url: 'https://example.com/docs',
      status: 200,
      statusText: 'OK',
      contentType: 'text/html',
      bytes: 1,
      redirected: false,
      content: 'x',
      extractionMethod: 'markdown',
      truncated: false,
    });
    const ctx = {inFlightToolCalls: new Map(), completedToolCalls: new Map(), mutationEpoch: 0};
    const context = {abortSignal: undefined, context: ctx};
    const first = await hazeTools.fetch.execute({url: 'https://example.com/docs', format: 'auto'}, context);
    const second = await hazeTools.fetch.execute({url: 'https://example.com/docs', format: 'auto'}, context);
    expect(first.ok).toBe(true);
    expect(second.duplicateSkipped).toBe(true);
    // fetch should only have run once.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
