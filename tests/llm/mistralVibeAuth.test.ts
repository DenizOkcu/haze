import {createHash} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import {startMistralVibeLogin} from '../../src/llm/mistralVibeAuth.js';

const payload = () => ({process_id: 'process-1', sign_in_url: 'https://console.mistral.ai/vibe/sign-in/process-1', poll_url: 'https://console.mistral.ai/api/vibe/sign-in/poll/token', expires_at: new Date(Date.now() + 60_000).toISOString()});
const response = (value: unknown) => new Response(JSON.stringify(value), {status: 200, headers: {'content-type': 'application/json'}});

describe('Mistral Vibe browser sign-in', () => {
  it('exchanges a completed PKCE sign-in for a key', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(payload())).mockResolvedValueOnce(response({status: 'completed', exchange_token: 'exchange'})).mockResolvedValueOnce(response({api_key: 'key'}));
    const login = await startMistralVibeLogin(fetchImpl as typeof fetch);
    expect(login.url).toBe(payload().sign_in_url);
    await expect(login.complete()).resolves.toBe('key');
    const startBody = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    const exchangeBody = JSON.parse(fetchImpl.mock.calls[2]![1].body as string);
    expect(startBody).toEqual({code_challenge: createHash('sha256').update(exchangeBody.code_verifier).digest('base64url'), code_challenge_method: 'S256'});
    expect(exchangeBody.exchange_token).toBe('exchange');
    expect(fetchImpl.mock.calls[2]![0]).toBe('https://console.mistral.ai/api/vibe/sign-in/process-1/exchange');
    expect(fetchImpl.mock.calls.every(call => call[1].redirect === 'error')).toBe(true);
  });

  it('rejects an untrusted poll URL before sending a request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({...payload(), poll_url: 'https://evil.example/api/poll'}));
    await expect(startMistralVibeLogin(fetchImpl as typeof fetch)).rejects.toThrow('unexpected URL');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a denied sign-in without exchanging credentials', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(payload())).mockResolvedValueOnce(response({status: 'denied'}));
    const login = await startMistralVibeLogin(fetchImpl as typeof fetch);
    await expect(login.complete()).rejects.toThrow('denied');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
