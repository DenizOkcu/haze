import {createOpenAI} from '@ai-sdk/openai';
import crypto from 'node:crypto';
import {readSettings} from '../config/settings.js';
import {activeModel} from '../config/providers.js';

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

export async function modelWithConfig(session?: {cwd?: string}) {
  const settings = await readSettings();
  const selection = activeModel(settings);
  const baseURL = process.env.OPENAI_BASE_URL ?? selection.provider.url;
  const apiKey = process.env.OPENAI_API_KEY ?? selection.provider.key ?? settings.apiKey ?? 'not-needed';
  const name = process.env.HAZE_MODEL ?? selection.model;
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
  return (await modelWithConfig()).model;
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
