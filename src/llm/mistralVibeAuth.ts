import {createHash, randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const CONSOLE_ORIGIN = 'https://console.mistral.ai';
const AUTH_BASE = `${CONSOLE_ORIGIN}/api/vibe/sign-in`;

function validatedUrl(value: unknown, api: boolean): string {
  if (typeof value !== 'string') throw new Error('Mistral sign-in returned an invalid URL.');
  const url = new URL(value);
  if (url.origin !== CONSOLE_ORIGIN || url.username || url.password || (api && !url.pathname.startsWith('/api/'))) {
    throw new Error('Mistral sign-in returned an unexpected URL.');
  }
  return url.href;
}

async function jsonRequest(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {...init, redirect: 'error', signal: AbortSignal.timeout(15_000)});
  if (!response.ok) throw new Error(`Mistral sign-in request failed (HTTP ${response.status}).`);
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Mistral sign-in returned an invalid response.');
  return data as Record<string, unknown>;
}

/** Mistral Vibe's browser flow exchanges a PKCE verifier for an API key. */
export async function startMistralVibeLogin(fetchImpl: typeof fetch = fetch): Promise<{url: string; complete: () => Promise<string>}> {
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const post = (body: unknown): RequestInit => ({method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const process = await jsonRequest(AUTH_BASE, post({code_challenge: challenge, code_challenge_method: 'S256'}), fetchImpl);
  const url = validatedUrl(process.sign_in_url, false);
  const pollUrl = validatedUrl(process.poll_url, true);
  const processId = process.process_id;
  const expires = typeof process.expires_at === 'string' ? Date.parse(process.expires_at) : NaN;
  if (typeof processId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(processId) || !Number.isFinite(expires) || expires <= Date.now()) {
    throw new Error('Mistral sign-in returned invalid process details.');
  }
  const deadline = Math.min(expires, Date.now() + 10 * 60_000);
  return {url, complete: async () => {
    let failures = 0;
    while (Date.now() < deadline) {
      let status: Record<string, unknown>;
      try {
        status = await jsonRequest(pollUrl, {}, fetchImpl);
        failures = 0;
      } catch {
        if (++failures >= 3) throw new Error('Mistral sign-in status could not be retrieved.');
        await delay(Math.min(3000, Math.max(0, deadline - Date.now())));
        continue;
      }
      if (status.status === 'completed' && typeof status.exchange_token === 'string' && status.exchange_token) {
        const result = await jsonRequest(`${AUTH_BASE}/${processId}/exchange`, post({exchange_token: status.exchange_token, code_verifier: verifier}), fetchImpl);
        if (typeof result.api_key !== 'string' || !result.api_key) throw new Error('Mistral sign-in did not return an API key.');
        return result.api_key;
      }
      if (status.status !== 'pending') throw new Error('Mistral sign-in was denied, expired, or returned an invalid status.');
      await delay(Math.min(3000, Math.max(0, deadline - Date.now())));
    }
    throw new Error('Mistral sign-in timed out.');
  }};
}
