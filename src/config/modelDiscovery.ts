import type {HazeProviderSettings} from './settings.js';

/** Per-model limits harvested from a provider's /models listing. */
export type HarvestedModelLimits = Record<string, {contextWindowTokens?: number; maxOutputTokens?: number}>;

/**
 * Model discovery against the OpenAI-compatible `/models` endpoint every
 * provider in haze exposes. Used to turn "add models" from a memorize-and-type
 * step into a pick-from-list step; callers fall back to manual input when the
 * endpoint is unavailable.
 */
export type ModelDiscoveryResult =
  | {status: 'ok'; models: string[]; modelLimits?: HarvestedModelLimits}
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

/** Lowest and highest plausible token values; anything outside is treated as garbage. */
const HARVEST_MIN_TOKENS = 1_000;
const HARVEST_MAX_TOKENS = 10_000_000;

function harvestedTokens(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined;
  return value >= HARVEST_MIN_TOKENS && value <= HARVEST_MAX_TOKENS ? value : undefined;
}

function firstHarvested(...values: unknown[]): number | undefined {
  for (const value of values) {
    const tokens = harvestedTokens(value);
    if (tokens !== undefined) return tokens;
  }
  return undefined;
}

/**
 * Ollama native enrichment. Ollama's OpenAI-compatible /v1/models returns no
 * context fields (verified against ollama 0.32), but its native API does, with
 * different fidelity levels — resolved best-first per model:
 *   1. GET /api/ps — the ACTUAL runtime context of a currently-loaded model
 *      (reflects OLLAMA_CONTEXT_LENGTH and Ollama's vram-based auto-sizing);
 *      only available while the model stays loaded (keep_alive window).
 *   2. POST /api/show parameters `num_ctx N` — the user's explicit per-model
 *      setting (Modelfile), capped by the model's trained maximum.
 *   3. POST /api/show model_info `<arch>.context_length` — the model's
 *      theoretical maximum. The effective runtime window may be smaller
 *      (auto-sized to VRAM), so it is capped at the conservative local
 *      fallback rather than trusted outright (silent truncation guard).
 */
const OLLAMA_PROBE_TIMEOUT_MS = 4_000;
/** Bound the per-save /api/show probe loop so bulk pastes stay cheap. */
const OLLAMA_PROBE_MAX_MODELS = 8;

function loopbackRoot(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return undefined;
  }
}

interface OllamaShowFacts {
  max?: number;
  numCtx?: number;
}

/** Extract context facts from an /api/show response body. */
export function ollamaContextFromShow(show: unknown): OllamaShowFacts {
  if (typeof show !== 'object' || show == null) return {};
  const record = show as Record<string, unknown>;
  const facts: OllamaShowFacts = {};
  const modelInfo = record.model_info;
  if (typeof modelInfo === 'object' && modelInfo != null) {
    let max: number | undefined;
    for (const [key, value] of Object.entries(modelInfo as Record<string, unknown>)) {
      // Skip derived keys like `<arch>.rope.scaling.original_context_length`,
      // which describe the pre-scaling trained length, not the usable window.
      if (!key.endsWith('.context_length') || /rope|original/.test(key)) continue;
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
        max = max === undefined ? value : Math.max(max, value);
      }
    }
    if (max !== undefined) facts.max = max;
  }
  if (typeof record.parameters === 'string') {
    const match = /(?<![\w.])num_ctx\s+(\d+)/.exec(record.parameters);
    const parsed = match ? Number(match[1]) : undefined;
    if (parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0) facts.numCtx = parsed;
  }
  return facts;
}

/** Effective context for one model given the probe results; undefined = nothing trustworthy. */
function resolveOllamaContext(psContext: number | undefined, facts: OllamaShowFacts, conservativeCap: number): number | undefined {
  if (psContext !== undefined && psContext > 0) return psContext;
  if (facts.numCtx !== undefined) return Math.min(facts.numCtx, facts.max ?? Number.MAX_SAFE_INTEGER);
  if (facts.max !== undefined) return Math.min(facts.max, conservativeCap);
  return undefined;
}

/**
 * Probe a local Ollama server for the effective context of the given models.
 * Best-effort: any failing request simply omits that model. Only call for
 * loopback base URLs (the /api/* surface is Ollama-specific).
 */
export async function ollamaModelLimits(input: {baseUrl: string; models: readonly string[]; conservativeCap: number; fetchImpl?: typeof fetch; timeoutMs?: number}): Promise<HarvestedModelLimits> {
  const root = loopbackRoot(input.baseUrl);
  if (!root || input.models.length === 0) return {};
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? OLLAMA_PROBE_TIMEOUT_MS;
  const get = async (url: string, init?: RequestInit): Promise<unknown> => {
    const response = await fetchImpl(url, {...init, signal: AbortSignal.timeout(timeoutMs)});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  };
  const out: HarvestedModelLimits = {};
  // Runtime ground truth for loaded models (one request, may be stale/empty).
  const psLoaded = new Map<string, number>();
  try {
    const ps = await get(`${root}/api/ps`) as {models?: Array<{name?: unknown; model?: unknown; context_length?: unknown}>};
    for (const entry of ps?.models ?? []) {
      for (const key of [entry.name, entry.model]) {
        if (typeof key === 'string' && typeof entry.context_length === 'number' && entry.context_length > 0) {
          psLoaded.set(key, entry.context_length);
        }
      }
    }
  } catch {
    // Not an Ollama server, or /api/ps unavailable: fall through to /api/show.
  }
  for (const model of input.models.slice(0, OLLAMA_PROBE_MAX_MODELS)) {
    const psContext = psLoaded.get(model);
    if (psContext !== undefined) {
      out[model] = {contextWindowTokens: psContext};
      continue;
    }
    try {
      const facts = ollamaContextFromShow(await get(`${root}/api/show`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({model})}));
      const contextWindowTokens = resolveOllamaContext(undefined, facts, input.conservativeCap);
      if (contextWindowTokens !== undefined) out[model] = {contextWindowTokens};
    } catch {
      // Unknown model, cloud model, or not an Ollama server: leave unset.
    }
  }
  return out;
}

/**
 * Harvest non-standard context/output fields from an OpenAI-compatible
 * `/models` response. The official schema carries only `id`/`created`/`object`,
 * but several providers add extensions (OpenRouter `context_length`, Groq
 * `context_window`, LM Studio `max_context_length`, plus the usual
 * `max_output_tokens`/`max_completion_tokens`/`max_tokens` output caps).
 * Values are sanity-clamped so a quirky proxy cannot poison request budgeting;
 * models with no recognizable fields are simply omitted. This is the only
 * source that can know a local server's actually-configured window.
 */
export function harvestModelLimits(body: unknown): HarvestedModelLimits {
  const data = (body as {data?: unknown})?.data;
  if (!Array.isArray(data)) return {};
  const out: HarvestedModelLimits = {};
  for (const item of data) {
    if (typeof item !== 'object' || item == null) continue;
    const entry = item as Record<string, unknown>;
    const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : undefined;
    if (!id) continue;
    const contextWindowTokens = firstHarvested(entry.context_window, entry.context_length, entry.max_context_length, entry.max_context_tokens);
    const maxOutputTokens = firstHarvested(entry.max_output_tokens, entry.max_completion_tokens, entry.max_tokens);
    if (contextWindowTokens !== undefined || maxOutputTokens !== undefined) {
      out[id] = {...(contextWindowTokens !== undefined ? {contextWindowTokens} : {}), ...(maxOutputTokens !== undefined ? {maxOutputTokens} : {})};
    }
  }
  return out;
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
  const modelLimits = harvestModelLimits(body);
  return {status: 'ok', models, ...(Object.keys(modelLimits).length > 0 ? {modelLimits} : {})};
}
