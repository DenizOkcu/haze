import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {LspPool, pickLspServer} from '../../../src/llm/lsp/pool.js';
import {StdioLspClient} from '../../../src/llm/lsp/client.js';
import type {HazeLspServer} from '../../../src/config/lspSettings.js';

const ts: HazeLspServer = {name: 'typescript', command: 'typescript-language-server', args: ['--stdio'], extensions: ['.ts', '.tsx']};
const py: HazeLspServer = {name: 'python', command: 'pyright-langserver', args: ['--stdio'], extensions: ['.py']};

describe('pickLspServer', () => {
  it('matches a server by file extension', () => {
    expect(pickLspServer([ts, py], 'src/app.ts')?.name).toBe('typescript');
    expect(pickLspServer([ts, py], 'src/app.tsx')?.name).toBe('typescript');
    expect(pickLspServer([ts, py], 'scripts/main.py')?.name).toBe('python');
  });

  it('matches case-insensitively', () => {
    expect(pickLspServer([ts], 'SRC/APP.TSX')?.name).toBe('typescript');
  });

  it('skips disabled servers and falls through to the next match', () => {
    expect(pickLspServer([{...ts, enabled: false}, py], 'app.ts')).toBeUndefined();
    expect(pickLspServer([{...ts, enabled: false}, py], 'app.py')?.name).toBe('python');
  });

  it('returns undefined when no server covers the extension', () => {
    expect(pickLspServer([ts, py], 'README.md')).toBeUndefined();
    expect(pickLspServer([], 'app.ts')).toBeUndefined();
  });

  it('handles a server without an extensions list', () => {
    const noext: HazeLspServer = {name: 'none', command: 'x'};
    expect(pickLspServer([noext], 'app.ts')).toBeUndefined();
  });

  it('prefers the first matching server when several could match', () => {
    const ts2: HazeLspServer = {...ts, name: 'typescript-2'};
    expect(pickLspServer([ts, ts2], 'app.ts')?.name).toBe('typescript');
  });
});

interface FakeClient {
  initialize: ReturnType<typeof vi.fn>;
  openDocument: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  isTerminated: boolean;
  terminated: boolean;
}

function fakeClient(): FakeClient {
  const client = {
    initialize: vi.fn(async () => undefined),
    openDocument: vi.fn(async () => undefined),
    request: vi.fn(async () => []),
    close: vi.fn(async () => undefined),
    isTerminated: false,
    get terminated() {
      return this.isTerminated;
    },
  };
  return client as unknown as FakeClient;
}

describe('LspPool', () => {
  let startSpy: ReturnType<typeof vi.spyOn>;
  let pool: LspPool;

  beforeEach(() => {
    pool = new LspPool();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts one server and reuses it across calls for the same server', async () => {
    const client = fakeClient();
    startSpy = vi.spyOn(StdioLspClient, 'start').mockReturnValue(client as unknown as StdioLspClient);

    const a = await pool.getClient(ts);
    const b = await pool.getClient(ts);
    expect(a).toBe(b);
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(client.initialize).toHaveBeenCalledTimes(1);
  });

  it('opens each document only once across repeated calls', async () => {
    const client = fakeClient();
    vi.spyOn(StdioLspClient, 'start').mockReturnValue(client as unknown as StdioLspClient);

    await pool.getClient(ts);
    await pool.ensureOpen(ts, client as unknown as StdioLspClient, '/ws/src/a.ts');
    await pool.ensureOpen(ts, client as unknown as StdioLspClient, '/ws/src/a.ts');
    await pool.ensureOpen(ts, client as unknown as StdioLspClient, '/ws/src/b.ts');
    expect(client.openDocument).toHaveBeenCalledTimes(2);
  });

  it('restarts a client that has terminated (crash recovery)', async () => {
    const first = fakeClient();
    const second = fakeClient();
    let next = first;
    vi.spyOn(StdioLspClient, 'start').mockImplementation(() => next as unknown as StdioLspClient);

    const a = await pool.getClient(ts);
    expect(a).toBe(first);
    first.isTerminated = true;
    next = second;
    const b = await pool.getClient(ts);
    expect(b).toBe(second);
    expect(second.initialize).toHaveBeenCalledTimes(1);
  });

  it('closes every pooled client exactly once', async () => {
    const client = fakeClient();
    vi.spyOn(StdioLspClient, 'start').mockReturnValue(client as unknown as StdioLspClient);
    await pool.getClient(ts);
    await pool.close();
    expect(client.close).toHaveBeenCalledTimes(1);
    // Idempotent teardown.
    await pool.close();
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
