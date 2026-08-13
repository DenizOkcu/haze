import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {LspPool, StdioLspClient} from '../../src/llm/lsp.js';
import type {HazeLspServer} from '../../src/config/lspSettings.js';

const ts: HazeLspServer = {name: 'typescript', command: 'typescript-language-server', args: ['--stdio'], extensions: ['.ts', '.tsx']};

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
