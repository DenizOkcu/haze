import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const captured = vi.hoisted(() => ({
  readSettingsResult: {lspServers: [{name: 'typescript', command: 'typescript-language-server', args: ['--stdio'], extensions: ['.ts', '.tsx']}]} as Record<string, unknown>,
  lspFns: {
    lspDefinition: vi.fn(async () => [{path: 'src/a.ts', range: {start: {line: 1, character: 2}, end: {line: 3, character: 4}}}]),
    lspDocumentSymbols: vi.fn(async () => [{name: 'foo', kind: 12, path: 'src/a.ts'}]),
    lspReferences: vi.fn(async () => [{path: 'src/a.ts', range: {start: {line: 1, character: 2}, end: {line: 1, character: 5}}}]),
    lspWorkspaceSymbols: vi.fn(async () => [{name: 'foo', kind: 12, path: 'src/a.ts'}]),
  },
}));

async function loadLspTools() {
  vi.doMock('../../src/config/settings.js', () => ({
    readSettings: async () => captured.readSettingsResult,
  }));
  vi.doMock('../../src/config/lspSettings.js', () => ({
    configuredLspServers: (settings: Record<string, unknown>) => {
      const servers = (settings.lspServers ?? []) as Array<Record<string, unknown>>;
      return servers.map(server => ({...server, args: server.args ?? [], extensions: server.extensions ?? [], enabled: server.enabled !== false}));
    },
  }));
  vi.doMock('../../src/llm/lsp.js', () => ({
    pickLspServer: (servers: Array<{extensions?: string[]; enabled?: boolean}>, filePath: string) => {
      const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
      return servers.find(server => server.enabled !== false && (server.extensions ?? []).map(e => String(e).toLowerCase()).includes(ext));
    },
    ...captured.lspFns,
  }));
  vi.resetModules();
  return import('../../src/llm/lspTools.js');
}

beforeEach(() => {
  captured.readSettingsResult = {lspServers: [{name: 'typescript', command: 'typescript-language-server', args: ['--stdio'], extensions: ['.ts', '.tsx']}]};
  for (const fn of Object.values(captured.lspFns)) {
    fn.mockClear();
    fn.mockReset();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lspTools.lspSymbols', () => {
  it('returns noServer shape when no enabled server covers the file extension', async () => {
    captured.readSettingsResult = {lspServers: []};
    const {lspTools} = await loadLspTools();
    const result = await lspTools.lspSymbols.execute({path: 'README.md', maxSymbols: 10}, {toolCallId: 't', messages: [], abortSignal: new AbortController().signal} as never);
    expect(result).toMatchObject({ok: false});
    expect((result as {error: string}).error).toMatch(/No enabled LSP server/);
  });

  it('returns symbols for an enabled server', async () => {
    captured.lspFns.lspDocumentSymbols.mockResolvedValueOnce([{name: 'main', kind: 12, path: 'src/a.ts'}]);
    const {lspTools} = await loadLspTools();
    const result = await lspTools.lspSymbols.execute({path: 'src/a.ts', maxSymbols: 80}, {toolCallId: 't', messages: [], abortSignal: new AbortController().signal} as never);
    expect(result).toMatchObject({ok: true, server: 'typescript', path: 'src/a.ts'});
    expect((result as {symbols: unknown[]}).symbols).toHaveLength(1);
  });

  it('reports truncated=true when result count reaches the maxSymbols cap', async () => {
    const many = Array.from({length: 5}, (_, index) => ({name: `s${index}`, kind: 12, path: 'src/a.ts'}));
    captured.lspFns.lspDocumentSymbols.mockResolvedValueOnce(many);
    const {lspTools} = await loadLspTools();
    const result = await lspTools.lspSymbols.execute({path: 'src/a.ts', maxSymbols: 5}, {toolCallId: 't', messages: [], abortSignal: new AbortController().signal} as never);
    expect(result).toMatchObject({ok: true, truncated: true});
  });

  it('maps LSP errors to a clean structured failure', async () => {
    captured.lspFns.lspDocumentSymbols.mockRejectedValueOnce(new Error('LSP request timed out'));
    const {lspTools} = await loadLspTools();
    const result = await lspTools.lspSymbols.execute({path: 'src/a.ts', maxSymbols: 10}, {toolCallId: 't', messages: [], abortSignal: new AbortController().signal} as never);
    expect(result).toMatchObject({ok: false});
    expect((result as {error: string}).error).toContain('LSP request timed out');
  });
});

describe('lspTools.lspDefinition', () => {
  it('returns locations for a 1-based line/column', async () => {
    const {lspTools} = await loadLspTools();
    const result = await lspTools.lspDefinition.execute({path: 'src/a.ts', line: 10, column: 4, maxResults: 20}, {toolCallId: 't', messages: [], abortSignal: new AbortController().signal} as never);
    expect(result).toMatchObject({ok: true, server: 'typescript', path: 'src/a.ts'});
    expect((result as {locations: unknown[]}).locations).toHaveLength(1);
  });

  it('returns noServer shape for an unsupported extension', async () => {
    const {lspTools} = await loadLspTools();
    const result = await lspTools.lspDefinition.execute({path: 'doc.md', line: 1, column: 1, maxResults: 20}, {toolCallId: 't', messages: [], abortSignal: new AbortController().signal} as never);
    expect(result).toMatchObject({ok: false});
    expect((result as {error: string}).error).toMatch(/No enabled LSP server/);
  });

  it('maps "No Project" errors to a grep/listFiles fallback hint', async () => {
    captured.lspFns.lspDefinition.mockRejectedValueOnce(new Error('No Project found for /workspace'));
    const {lspTools} = await loadLspTools();
    const result = await lspTools.lspDefinition.execute({path: 'src/a.ts', line: 1, column: 1, maxResults: 10}, {toolCallId: 't', messages: [], abortSignal: new AbortController().signal} as never);
    expect(result).toMatchObject({ok: false});
    expect((result as {error: string}).error).toContain('LSP server reported no project');
    expect((result as {error: string}).error).toContain('grep/listFiles');
  });

  it('drops stack-trace frames and blank lines from the cleaned error', async () => {
    const multiline = new Error('first line\n   \n    at frame (a.ts:1:1)\nlast line');
    captured.lspFns.lspDefinition.mockRejectedValueOnce(multiline);
    const {lspTools} = await loadLspTools();
    const result = await lspTools.lspDefinition.execute({path: 'src/a.ts', line: 1, column: 1, maxResults: 10}, {toolCallId: 't', messages: [], abortSignal: new AbortController().signal} as never);
    const error = (result as {error: string}).error;
    expect(error).toContain('first line');
    expect(error).toContain('last line');
    expect(error).not.toContain('at frame');
    expect(error.split('\n').filter(Boolean).length).toBeLessThanOrEqual(2);
  });
});

describe('lspTools.lspReferences', () => {
  it('returns references for a 1-based line/column', async () => {
    const {lspTools} = await loadLspTools();
    const result = await lspTools.lspReferences.execute({path: 'src/a.ts', line: 1, column: 1, maxResults: 50}, {toolCallId: 't', messages: [], abortSignal: new AbortController().signal} as never);
    expect(result).toMatchObject({ok: true, server: 'typescript'});
    expect((result as {locations: unknown[]}).locations).toHaveLength(1);
  });

  it('returns noServer shape for unsupported extension', async () => {
    const {lspTools} = await loadLspTools();
    const result = await lspTools.lspReferences.execute({path: 'doc.md', line: 1, column: 1, maxResults: 10}, {toolCallId: 't', messages: [], abortSignal: new AbortController().signal} as never);
    expect(result).toMatchObject({ok: false});
  });
});

describe('lspTools.lspWorkspaceSymbols', () => {
  it('returns workspace symbols via the first enabled server when none is named', async () => {
    const {lspTools} = await loadLspTools();
    const result = await lspTools.lspWorkspaceSymbols.execute({query: 'foo', maxSymbols: 50}, {toolCallId: 't', messages: [], abortSignal: new AbortController().signal} as never);
    expect(result).toMatchObject({ok: true, server: 'typescript', query: 'foo'});
    expect((result as {symbols: unknown[]}).symbols).toHaveLength(1);
  });

  it('selects the named server when one is provided', async () => {
    captured.readSettingsResult = {lspServers: [
      {name: 'python', command: 'pylsp', extensions: ['.py']},
      {name: 'typescript', command: 'typescript-language-server', args: ['--stdio'], extensions: ['.ts', '.tsx']},
    ]};
    const {lspTools} = await loadLspTools();
    const result = await lspTools.lspWorkspaceSymbols.execute({query: 'foo', server: 'python', maxSymbols: 10}, {toolCallId: 't', messages: [], abortSignal: new AbortController().signal} as never);
    expect(result).toMatchObject({ok: true, server: 'python'});
  });

  it('returns a structured error when the named server is not enabled', async () => {
    const {lspTools} = await loadLspTools();
    const result = await lspTools.lspWorkspaceSymbols.execute({query: 'foo', server: 'rust', maxSymbols: 10}, {toolCallId: 't', messages: [], abortSignal: new AbortController().signal} as never);
    expect(result).toEqual({ok: false, error: 'No enabled LSP server named rust.'});
  });

  it('returns a structured error when no server is configured at all', async () => {
    captured.readSettingsResult = {lspServers: []};
    const {lspTools} = await loadLspTools();
    const result = await lspTools.lspWorkspaceSymbols.execute({query: 'foo', maxSymbols: 10}, {toolCallId: 't', messages: [], abortSignal: new AbortController().signal} as never);
    expect(result).toEqual({ok: false, error: 'No enabled LSP server configured. Use /lsp add <preset>.'});
  });

  it('maps lsp errors to a clean structured failure with the "No Project" hint', async () => {
    captured.lspFns.lspWorkspaceSymbols.mockRejectedValueOnce(new Error('No Project'));
    const {lspTools} = await loadLspTools();
    const result = await lspTools.lspWorkspaceSymbols.execute({query: 'foo', maxSymbols: 10}, {toolCallId: 't', messages: [], abortSignal: new AbortController().signal} as never);
    expect((result as {error: string}).error).toContain('grep/listFiles');
  });
});

describe('lspTools descriptions', () => {
  it('describe workspace-symbols as the best first LSP tool for an unanchored query', async () => {
    const {lspTools} = await loadLspTools();
    expect(lspTools.lspWorkspaceSymbols.description).toContain('Best first LSP tool');
    expect(lspTools.lspSymbols.description).toContain('semantic symbols');
    expect(lspTools.lspDefinition.description).toContain('definition');
    expect(lspTools.lspReferences.description).toContain('references');
  });
});
