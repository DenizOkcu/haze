import {createOpenAI} from '@ai-sdk/openai';
import {createAnthropic} from '@ai-sdk/anthropic';
import crypto from 'node:crypto';
import {readSettings, type HazeProviderSettings} from '../config/settings.js';
import {activeModel, resolveModelSelector} from '../config/providers.js';
import {PROVIDER_PRESETS} from '../config/providerPresets.js';

const ANTHROPIC_EXTENDED_THINKING_BUDGET_TOKENS = 8000;

export interface ProviderCapabilities {
  reportsCacheUsage: boolean;
  supportsPromptCacheKey: boolean;
  supportsExtendedCacheRetention: boolean;
  supportsStickySessionId: boolean;
  supportsServerCompaction: boolean;
  supportsTextVerbosity: boolean;
  supportsExtendedThinking: boolean;
}

export interface ModelRuntimeConfig {
  providerName: string;
  baseURL: string;
  modelName: string;
  cacheKey: string;
  capabilities: ProviderCapabilities;
}

function isAnthropicProvider(providerName: string): boolean {
  const byId = PROVIDER_PRESETS.find(preset => preset.id === providerName);
  if (byId?.id === 'anthropic') return true;
  return PROVIDER_PRESETS.some(preset => preset.id === 'anthropic' && preset.name === providerName);
}

function capabilities(providerName: string, baseURL: string): ProviderCapabilities {
  const directOpenAI = providerName === 'openai' || /api\.openai\.com/i.test(baseURL);
  const openRouter = providerName === 'openrouter' || /openrouter\.ai/i.test(baseURL);
  const anthropic = isAnthropicProvider(providerName) || /api\.anthropic\.com/i.test(baseURL);
  return {
    reportsCacheUsage: directOpenAI || openRouter || anthropic,
    supportsPromptCacheKey: directOpenAI,
    supportsExtendedCacheRetention: false,
    supportsStickySessionId: openRouter,
    supportsServerCompaction: false,
    supportsTextVerbosity: directOpenAI,
    supportsExtendedThinking: anthropic,
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
  const useAnthropic =
    isAnthropicProvider(selection.provider.name) || /api\.anthropic\.com/i.test(baseURL);
  return {
    model: useAnthropic
      ? createAnthropic({apiKey, baseURL}).chat(name)
      : createOpenAI({apiKey, baseURL}).chat(name),
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
  const isExtendedThinkingModel =
    config.capabilities.supportsExtendedThinking &&
    /^claude-(3-7-sonnet|opus-4|sonnet-4|fable)/i.test(config.modelName);
  const providerOptions: {
    openai?: {promptCacheKey?: string; textVerbosity?: 'low'};
    anthropic?: {thinking: {type: 'enabled'; budgetTokens: number}};
  } = {};
  if (config.capabilities.supportsPromptCacheKey || config.capabilities.supportsTextVerbosity) {
    providerOptions.openai = {
      ...(config.capabilities.supportsPromptCacheKey ? {promptCacheKey: config.cacheKey} : {}),
      ...(config.capabilities.supportsTextVerbosity ? {textVerbosity: 'low' as const} : {}),
    };
  }
  if (isExtendedThinkingModel) {
    providerOptions.anthropic = {
      thinking: {type: 'enabled' as const, budgetTokens: ANTHROPIC_EXTENDED_THINKING_BUDGET_TOKENS},
    };
  }
  return {
    ...(providerOptions.openai || providerOptions.anthropic ? {providerOptions} : {}),
    ...(config.capabilities.supportsStickySessionId ? {headers: {'x-session-id': config.cacheKey}} : {}),
  };
}
