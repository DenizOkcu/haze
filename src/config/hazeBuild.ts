import {z} from 'zod';
import {assertCredentialedEndpointSecure} from './endpointSecurity.js';
import type {HazeProviderSettings} from './settings.js';

export const HAZE_BUILD_PROVIDER = 'haze.build';
export const HAZE_BUILD_MODEL = 'haze0.1-coder-flash';
export const hazeBuildManifestSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.literal(HAZE_BUILD_PROVIDER),
  model: z.literal(HAZE_BUILD_MODEL),
  modelRepository: z.literal('cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit'),
  modelRevision: z.literal('f1e8415c4f29508fe281da4e256df26573213bfd'),
  templateSha256: z.literal('e84f32a23fdda27689f868aa4a1a5621f41133e51a48d7f3efcbea2839574259'),
  runtimeVersion: z.literal('0.32.0'),
  sourceRevision: z.string().regex(/^(?:[a-f0-9]{40}|unrecorded)$/),
  scheduler: z.object({maxBatchedTokens: z.number().int().min(256).max(8192), gpuMemoryUtilization: z.number().min(0.5).max(0.95), cpuOffloadGb: z.number().min(0).max(12), eager: z.boolean()}),
  contextWindowTokens: z.number().int().min(4096).max(262144),
  maxOutputTokens: z.number().int().min(256).max(32768),
  activeSequences: z.number().int().min(1).max(4),
  servingProfile: z.enum(['quality', 'concurrent', 'full-context']),
  decodeProfile: z.enum(['baseline', 'ngram', 'mtp']),
  capabilities: z.object({text: z.literal(true), tools: z.literal(true), images: z.literal(false), thinking: z.literal('binary'), preserveThinking: z.literal(true)}),
});
export type HazeBuildManifest = z.infer<typeof hazeBuildManifestSchema>;

/** Refreshed per attempt: a mutable endpoint alias must never imply stale capacity. */
export async function discoverHazeBuildManifest(provider: Pick<HazeProviderSettings, 'url' | 'key'>, fetchImpl: typeof fetch = fetch): Promise<HazeBuildManifest> {
  if (!provider.key?.trim()) throw new Error('haze.build requires an API key. Configure it via /provider.');
  const url = new URL(provider.url);
  if (url.username || url.password || url.search || url.hash) throw new Error('haze.build requires a final API base URL without userinfo, query or fragment.');
  assertCredentialedEndpointSecure(url.href, provider.key);
  const endpoint = `${url.href.replace(/\/+$/, '')}/haze/manifest`;
  const headers = {authorization: `Bearer ${provider.key}`, accept: 'application/json'};
  // One retry for transient transport failures only (network error, timeout,
  // proxy 502/503/504); contract and auth errors are not worth a second round trip.
  let response: Response | undefined;
  let networkError: unknown;
  for (let attempt = 0; attempt < 2 && response === undefined; attempt++) {
    try {
      response = await fetchImpl(endpoint, {headers, redirect: 'error', signal: AbortSignal.timeout(15_000)});
    } catch (error) {
      networkError = error;
    }
    if (response !== undefined && [502, 503, 504].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      response = undefined;
    }
  }
  if (response === undefined) {
    const detail = networkError instanceof Error && (networkError.name === 'TimeoutError' || networkError.name === 'AbortError')
      ? 'timed out after 15 seconds; the deployment may still be starting'
      : `is unreachable (${networkError instanceof Error ? networkError.message : 'network error'})`;
    throw new Error(`haze.build manifest ${detail}. Deploy the compatible server or choose an ordinary OpenAI-compatible provider.`);
  }
  if (!response.ok) throw new Error(`haze.build manifest returned HTTP ${response.status}; deploy the compatible server or choose an ordinary OpenAI-compatible provider.`);
  if (!response.body) throw new Error('haze.build manifest has no response body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65536) throw new Error('haze.build manifest exceeds 64 KiB.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('haze.build manifest is not valid JSON; deploy the compatible server or choose an ordinary OpenAI-compatible provider.');
  }
  const parsed = hazeBuildManifestSchema.safeParse(payload);
  if (!parsed.success) throw new Error('Incompatible haze.build manifest. Expected contract v1, haze0.1-coder-flash, text/tools and binary thinking with preservation.');
  if (parsed.data.maxOutputTokens >= parsed.data.contextWindowTokens) throw new Error('Invalid haze.build output/context envelope.');
  return parsed.data;
}
