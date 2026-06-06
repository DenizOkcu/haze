import type {HazeSettings, HazeProviderSettings} from './settings.js';

export const DEFAULT_PROVIDER_NAME = 'openrouter';
export const DEFAULT_PROVIDER_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_MODEL = 'x-ai/grok-build-0.1';

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
  return {
    name,
    url,
    ...(key ? {key} : {}),
    models: normalizeModels(provider.models, fallbackModel),
  };
}

export function configuredProviders(settings: HazeSettings): HazeProviderSettings[] {
  const providers = (settings.providers ?? [])
    .map(provider => normalizeProvider(provider))
    .filter((provider): provider is HazeProviderSettings => Boolean(provider));

  const legacyUrl = settings.baseURL ?? (settings.provider === DEFAULT_PROVIDER_NAME || settings.apiKey ? DEFAULT_PROVIDER_URL : undefined);
  if (legacyUrl && !providers.some(provider => provider.name === DEFAULT_PROVIDER_NAME)) {
    providers.unshift({
      name: DEFAULT_PROVIDER_NAME,
      url: legacyUrl,
      ...(settings.apiKey ? {key: settings.apiKey} : {}),
      models: normalizeModels([], settings.model ?? DEFAULT_MODEL),
    });
  }

  if (providers.length === 0) {
    return [{name: DEFAULT_PROVIDER_NAME, url: DEFAULT_PROVIDER_URL, models: [settings.model ?? DEFAULT_MODEL]}];
  }

  return providers;
}

export function findProvider(settings: HazeSettings, name: string): HazeProviderSettings | undefined {
  return configuredProviders(settings).find(provider => provider.name === name);
}

export function activeProvider(settings: HazeSettings): HazeProviderSettings {
  const providers = configuredProviders(settings);
  return providers.find(provider => provider.name === settings.provider) ?? providers[0];
}

export function activeModel(settings: HazeSettings): {provider: HazeProviderSettings; model: string} {
  const provider = activeProvider(settings);
  const model = settings.model && provider.models.includes(settings.model)
    ? settings.model
    : settings.model ?? provider.models[0] ?? DEFAULT_MODEL;
  return {provider, model};
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

export function upsertProvider(settings: HazeSettings, provider: HazeProviderSettings): HazeProviderSettings[] {
  const providers = configuredProviders(settings).filter(existing => existing.name !== provider.name);
  return [...providers, provider];
}

export function providerHasKey(settings: HazeSettings, provider: HazeProviderSettings) {
  return Boolean(provider.key ?? (provider.name === DEFAULT_PROVIDER_NAME ? settings.apiKey : undefined));
}
