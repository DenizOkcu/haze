import net from 'node:net';
import {describe, expect, it, vi} from 'vitest';

const {openPathMock} = vi.hoisted(() => ({openPathMock: vi.fn()}));
vi.mock('../../src/utils/openPath.js', () => ({openPath: openPathMock}));

import {
  buildChatGptAuthorizeUrl,
  extractChatGptAccountId,
  generatePkce,
  openBrowser,
  parseJwtClaims,
  refreshChatGptAuth,
  startChatGptBrowserLogin,
} from '../../src/llm/openaiCodexOAuth.js';

function jwt(payload: object): string {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, 'localhost', resolve).once('error', reject));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

describe('OpenAI Codex browser OAuth', () => {
  it('delegates browser opening to the shared external opener', async () => {
    openPathMock.mockResolvedValueOnce(true);
    await expect(openBrowser('https://example.com/login')).resolves.toBe(true);
    expect(openPathMock).toHaveBeenCalledWith('https://example.com/login');
  });

  it('builds a PKCE authorization URL with state and the registered callback', async () => {
    const pkce = await generatePkce();
    const url = new URL(buildChatGptAuthorizeUrl({redirectUri: 'http://localhost:1455/auth/callback', pkce, state: 'state'}));
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge);
    expect(url.searchParams.get('state')).toBe('state');
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
  });

  it('extracts the ChatGPT account ID from supported JWT claim locations', () => {
    expect(parseJwtClaims(jwt({chatgpt_account_id: 'root'}))?.chatgpt_account_id).toBe('root');
    expect(extractChatGptAccountId({id_token: jwt({'https://api.openai.com/auth': {chatgpt_account_id: 'nested'}})})).toBe('nested');
    expect(extractChatGptAccountId({access_token: jwt({organizations: [{id: 'org'}]})})).toBe('org');
  });

  it('accepts the localhost callback, exchanges the code, and returns credentials', async () => {
    const port = await freePort();
    const tokenFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(init?.body)).toContain('code=code-123');
      expect(String(init?.body)).toContain('code_verifier=');
      return Response.json({
        id_token: jwt({chatgpt_account_id: 'account-1'}),
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 60,
      });
    });
    const login = await startChatGptBrowserLogin({port, fetchImpl: tokenFetch as typeof fetch, timeoutMs: 5_000});
    const authorize = new URL(login.url);
    const callback = new URL(authorize.searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', 'code-123');
    callback.searchParams.set('state', authorize.searchParams.get('state')!);

    const response = await fetch(callback);
    expect(response.status).toBe(200);
    await expect(login.complete()).resolves.toMatchObject({type: 'oauth', access: 'access-1', refresh: 'refresh-1', accountId: 'account-1'});
  });

  it('rejects a callback with the wrong state without exchanging tokens', async () => {
    const port = await freePort();
    const tokenFetch = vi.fn();
    const login = await startChatGptBrowserLogin({port, fetchImpl: tokenFetch as typeof fetch, timeoutMs: 5_000});
    const callback = new URL(new URL(login.url).searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', 'code-123');
    callback.searchParams.set('state', 'wrong');

    const completion = expect(login.complete()).rejects.toThrow('state did not match');
    expect((await fetch(callback)).status).toBe(400);
    await completion;
    expect(tokenFetch).not.toHaveBeenCalled();
  });

  it('refreshes credentials and preserves a rotated-or-omitted refresh token', async () => {
    const fetchImpl = vi.fn(async () => Response.json({access_token: 'new-access', expires_in: 30}));
    const refreshed = await refreshChatGptAuth({type: 'oauth', access: 'old', refresh: 'keep-refresh', expires: 0, accountId: 'account'}, {fetchImpl: fetchImpl as typeof fetch});
    expect(refreshed).toMatchObject({access: 'new-access', refresh: 'keep-refresh', accountId: 'account'});
  });
});
