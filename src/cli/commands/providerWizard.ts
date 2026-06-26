import {configuredProviders, findProvider, upsertProvider} from '../../config/providers.js';
import type {HazeProviderSettings, HazeSettings} from '../../config/settings.js';
import {commaList} from './wizardInput.js';

type WizardPatch = {
  settingsPatch?: Partial<HazeSettings>;
  message: string;
  provider?: HazeProviderSettings;
  providers?: HazeProviderSettings[];
  models?: string[];
};

export function providerAppendModels(settings: HazeSettings, providerName: string | undefined, modelsValue: string): WizardPatch {
  const provider = providerName ? findProvider(settings, providerName) : undefined;
  const models = commaList(modelsValue);
  if (!provider) return {message: 'No provider selected.'};
  if (models.length === 0) return {provider, models, message: 'Enter at least one model name.'};
  const nextProvider = {...provider, models: [...new Set([...provider.models, ...models])]};
  return {
    provider,
    models,
    settingsPatch: {providers: upsertProvider(settings, nextProvider), provider: provider.name},
    message: `Added ${models.length} model${models.length === 1 ? '' : 's'} to ${provider.name}. Choose a model.`,
  };
}

export function providerFinishAdd(settings: HazeSettings, draft: Partial<HazeProviderSettings>, modelsValue: string): WizardPatch {
  const models = commaList(modelsValue);
  if (!draft.name || !draft.url || models.length === 0) {
    return {models, message: 'Provider name, URL, and at least one model are required.'};
  }
  const provider: HazeProviderSettings = {
    name: draft.name,
    url: draft.url,
    ...(draft.key ? {key: draft.key} : {}),
    models: [...new Set(models)],
  };
  return {
    provider,
    models,
    settingsPatch: {providers: upsertProvider(settings, provider), provider: provider.name},
    message: `Added provider ${provider.name}. Choose a model.`,
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
  if (wasActive) parts.push(`Active model updated to ${remaining[0]}.`);
  return {
    provider,
    remaining,
    removed,
    notFound,
    wasActive,
    settingsPatch: {
      providers: upsertProvider(settings, updated),
      ...(wasActive ? {model: remaining[0]} : {}),
    },
    message: parts.join(' '),
  };
}

export function providerRemove(settings: HazeSettings, providerName: string | undefined): WizardPatch & {wasActiveProvider?: boolean} {
  const provider = providerName ? findProvider(settings, providerName) : undefined;
  if (!provider) return {message: 'No provider selected.'};
  const providers = configuredProviders(settings).filter(candidate => candidate.name !== providerName);
  const wasActiveProvider = settings.provider === providerName || (!settings.provider && configuredProviders(settings)[0]?.name === providerName);
  return {
    provider,
    providers,
    wasActiveProvider,
    settingsPatch: {
      providers,
      ...(wasActiveProvider ? {provider: providers[0]?.name, model: providers[0]?.models[0]} : {}),
    },
    message: `Removed provider ${provider.name}.${wasActiveProvider ? ` Switched to ${providers[0]?.name ?? 'no provider'}.` : ''}`,
  };
}
