import crypto from 'node:crypto';
import {createServer, type Server} from 'node:http';
import type {OAuthProviderAuth} from '../config/providerAuth.js';
import {openPath} from '../utils/openPath.js';

export const CHATGPT_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CHATGPT_OAUTH_ISSUER = 'https://auth.openai.com';
export const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CHATGPT_CODEX_RESPONSES_URL = `${CHATGPT_CODEX_BASE_URL}/responses`;
// Fixed by the registered ChatGPT OAuth client: the redirect_uri must match
// exactly. Do not switch to an ephemeral port — the auth server would reject
// the callback.
export const CHATGPT_OAUTH_CALLBACK_PORT = 1455;

const CALLBACK_PATH = '/auth/callback';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

interface PkceCodes {
  verifier: string;
  challenge: string;
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface ChatGptBrowserLogin {
  url: string;
  complete: () => Promise<OAuthProviderAuth>;
  close: () => Promise<void>;
}

export interface StartChatGptBrowserLoginOptions {
  issuer?: string;
  port?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface IdTokenClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{id: string}>;
  'https://api.openai.com/auth'?: {chatgpt_account_id?: string};
}

function base64UrlEncode(value: ArrayBuffer | Uint8Array): string {
  return Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value)).toString('base64url');
}

export async function generatePkce(): Promise<PkceCodes> {
  const verifier = base64UrlEncode(crypto.randomBytes(32));
  const challenge = base64UrlEncode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return {verifier, challenge};
}

export function buildChatGptAuthorizeUrl(input: {issuer?: string; redirectUri: string; pkce: PkceCodes; state: string}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CHATGPT_OAUTH_CLIENT_ID,
    redirect_uri: input.redirectUri,
    scope: 'openid profile email offline_access',
    code_challenge: input.pkce.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state: input.state,
    originator: 'haze',
  });
  return `${input.issuer ?? CHATGPT_OAUTH_ISSUER}/oauth/authorize?${params.toString()}`;
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as IdTokenClaims;
  } catch {
    return undefined;
  }
}

export function extractChatGptAccountId(tokens: Pick<TokenResponse, 'id_token' | 'access_token'>): string | undefined {
  for (const token of [tokens.id_token, tokens.access_token]) {
    if (!token) continue;
    const claims = parseJwtClaims(token);
    const accountId = claims?.chatgpt_account_id
      ?? claims?.['https://api.openai.com/auth']?.chatgpt_account_id
      ?? claims?.organizations?.[0]?.id;
    if (accountId) return accountId;
  }
  return undefined;
}

async function tokenRequest(issuer: string, body: URLSearchParams, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<TokenResponse> {
  const response = await fetchImpl(`${issuer}/oauth/token`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: body.toString(),
    signal,
  });
  if (!response.ok) throw new Error(`ChatGPT token request failed with HTTP ${response.status}.`);
  return response.json() as Promise<TokenResponse>;
}

function credentialsFromTokens(tokens: TokenResponse, previous?: OAuthProviderAuth): OAuthProviderAuth {
  const access = tokens.access_token;
  const refresh = tokens.refresh_token ?? previous?.refresh;
  if (!access || !refresh) throw new Error('ChatGPT authorization returned incomplete credentials. Sign in again.');
  const extracted = extractChatGptAccountId(tokens);
  // When the new tokens carry no account claim (e.g., an opaque access token
  // without JWT claims), fall back to the previous accountId so refresh keeps
  // the same account context. Theoretically stale if the user switched account
  // since the original login; requires a fresh sign-in to correct.
  const accountId = extracted ?? previous?.accountId;
  return {
    type: 'oauth',
    access,
    refresh,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    ...(accountId ? {accountId} : {}),
  };
}

export async function refreshChatGptAuth(auth: OAuthProviderAuth, options: {issuer?: string; fetchImpl?: typeof fetch; signal?: AbortSignal} = {}): Promise<OAuthProviderAuth> {
  const tokens = await tokenRequest(options.issuer ?? CHATGPT_OAUTH_ISSUER, new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: auth.refresh,
    client_id: CHATGPT_OAUTH_CLIENT_ID,
  }), options.fetchImpl ?? fetch, options.signal);
  return credentialsFromTokens(tokens, auth);
}

function callbackHtml(success: boolean): string {
  const title = success ? 'ChatGPT connected' : 'ChatGPT sign-in failed';
  const detail = success ? 'You can close this window and return to haze.' : 'Return to haze for details and try again.';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>${detail}</p></main></body></html>`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  // Force-close idle keep-alive connections so the event loop can settle
  // promptly (server.close alone only stops listening).
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

export async function startChatGptBrowserLogin(options: StartChatGptBrowserLoginOptions = {}): Promise<ChatGptBrowserLogin> {
  const issuer = options.issuer ?? CHATGPT_OAUTH_ISSUER;
  const port = options.port ?? CHATGPT_OAUTH_CALLBACK_PORT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  // RFC 8252 loopback redirects intentionally use HTTP: traffic never leaves
  // the host, while PKCE and the random state protect the authorization code.
  const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`;
  const pkce = await generatePkce();
  const state = base64UrlEncode(crypto.randomBytes(32));
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let settled = false;
  let resolveLogin!: (auth: OAuthProviderAuth) => void;
  let rejectLogin!: (error: Error) => void;
  const completion = new Promise<OAuthProviderAuth>((resolve, reject) => {
    resolveLogin = resolve;
    rejectLogin = reject;
  });
  // The browser may redirect before the UI starts awaiting complete(). Keep the
  // rejection observed while preserving it for the eventual caller.
  void completion.catch(() => undefined);
  const settleError = (error: Error) => {
    if (settled) return;
    settled = true;
    rejectLogin(error);
  };
  const settleSuccess = (auth: OAuthProviderAuth) => {
    if (settled) return;
    settled = true;
    resolveLogin(auth);
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', `http://localhost:${port}`);
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end('Not found');
        return;
      }
      const oauthError = url.searchParams.get('error_description') ?? url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (oauthError || !code || url.searchParams.get('state') !== state) {
        const message = oauthError ?? (!code ? 'ChatGPT callback did not include an authorization code.' : 'ChatGPT callback state did not match.');
        settleError(new Error(message));
        response.writeHead(400, {'Content-Type': 'text/html; charset=utf-8'}).end(callbackHtml(false));
        return;
      }
      try {
        const tokens = await tokenRequest(issuer, new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: CHATGPT_OAUTH_CLIENT_ID,
          code_verifier: pkce.verifier,
        }), fetchImpl, signal);
        const auth = credentialsFromTokens(tokens);
        settleSuccess(auth);
        response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}).end(callbackHtml(true));
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        settleError(failure);
        response.writeHead(500, {'Content-Type': 'text/html; charset=utf-8'}).end(callbackHtml(false));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Bind only to the loopback hostname registered in redirectUri.
    server.listen(port, 'localhost', resolve);
  }).catch(error => {
    controller.abort();
    throw new Error(`Could not start the ChatGPT sign-in callback on localhost:${port}: ${error instanceof Error ? error.message : String(error)}`);
  });

  const timeout = setTimeout(() => {
    controller.abort();
    settleError(new Error('ChatGPT sign-in timed out. Run /provider and try again.'));
  }, timeoutMs);
  const onAbort = () => settleError(new Error('ChatGPT sign-in was cancelled.'));
  options.signal?.addEventListener('abort', onAbort, {once: true});

  const close = async () => {
    if (!settled) settleError(new Error('ChatGPT sign-in was cancelled.'));
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
    controller.abort();
    await closeServer(server);
  };

  return {
    url: buildChatGptAuthorizeUrl({issuer, redirectUri, pkce, state}),
    complete: async () => {
      try {
        return await completion;
      } finally {
        await close();
      }
    },
    close,
  };
}

export async function openBrowser(url: string): Promise<boolean> {
  return openPath(url);
}
