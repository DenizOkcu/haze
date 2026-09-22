import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LspError} from '../../../src/llm/lsp/client.js';

type RequestFn = (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>;

function fakePool(client: object): {getClient: () => Promise<object>; ensureOpen: () => Promise<void>} {
  return {getClient: vi.fn(async () => client), ensureOpen: vi.fn(async () => undefined)};
}

function fakeClient(request: RequestFn, overrides: Record<string, unknown> = {}) {
  return {
    request,
    diagnosticPullSupported: () => true,
    publishedDiagnostics: () => undefined,
    ...overrides,
  };
}

describe('lspDiagnostics pull protocol', () => {
  let root: string;
  let cwd: string;
  beforeEach(async () => {
    cwd = process.cwd();
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'haze-lsp-req-')));
    process.chdir(root);
    await fs.writeFile('a.ts', 'const a = 1;\n');
  });
  afterEach(async () => {
    process.chdir(cwd);
    await fs.rm(root, {recursive: true, force: true});
  });

  it('uses the protocol method and honors an explicit empty report', async () => {
    const {lspDiagnostics} = await import('../../../src/llm/lsp/requests.js');
    const request = vi.fn(async () => ({kind: 'full', items: []}));
    const result = await lspDiagnostics({name: 't'} as never, 'a.ts', 50, fakePool(fakeClient(request)) as never);
    expect(request).toHaveBeenCalledWith('textDocument/diagnostic', expect.anything(), 15000);
    expect(result).toEqual({ok: true, diagnostics: []});
  });

  it('distinguishes a missing report from an empty one', async () => {
    const {lspDiagnostics} = await import('../../../src/llm/lsp/requests.js');
    const request = vi.fn(async () => ({}));
    const published = vi.fn(() => [{range: {start: {line: 1, character: 1}, end: {line: 1, character: 2}}, severity: 1, message: 'bad'}]);
    const result = await lspDiagnostics({name: 't'} as never, 'a.ts', 50, fakePool(fakeClient(request, {publishedDiagnostics: published})) as never);
    expect(result).toEqual({ok: true, diagnostics: [expect.objectContaining({severity: 'error', message: 'bad'})]});
  });

  it('rejects a non-report error result instead of pretending the file is clean', async () => {
    const {lspDiagnostics} = await import('../../../src/llm/lsp/requests.js');
    const request = vi.fn(async () => { throw new LspError('server rejected'); });
    await expect(lspDiagnostics({name: 't'} as never, 'a.ts', 50, fakePool(fakeClient(request)) as never)).rejects.toThrow('server rejected');
  });
});

