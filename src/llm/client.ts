import {createOpenAI} from '@ai-sdk/openai';
import crypto from 'node:crypto';
import {readSettings} from '../config/settings.js';
import {resolveModelSelector, resolveModelSlot, type ModelResolution, type ModelSlotName} from '../config/providers.js';

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

export async function modelWithConfig(session?: {cwd?: string; modelSelector?: string; slot?: ModelSlotName}) {
  const settings = await readSettings();
  const override = session?.modelSelector?.trim();
  let resolution: ModelResolution;
  if (override) {
    resolution = resolveModelSelector(settings, override);
  } else {
    resolution = resolveModelSlot(settings, session?.slot ?? 'primary');
  }
  if (resolution.status !== 'found') return undefined;
  const selection = {provider: resolution.provider, model: resolution.model};
  const baseURL = selection.provider.url;
  const apiKey = selection.provider.key ?? settings.apiKey ?? 'not-needed';
  const name = selection.model;
  const cacheSeed = session?.cwd ?? process.cwd();
  const cacheKey = crypto.createHash('sha256').update(`${cacheSeed}\0${name}`).digest('hex').slice(0, 32);
  return {
    model: createOpenAI({apiKey, baseURL, headers: openRouterHeaders(selection.provider.name, baseURL)}).chat(name),
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
