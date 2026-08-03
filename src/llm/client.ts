import {createOpenAI} from '@ai-sdk/openai';
import crypto from 'node:crypto';
import {readSettings, type HazeProviderSettings} from '../config/settings.js';
import {activeModel, modelSelector, resolveModelSelector} from '../config/providers.js';
import {assertCredentialedEndpointSecure} from '../config/endpointSecurity.js';
import type {ProviderCapabilities, ProviderRequestOptions, WorkerRuntime} from '../core/subagent/contracts.js';
export type {ProviderCapabilities, ProviderRequestOptions} from '../core/subagent/contracts.js';

export interface ModelRuntimeSelection {
  model: WorkerRuntime['model'];
  config: ModelRuntimeConfig;
  selector: string;
}

export interface ModelRuntimeConfig {
  providerName: string;
  baseURL: string;
  modelName: string;
  cacheKey: string;
  capabilities: ProviderCapabilities;
}

const HAZE_SITE_URL = 'https://denizokcu.github.io/haze/';
const HAZE_TITLE = 'Haze';

function isOpenRouter(providerName: string, baseURL: string): boolean {
  return providerName === 'openrouter' || /openrouter\.ai/i.test(baseURL);
}

function openRouterHeaders(providerName: string, baseURL: string): Record<string, string> | undefined {
  if (!isOpenRouter(providerName, baseURL)) return undefined;
  return {
    'HTTP-Referer': HAZE_SITE_URL,
    'X-Title': HAZE_TITLE,
  };
}

function capabilities(providerName: string, baseURL: string): ProviderCapabilities {
  const directOpenAI = providerName === 'openai' || /api\.openai\.com/i.test(baseURL);
  const openRouter = isOpenRouter(providerName, baseURL);
  return {
    reportsCacheUsage: directOpenAI || openRouter,
    supportsPromptCacheKey: directOpenAI,
    supportsExtendedCacheRetention: false,
    supportsStickySessionId: openRouter,
    supportsServerCompaction: false,
    supportsTextVerbosity: directOpenAI,
  };
}

function runtimeForSelection(settings: Awaited<ReturnType<typeof readSettings>>, selection: {provider: HazeProviderSettings; model: string}, cwd?: string): ModelRuntimeSelection {
  const baseURL = selection.provider.url;
  const configuredKey = selection.provider.key ?? settings.apiKey;
  assertCredentialedEndpointSecure(baseURL, configuredKey);
  const apiKey = configuredKey ?? 'not-needed';
  const name = selection.model;
  const cacheSeed = cwd ?? process.cwd();
  const cacheKey = crypto.createHash('sha256').update(`${cacheSeed}\0${name}`).digest('hex').slice(0, 32);
  return {
    model: createOpenAI({apiKey, baseURL, headers: openRouterHeaders(selection.provider.name, baseURL)}).chat(name),
    selector: modelSelector(selection.provider, name),
    config: {providerName: selection.provider.name, baseURL, modelName: name, cacheKey, capabilities: capabilities(selection.provider.name, baseURL)},
  };
}

export async function modelWithConfig(session?: {cwd?: string; modelSelector?: string}) {
  const settings = await readSettings();
  const override = session?.modelSelector?.trim();
  let selection: {provider: HazeProviderSettings; model: string} | undefined;
  if (override) {
    const resolved = resolveModelSelector(settings, override);
    if (resolved.status === 'found') selection = {provider: resolved.provider, model: resolved.model};
  } else selection = activeModel(settings);
  return selection ? runtimeForSelection(settings, selection, session?.cwd) : undefined;
}

export async function resolveWorkerRuntime(input: {active: ModelRuntimeSelection; settings: Awaited<ReturnType<typeof readSettings>>; selector?: string; cwd?: string}): Promise<{status: 'found'; runtime: WorkerRuntime} | {status: 'missing' | 'ambiguous'; message: string}> {
  const requested = input.selector?.trim();
  let selected = input.active;
  if (requested) {
    const resolved = resolveModelSelector(input.settings, requested);
    if (resolved.status !== 'found') return {status: resolved.status, message: resolved.status === 'ambiguous' ? `Worker model ${requested} is ambiguous; use provider:model.` : `Worker model ${requested} is not configured. Configure it via /provider or remove subagents.workerModel.`};
    selected = runtimeForSelection(input.settings, {provider: resolved.provider, model: resolved.model}, input.cwd);
  }
  return {status: 'found', runtime: {model: selected.model, selector: selected.selector, providerName: selected.config.providerName, capabilities: selected.config.capabilities, requestOptions: providerRequestSettings(selected.config)}};
}

export function providerRequestSettings(config: ModelRuntimeConfig): ProviderRequestOptions {
  return {
    ...(config.capabilities.supportsPromptCacheKey || config.capabilities.supportsTextVerbosity ? {
      providerOptions: {
        openai: {
          ...(config.capabilities.supportsPromptCacheKey ? {promptCacheKey: config.cacheKey} : {}),
          ...(config.capabilities.supportsTextVerbosity ? {textVerbosity: 'low' as const} : {}),
        },
      },
    } : {}),
    ...(config.capabilities.supportsStickySessionId ? {headers: {'x-session-id': config.cacheKey}} : {}),
  };
}
