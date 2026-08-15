import {configuredProviders, findProvider, upsertProvider} from '../../config/providers.js';
import type {HazeProviderSettings, HazeSettings} from '../../config/settings.js';
import type {Mode} from './chatModes.js';
import {PROVIDER_ACTIONS} from './wizardActions.js';
import {commaList} from './wizardInput.js';
import {assertCredentialedEndpointSecure} from '../../config/endpointSecurity.js';
import {presetModelLimitsForModels} from '../../config/providerPresets.js';
import {CHATGPT_CODEX_BASE_URL} from '../../llm/openaiCodexOAuth.js';
import type {HarvestedModelLimits} from '../../config/modelDiscovery.js';

/**
 * Warning when a `chatgpt-codex` provider's configured URL diverges from the
 * canonical endpoint (F-14): requests always route to the registered OAuth
 * client's endpoint, so a hand-edited URL (e.g. a proxy) is silently ignored.
 */
export function chatgptCodexUrlWarning(provider: HazeProviderSettings): string | undefined {
  if (provider.kind !== 'chatgpt-codex' || provider.url === CHATGPT_CODEX_BASE_URL) return undefined;
  return `Note: ${provider.name} uses ChatGPT sign-in, which always sends requests to ${CHATGPT_CODEX_BASE_URL}. The configured URL (${provider.url}) is ignored for requests.`;
}

/** Merge order for per-model limits on add: preset-curated < live-discovered < existing user settings. */
function mergedModelLimits(curated: Record<string, {contextWindowTokens?: number; maxOutputTokens?: number; pricing?: {inputPerMillionTokens: number; outputPerMillionTokens: number; cacheReadPerMillionTokens?: number; cacheWritePerMillionTokens?: number}}>, models: readonly string[], discovered: HarvestedModelLimits | undefined, existing: HarvestedModelLimits | undefined) {
  const discoveredSubset: HarvestedModelLimits = {};
  for (const model of models) if (discovered?.[model]) discoveredSubset[model] = discovered[model];
  const merged = {...curated, ...discoveredSubset, ...existing};
  return Object.keys(merged).length > 0 ? merged : undefined;
}

type WizardPatch = {
  settingsPatch?: Partial<HazeSettings>;
  message: string;
  provider?: HazeProviderSettings;
  providers?: HazeProviderSettings[];
  models?: string[];
};

export function providerAppendModels(settings: HazeSettings, providerName: string | undefined, modelsValue: string, discoveredLimits?: HarvestedModelLimits): WizardPatch {
  const provider = providerName ? findProvider(settings, providerName) : undefined;
  const models = commaList(modelsValue);
  if (!provider) return {message: 'No provider selected.'};
  if (models.length === 0) return {provider, models, message: 'Enter at least one model name.'};
  // Preset-curated limits (models.dev) flow into settings so request budgeting
  // uses the real window without the user configuring anything. Live values the
  // provider itself reported in /models discovery win over the static catalog
  // (this is the only source that knows a local server's configured window);
  // existing user-configured keys always win over both.
  const curatedLimits = presetModelLimitsForModels({name: provider.name, url: provider.url}, models);
  const modelLimits = mergedModelLimits(curatedLimits, models, discoveredLimits, provider.modelLimits);
  const nextProvider = {...provider, models: [...new Set([...provider.models, ...models])], ...(modelLimits ? {modelLimits} : {})};
  return {
    provider,
    models,
    settingsPatch: {providers: upsertProvider(settings, nextProvider), provider: provider.name},
    message: `Added ${models.length} model${models.length === 1 ? '' : 's'} to ${provider.name}. Choose a model.`,
  };
}

export function providerFinishAdd(settings: HazeSettings, draft: Partial<HazeProviderSettings>, modelsValue: string, discoveredLimits?: HarvestedModelLimits): WizardPatch {
  const models = commaList(modelsValue);
  if (!draft.name || !draft.url || models.length === 0) {
    return {models, message: 'Provider name, URL, and at least one model are required.'};
  }
  try { assertCredentialedEndpointSecure(draft.url, draft.key); } catch (error) {
    return {models, message: error instanceof Error ? error.message : String(error)};
  }
  const curatedLimits = presetModelLimitsForModels({name: draft.name, url: draft.url}, models);
  const modelLimits = mergedModelLimits(curatedLimits, models, discoveredLimits, undefined);
  const provider: HazeProviderSettings = {
    name: draft.name,
    url: draft.url,
    ...(draft.key ? {key: draft.key} : {}),
    ...(draft.kind ? {kind: draft.kind} : {}),
    models: [...new Set(models)],
    ...(modelLimits ? {modelLimits} : {}),
  };
  const divergence = chatgptCodexUrlWarning(provider);
  return {
    provider,
    models,
    settingsPatch: {providers: upsertProvider(settings, provider), provider: provider.name},
    message: `Added provider ${provider.name}. Choose a model.${divergence ? ` ${divergence}` : ''}`,
  };
}

export function providerRemoveModels(settings: HazeSettings, providerName: string | undefined, modelsValue: string): WizardPatch & {remaining?: string[]; removed?: string[]; notFound?: string[]; wasActive?: boolean} {
  const provider = providerName ? findProvider(settings, providerName) : undefined;
  if (!provider) return {message: 'No provider selected.'};
  const toRemove = commaList(modelsValue);
  if (toRemove.length === 0) return {provider, message: 'Enter at least one model name. Esc to cancel.'};
  const remaining = provider.models.filter(model => !toRemove.includes(model));
  if (remaining.length === 0) return {provider, remaining, message: 'A provider must have at least one model. Remove the provider instead.'};
  const removed = provider.models.filter(model => toRemove.includes(model));
  const notFound = toRemove.filter(model => !provider.models.includes(model));
  const updated = {...provider, models: remaining};
  const wasActive = Boolean(settings.model && provider.models.includes(settings.model) && !remaining.includes(settings.model));
  const parts = [`Removed ${removed.join(', ')} from ${provider.name}.`];
  if (notFound.length) parts.push(`Not found: ${notFound.join(', ')}.`);
  if (wasActive) parts.push('Active model selection cleared. Choose a model explicitly.');
  return {
    provider,
    remaining,
    removed,
    notFound,
    wasActive,
    settingsPatch: {
      providers: upsertProvider(settings, updated),
      ...(wasActive ? {model: undefined} : {}),
    },
    message: parts.join(' '),
  };
}

export function providerRemove(settings: HazeSettings, providerName: string | undefined): WizardPatch & {wasActiveProvider?: boolean} {
  const provider = providerName ? findProvider(settings, providerName) : undefined;
  if (!provider) return {message: 'No provider selected.'};
  const providers = configuredProviders(settings).filter(candidate => candidate.name !== providerName);
  const wasActiveProvider = settings.provider === providerName;
  return {
    provider,
    providers,
    wasActiveProvider,
    settingsPatch: {
      providers,
      ...(wasActiveProvider ? {provider: undefined, model: undefined} : {}),
    },
    message: `Removed provider ${provider.name}.${wasActiveProvider ? ' Active provider and model selection cleared.' : ''}`,
  };
}

export function providerSetImageCapable(settings: HazeSettings, providerName: string | undefined, enabled: boolean): WizardPatch {
  const provider = providerName ? findProvider(settings, providerName) : undefined;
  if (!provider) return {message: 'No provider selected.'};
  const capabilities = {...(provider.capabilities ?? {}), images: enabled};
  return {
    provider,
    settingsPatch: {providers: upsertProvider(settings, {...provider, capabilities})},
    message: enabled
      ? `Provider ${provider.name} marked image-capable. Attached images will be sent to it.`
      : `Provider ${provider.name} is no longer image-capable.`,
  };
}

export function providerSetKey(settings: HazeSettings, providerName: string | undefined, value: string): WizardPatch & {key?: string} {
  const provider = providerName ? findProvider(settings, providerName) : undefined;
  if (!provider) return {message: 'No provider selected.'};
  const key = value.trim();
  if (!key) return {provider, message: 'API key cannot be empty. Esc to cancel.'};
  try { assertCredentialedEndpointSecure(provider.url, key); } catch (error) {
    return {provider, message: error instanceof Error ? error.message : String(error)};
  }
  return {
    provider,
    key,
    settingsPatch: {providers: upsertProvider(settings, {...provider, key})},
    message: `API key updated for ${provider.name}.`,
  };
}

export type ProviderActionResult = {
  message: string;
  mode?: Mode;
  selectedName?: string;
};

export function providerActionResult(action: string, provider: HazeProviderSettings | undefined): ProviderActionResult {
  if (!provider) return {message: '', mode: 'provider'};
  if (action === PROVIDER_ACTIONS.useProvider) return {message: '', selectedName: undefined, mode: 'model'};
  if (action === PROVIDER_ACTIONS.addModels) return {message: `Comma-separated model names to add to ${provider.name}?`, mode: 'providerAppendModels'};
  if (action === PROVIDER_ACTIONS.setApiKey) return {message: `New API key for ${provider.name}? (current: ${provider.key ? 'saved' : 'not set'})`, mode: 'providerSetKey'};
  if (action === PROVIDER_ACTIONS.removeModels) return {message: `Comma-separated model names to remove from ${provider.name}?\nCurrent models: ${provider.models.join(', ')}`, mode: 'providerRemoveModels'};
  if (action === PROVIDER_ACTIONS.removeProvider) return {message: `Remove provider ${provider.name}? Type "yes" to confirm. Esc to cancel.`, mode: 'providerConfirmRemove'};
  return {message: `Unknown provider action: ${action}`};
}
