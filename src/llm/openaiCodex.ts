import {getProviderAuth, setProviderAuth, type OAuthProviderAuth} from '../config/providerAuth.js';
import {CHATGPT_CODEX_RESPONSES_URL, refreshChatGptAuth} from './openaiCodexOAuth.js';

const REFRESH_MARGIN_MS = 60_000;
const refreshes = new Map<string, Promise<OAuthProviderAuth>>();

async function currentAuth(providerName: string): Promise<OAuthProviderAuth> {
  const stored = await getProviderAuth(providerName);
  if (!stored || stored.type !== 'oauth') throw new Error(`ChatGPT is not connected for provider ${providerName}. Run /provider and choose "sign in with ChatGPT".`);
  if (stored.expires > Date.now() + REFRESH_MARGIN_MS) return stored;

  let pending = refreshes.get(providerName);
  if (!pending) {
    pending = refreshChatGptAuth(stored)
      .then(async auth => {
        // Re-read the store before writing back so a concurrent sign-out on
        // another haze instance (or this one) wins. Without this, an in-flight
        // refresh would resurrect credentials the user just removed.
        const current = await getProviderAuth(providerName);
        if (!current || current.type !== 'oauth') return auth;
        await setProviderAuth(providerName, auth);
        return auth;
      })
      .finally(() => refreshes.delete(providerName));
    refreshes.set(providerName, pending);
  }
  return pending;
}

function authenticatedHeaders(init: RequestInit | undefined, auth: OAuthProviderAuth): Headers {
  const headers = new Headers(init?.headers);
  headers.delete('authorization');
  headers.set('authorization', `Bearer ${auth.access}`);
  if (auth.accountId) headers.set('ChatGPT-Account-Id', auth.accountId);
  headers.set('originator', 'haze');
  return headers;
}

export function createChatGptCodexFetch(providerName: string, fetchImpl: typeof fetch = fetch): typeof fetch {
  return async (_input, init) => {
    const auth = await currentAuth(providerName);
    return fetchImpl(CHATGPT_CODEX_RESPONSES_URL, {...init, headers: authenticatedHeaders(init, auth)});
  };
}

/** Test-only reset for process-global refresh deduplication. */
export function clearChatGptRefreshes(): void {
  refreshes.clear();
}
