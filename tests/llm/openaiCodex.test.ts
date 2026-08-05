import {afterEach, describe, expect, it, vi} from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('ChatGPT Codex authenticated fetch', () => {
  it('routes Responses calls to ChatGPT with OAuth and account headers', async () => {
    vi.doMock('../../src/config/providerAuth.js', () => ({
      getProviderAuth: vi.fn(async () => ({type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000 * 10, accountId: 'account'})),
      setProviderAuth: vi.fn(),
    }));
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const {createChatGptCodexFetch} = await import('../../src/llm/openaiCodex.js');
    const codexFetch = createChatGptCodexFetch('chatgpt', fetchImpl as typeof fetch);

    await codexFetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: {authorization: 'Bearer placeholder', 'content-type': 'application/json'},
      body: '{}',
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer access');
    expect(headers.get('ChatGPT-Account-Id')).toBe('account');
    expect(headers.get('originator')).toBe('haze');
    expect(init?.body).toBe('{}');
  });

  it('routes every call to the canonical Codex Responses URL regardless of input', async () => {
    vi.doMock('../../src/config/providerAuth.js', () => ({
      getProviderAuth: vi.fn(async () => ({type: 'oauth', access: 'access', refresh: 'refresh', expires: Date.now() + 60_000 * 10})),
      setProviderAuth: vi.fn(),
    }));
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const {createChatGptCodexFetch} = await import('../../src/llm/openaiCodex.js');
    const codexFetch = createChatGptCodexFetch('chatgpt', fetchImpl as typeof fetch);

    // The input URL is intentionally unrelated to the Codex endpoint. The fetch
    // must still route to CHATGPT_CODEX_RESPONSES_URL so OAuth credentials never
    // leak to an arbitrary host, even if a caller passes the wrong URL.
    await codexFetch('https://example.com/anywhere', {method: 'POST'});

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://chatgpt.com/backend-api/codex/responses');
  });

  it('deduplicates concurrent refreshes and persists the replacement', async () => {
    const setProviderAuth = vi.fn();
    vi.doMock('../../src/config/providerAuth.js', () => ({
      getProviderAuth: vi.fn(async () => ({type: 'oauth', access: 'old', refresh: 'refresh', expires: 0})),
      setProviderAuth,
    }));
    const refreshChatGptAuth = vi.fn(async () => ({type: 'oauth' as const, access: 'new', refresh: 'new-refresh', expires: Date.now() + 60_000}));
    vi.doMock('../../src/llm/openaiCodexOAuth.js', async importOriginal => ({...await importOriginal<typeof import('../../src/llm/openaiCodexOAuth.js')>(), refreshChatGptAuth}));
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const {createChatGptCodexFetch} = await import('../../src/llm/openaiCodex.js');
    const codexFetch = createChatGptCodexFetch('chatgpt', fetchImpl as typeof fetch);

    await Promise.all([
      codexFetch('https://example.com/responses', {method: 'POST'}),
      codexFetch('https://example.com/responses', {method: 'POST'}),
    ]);

    expect(refreshChatGptAuth).toHaveBeenCalledOnce();
    expect(setProviderAuth).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not resurrect credentials removed during an in-flight refresh', async () => {
    type FreshAuth = {type: 'oauth'; access: string; refresh: string; expires: number};
    let resolveRefresh!: (auth: FreshAuth) => void;
    const refreshGate = new Promise<FreshAuth>(resolve => { resolveRefresh = resolve; });
    const setProviderAuth = vi.fn();
    // First read returns stored creds. After the refresh starts, subsequent reads
    // return undefined — simulating the user signing out in another haze instance.
    const reads = vi.fn(async () => {
      reads.mockImplementationOnce(async () => undefined);
      return {type: 'oauth' as const, access: 'old', refresh: 'refresh', expires: 0};
    });
    vi.doMock('../../src/config/providerAuth.js', () => ({getProviderAuth: reads, setProviderAuth}));
    const refreshChatGptAuth = vi.fn(async () => refreshGate.then(() => ({type: 'oauth' as const, access: 'new', refresh: 'new-refresh', expires: Date.now() + 60_000})));
    vi.doMock('../../src/llm/openaiCodexOAuth.js', async importOriginal => ({...await importOriginal<typeof import('../../src/llm/openaiCodexOAuth.js')>(), refreshChatGptAuth}));
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const {createChatGptCodexFetch} = await import('../../src/llm/openaiCodex.js');
    const codexFetch = createChatGptCodexFetch('chatgpt', fetchImpl as typeof fetch);

    const inflight = codexFetch('https://example.com/responses', {method: 'POST'});
    // Sign-out happens while the refresh is in flight.
    resolveRefresh({type: 'oauth', access: 'new', refresh: 'new-refresh', expires: Date.now() + 60_000});
    await inflight;

    // The refreshed creds should NOT have been written back — sign-out wins.
    expect(setProviderAuth).not.toHaveBeenCalled();
    // The fetch still used the fresh access token for this single call.
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
