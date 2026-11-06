import type {HazeSettings, HazeProviderSettings} from './settings.js';
import {findByName, upsertByName} from '../utils/collections.js';
import {createHash} from 'node:crypto';

// Used only to migrate legacy single-provider OpenRouter settings (apiKey/baseURL)
// into the providers array. There is no default provider or model anymore: users
// must configure a provider themselves via /provider.
const LEGACY_OPENROUTER_URL = 'https://openrouter.ai/api/v1';

export type ModelResolution =
  | {status: 'found'; provider: HazeProviderSettings; model: string}
  | {status: 'ambiguous'; model: string; providers: HazeProviderSettings[]}
  | {status: 'missing'};

function normalizeModels(models: unknown, fallbackModel?: string) {
  const values = Array.isArray(models) ? models : [];
  const normalized = values
    .filter((model): model is string => typeof model === 'string')
    .map(model => model.trim())
    .filter(Boolean);
  if (normalized.length > 0) return [...new Set(normalized)];
  return fallbackModel ? [fallbackModel] : [];
}

function normalizeProvider(provider: HazeProviderSettings, fallbackModel?: string): HazeProviderSettings | undefined {
  const name = provider.name?.trim();
  const url = provider.url?.trim();
  if (!name || !url) return undefined;
  const key = provider.key?.trim();
  // Capabilities are explicit only: an absent/false flag means "not capable".
  const capabilities = provider.capabilities ?? undefined;
  const normalized: HazeProviderSettings = {
    ...provider,
    name,
    url,
    ...(key ? {key} : {}),
    ...(provider.kind ? {kind: provider.kind} : {}),
    ...(capabilities ? {capabilities} : {}),
    ...(provider.reasoningLevels ? {reasoningLevels: provider.reasoningLevels} : {}),
    ...(provider.modelReasoningLevels ? {modelReasoningLevels: provider.modelReasoningLevels} : {}),
    ...(provider.reasoningFormat ? {reasoningFormat: provider.reasoningFormat} : {}),
    ...(provider.modelLimits ? {modelLimits: provider.modelLimits} : {}),
    ...(provider.trustedDeployments ? {trustedDeployments: provider.trustedDeployments} : {}),
    models: normalizeModels(provider.models, fallbackModel),
  };
  if (!key) delete normalized.key;
  return normalized;
}

export function configuredProviders(settings: HazeSettings): HazeProviderSettings[] {
  const providers = (settings.providers ?? [])
    .map(provider => normalizeProvider(provider))
    .filter((provider): provider is HazeProviderSettings => Boolean(provider));

  // Legacy single-provider settings. Only migrate when the user actually supplied
  // a base URL or API key — never invent a provider or model out of nothing.
  const legacyUrl = settings.baseURL ?? (settings.apiKey ? LEGACY_OPENROUTER_URL : undefined);
  if (legacyUrl && !providers.some(provider => provider.name === 'openrouter')) {
    providers.unshift({
      name: 'openrouter',
      url: legacyUrl,
      ...(settings.apiKey ? {key: settings.apiKey} : {}),
      models: normalizeModels([], settings.model),
    });
  }

  return providers;
}

export function findProvider(settings: HazeSettings, name: string): HazeProviderSettings | undefined {
  return findByName(configuredProviders(settings), name);
}

export function activeProvider(settings: HazeSettings): HazeProviderSettings | undefined {
  if (!settings.provider) return undefined;
  return configuredProviders(settings).find(provider => provider.name === settings.provider);
}

export function activeModel(settings: HazeSettings): {provider: HazeProviderSettings; model: string} | undefined {
  const provider = activeProvider(settings);
  if (!provider || !settings.model || !provider.models.includes(settings.model)) return undefined;
  return {provider, model: settings.model};
}

export function resolveModelSelector(settings: HazeSettings, selector: string): ModelResolution {
  const trimmed = selector.trim();
  if (!trimmed) return {status: 'missing'};
  const separator = trimmed.indexOf(':');
  if (separator > 0) {
    const providerName = trimmed.slice(0, separator).trim();
    const model = trimmed.slice(separator + 1).trim();
    const provider = findProvider(settings, providerName);
    if (!provider || !model || !provider.models.includes(model)) return {status: 'missing'};
    return {status: 'found', provider, model};
  }

  const matches = configuredProviders(settings).filter(provider => provider.models.includes(trimmed));
  if (matches.length === 1) return {status: 'found', provider: matches[0], model: trimmed};
  if (matches.length > 1) return {status: 'ambiguous', model: trimmed, providers: matches};
  return {status: 'missing'};
}

export function modelSelector(provider: HazeProviderSettings, model: string) {
  return `${provider.name}:${model}`;
}

/** Stable non-secret endpoint identity for detecting changes across resume. */
export function providerEndpointFingerprint(provider: Pick<HazeProviderSettings, 'url' | 'kind'>): string {
  return createHash('sha256').update(`${provider.kind ?? 'openai-compatible'}\0${provider.url}`).digest('hex');
}

export function upsertProvider(settings: HazeSettings, provider: HazeProviderSettings): HazeProviderSettings[] {
  return upsertByName(configuredProviders(settings), provider);
}

export function providerHasKey(settings: HazeSettings, provider: HazeProviderSettings) {
  return Boolean(providerApiKey(settings, provider));
}

/** Legacy API keys are scoped to the legacy OpenRouter provider. */
export function providerApiKey(settings: HazeSettings, provider: HazeProviderSettings): string | undefined {
  const legacyUrl = settings.baseURL ?? LEGACY_OPENROUTER_URL;
  return provider.key ?? (provider.name === 'openrouter' && provider.url.replace(/\/+$/, '') === legacyUrl.replace(/\/+$/, '') ? settings.apiKey : undefined);
}

/** Image input is explicit-only (F03): never inferred from URL or model name. */
export function providerImageCapable(provider: HazeProviderSettings) {
  return provider.kind !== 'haze-build' && provider.capabilities?.images === true;
}
