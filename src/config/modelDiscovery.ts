import type {HazeProviderSettings} from './settings.js';

/**
 * Model discovery against the OpenAI-compatible `/models` endpoint every
 * provider in haze exposes. Used to turn "add models" from a memorize-and-type
 * step into a pick-from-list step; callers fall back to manual input when the
 * endpoint is unavailable.
 */
export type ModelDiscoveryResult =
  | {status: 'ok'; models: string[]}
  | {status: 'failed'; error: string};

const DEFAULT_TIMEOUT_MS = 5000;
/** Discovery feeds a type-filtered picker; cap the stored list, not the UX. */
const MAX_DISCOVERED_MODELS = 500;

export function modelsEndpointUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/models`;
}

export function parseModelsBody(body: unknown): string[] {
  const data = (body as {data?: unknown})?.data;
  if (!Array.isArray(data)) return [];
  const ids = data
    .map(item => (item as {id?: unknown})?.id)
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map(id => id.trim());
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b)).slice(0, MAX_DISCOVERED_MODELS);
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timed out';
    return error.message;
  }
  return String(error);
}

export async function discoverProviderModels(
  provider: Pick<HazeProviderSettings, 'url' | 'key'>,
  options: {timeoutMs?: number; fetchImpl?: typeof fetch} = {},
): Promise<ModelDiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetchImpl(modelsEndpointUrl(provider.url), {
      headers: {accept: 'application/json', ...(provider.key ? {authorization: `Bearer ${provider.key}`} : {})},
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {status: 'failed', error: describeFetchError(error)};
  }
  if (!response.ok) return {status: 'failed', error: `endpoint returned HTTP ${response.status}`};
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {status: 'failed', error: 'endpoint returned no JSON'};
  }
  const models = parseModelsBody(body);
  if (models.length === 0) return {status: 'failed', error: 'endpoint returned no models'};
  return {status: 'ok', models};
}
