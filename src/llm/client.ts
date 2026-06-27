import {createOpenAI} from '@ai-sdk/openai';
import crypto from 'node:crypto';
import {readSettings, type HazeProviderSettings} from '../config/settings.js';
import {activeModel, resolveModelSelector} from '../config/providers.js';

export interface ProviderCapabilities {
  reportsCacheUsage: boolean;
  supportsPromptCacheKey: boolean;
  supportsExtendedCacheRetention: boolean;
  supportsStickySessionId: boolean;
  supportsServerCompaction: boolean;
  supportsTextVerbosity: boolean;
}

export interface ModelRuntimeConfig {
  providerName: string;
  baseURL: string;
  modelName: string;
  cacheKey: string;
  capabilities: ProviderCapabilities;
}

function capabilities(providerName: string, baseURL: string): ProviderCapabilities {
  const directOpenAI = providerName === 'openai' || /api\.openai\.com/i.test(baseURL);
  const openRouter = providerName === 'openrouter' || /openrouter\.ai/i.test(baseURL);
  return {
    reportsCacheUsage: directOpenAI || openRouter,
    supportsPromptCacheKey: directOpenAI,
    supportsExtendedCacheRetention: false,
    supportsStickySessionId: openRouter,
    supportsServerCompaction: false,
    supportsTextVerbosity: directOpenAI,
  };
}

export async function modelWithConfig(session?: {cwd?: string; modelSelector?: string}) {
  const settings = await readSettings();
  const override = session?.modelSelector?.trim();
  let selection: {provider: HazeProviderSettings; model: string} | undefined;
  if (override) {
    const resolved = resolveModelSelector(settings, override);
    if (resolved.status === 'found') selection = {provider: resolved.provider, model: resolved.model};
  } else {
    selection = activeModel(settings);
  }
  if (!selection) return undefined;
  const baseURL = selection.provider.url;
  const apiKey = selection.provider.key ?? settings.apiKey ?? 'not-needed';
  const name = selection.model;
  const cacheSeed = session?.cwd ?? process.cwd();
  const cacheKey = crypto.createHash('sha256').update(`${cacheSeed}\0${name}`).digest('hex').slice(0, 32);
  return {
    model: createOpenAI({apiKey, baseURL}).chat(name),
    config: {
      providerName: selection.provider.name,
      baseURL,
      modelName: name,
      cacheKey,
      capabilities: capabilities(selection.provider.name, baseURL),
    } satisfies ModelRuntimeConfig,
  };
}

export async function model() {
  return (await modelWithConfig())?.model;
}

export function cacheKeyFor(name: string, cwd?: string) {
  const seed = cwd ?? process.cwd();
  return crypto.createHash('sha256').update(`${seed}\0${name}`).digest('hex').slice(0, 32);
}

export function providerRequestSettings(config: ModelRuntimeConfig) {
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
