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

  it('fails closed for non-Responses paths', async () => {
    vi.doMock('../../src/config/providerAuth.js', () => ({getProviderAuth: vi.fn(), setProviderAuth: vi.fn()}));
    const {createChatGptCodexFetch} = await import('../../src/llm/openaiCodex.js');
    await expect(createChatGptCodexFetch('chatgpt')('https://example.com/models')).rejects.toThrow('may only be used');
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
});
