import {createOpenAI} from '@ai-sdk/openai';
import crypto from 'node:crypto';
import {readSettings, type HazeProviderSettings} from '../config/settings.js';
import {activeModel, modelSelector, resolveModelSelector} from '../config/providers.js';
import {assertCredentialedEndpointSecure} from '../config/endpointSecurity.js';
import type {ProviderCapabilities, ProviderRequestOptions, WorkerRuntime} from '../core/subagent/contracts.js';
import {resolveReasoningPolicy, type ReasoningLevel, type ResolvedReasoningPolicy} from '../core/agent/reasoningPolicy.js';
import {FALLBACK_CONTEXT_WINDOW_TOKENS, FALLBACK_LOCAL_CONTEXT_TOKENS} from '../core/agent/contextBudget.js';
import {createChatGptCodexFetch} from './openaiCodex.js';
export type {ProviderCapabilities, ProviderRequestOptions} from '../core/subagent/contracts.js';

export interface ModelRuntimeSelection {
  model: WorkerRuntime['model'];
  config: ModelRuntimeConfig;
  selector: string;
}

export interface ModelRuntimeConfig {
  providerName: string;
  providerKind?: HazeProviderSettings['kind'];
  baseURL: string;
  modelName: string;
  cacheKey: string;
  capabilities: ProviderCapabilities;
  /** Resolved reasoning policy (requested vs effective); observable, no secrets. */
  reasoningPolicy: ResolvedReasoningPolicy;
  /**
   * Effective context window for request budgeting (RH-005). Always set: the
   * user-configured value when present, otherwise a class-aware fallback
   * (128K hosted / 32K local) so `contextWindowSource` can flag the guess.
   */
  contextWindowTokens: number;
  /** Where contextWindowTokens came from: per-model settings, a user-set fallback, or the built-in default. */
  contextWindowSource: 'settings' | 'user-fallback' | 'default-fallback';
  /** Optional output-token limit metadata for request budgeting (RH-005). */
  maxOutputTokens?: number;
}

const HAZE_SITE_URL = 'https://denizokcu.github.io/haze/';
const HAZE_TITLE = 'Haze';
// The SDK requires a non-empty apiKey even though the OAuth fetch adapter
// replaces authentication. Generate a non-credential sentinel at runtime so
// static scanners cannot mistake a fixed placeholder for a shipped secret.
const OAUTH_SDK_SENTINEL = `oauth-sentinel-${crypto.randomUUID()}`;

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

function capabilities(providerName: string, baseURL: string, providerKind?: HazeProviderSettings['kind']): ProviderCapabilities {
  const directOpenAI = providerKind !== 'chatgpt-codex' && (providerName === 'openai' || /api\.openai\.com/i.test(baseURL));
  const openRouter = isOpenRouter(providerName, baseURL);
  return {
    reportsCacheUsage: directOpenAI || openRouter,
    supportsPromptCacheKey: directOpenAI,
    supportsExtendedCacheRetention: false,
    supportsStickySessionId: openRouter,
    supportsServerCompaction: false,
    supportsTextVerbosity: directOpenAI,
    supportsReasoningEffort: directOpenAI,
  };
}

/** True for loopback/local inference servers, whose effective window is server-configured (often far below the model's). */
export function isLocalProviderUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0' || hostname.endsWith('.local');
  } catch {
    return false;
  }
}

function runtimeForSelection(settings: Awaited<ReturnType<typeof readSettings>>, selection: {provider: HazeProviderSettings; model: string}, cwd?: string): ModelRuntimeSelection {
  const baseURL = selection.provider.url;
  const providerKind = selection.provider.kind;
  const configuredKey = providerKind === 'chatgpt-codex' ? undefined : selection.provider.key ?? settings.apiKey;
  assertCredentialedEndpointSecure(baseURL, configuredKey);
  const apiKey = configuredKey ?? 'not-needed';
  const name = selection.model;
  const cacheSeed = cwd ?? process.cwd();
  const cacheKey = crypto.createHash('sha256').update(`${cacheSeed}\0${name}`).digest('hex').slice(0, 32);
  const caps = capabilities(selection.provider.name, baseURL, providerKind);
  const requestedReasoning = isReasoningLevel(settings.reasoning) ? settings.reasoning : undefined;
  const reasoningPolicy = resolveReasoningPolicy({requested: requestedReasoning, capabilities: caps});
  const openai = providerKind === 'chatgpt-codex'
    ? createOpenAI({apiKey: OAUTH_SDK_SENTINEL, baseURL, fetch: createChatGptCodexFetch(selection.provider.name)})
    : createOpenAI({apiKey, baseURL, headers: openRouterHeaders(selection.provider.name, baseURL)});
  const limits = modelLimitsFor(selection.provider, name);
  // Class-aware fallback so unknown local models (server-configured window,
  // silent truncation) stay conservative while unknown hosted models get the
  // modern 128K floor. A user-set fallback setting overrides the built-in
  // default; the source tag distinguishes an intentional guess (no warning)
  // from the default guess (warned once per session) (RH-005).
  const isLocal = isLocalProviderUrl(baseURL);
  const userFallback = isLocal ? settings.localContextWindowFallbackTokens : settings.contextWindowFallbackTokens;
  const fallbackTokens = userFallback ?? (isLocal ? FALLBACK_LOCAL_CONTEXT_TOKENS : FALLBACK_CONTEXT_WINDOW_TOKENS);
  const contextWindowSource = limits.contextWindowTokens !== undefined
    ? 'settings'
    : userFallback !== undefined ? 'user-fallback' as const : 'default-fallback' as const;
  return {
    model: providerKind === 'chatgpt-codex' ? openai.responses(name) : openai.chat(name),
    selector: modelSelector(selection.provider, name),
    config: {
      providerName: selection.provider.name,
      providerKind,
      baseURL,
      modelName: name,
      cacheKey,
      capabilities: caps,
      reasoningPolicy,
      contextWindowTokens: limits.contextWindowTokens ?? fallbackTokens,
      contextWindowSource,
      ...(limits.maxOutputTokens !== undefined ? {maxOutputTokens: limits.maxOutputTokens} : {}),
    },
  };
}

/** Resolve optional context-window/output-token metadata for the selected model (RH-005). */
function modelLimitsFor(provider: HazeProviderSettings, modelName: string): {contextWindowTokens?: number; maxOutputTokens?: number} {
  const limits = provider.modelLimits?.[modelName];
  if (!limits) return {};
  const out: {contextWindowTokens?: number; maxOutputTokens?: number} = {};
  if (typeof limits.contextWindowTokens === 'number') out.contextWindowTokens = limits.contextWindowTokens;
  if (typeof limits.maxOutputTokens === 'number') out.maxOutputTokens = limits.maxOutputTokens;
  return out;
}

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return value === 'low' || value === 'medium' || value === 'high';
}

export async function modelWithConfig(session?: {cwd?: string; modelSelector?: string}, settings?: Awaited<ReturnType<typeof readSettings>>) {
  // Callers may pass pre-read settings so a turn performs a single settings
  // read (CR-024); otherwise read fresh.
  const resolvedSettings = settings ?? await readSettings();
  const override = session?.modelSelector?.trim();
  let selection: {provider: HazeProviderSettings; model: string} | undefined;
  if (override) {
    const resolved = resolveModelSelector(resolvedSettings, override);
    if (resolved.status === 'found') selection = {provider: resolved.provider, model: resolved.model};
  } else selection = activeModel(resolvedSettings);
  return selection ? runtimeForSelection(resolvedSettings, selection, session?.cwd) : undefined;
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
  if (config.providerKind === 'chatgpt-codex') {
    return {
      omitMaxOutputTokens: true,
      providerOptions: {openai: {store: false, include: ['reasoning.encrypted_content']}},
      headers: {'session-id': config.cacheKey},
    };
  }
  const caps = config.capabilities;
  const openaiOptions: Record<string, import('ai').JSONValue | undefined> = {};
  if (caps.supportsPromptCacheKey) openaiOptions.promptCacheKey = config.cacheKey;
  if (caps.supportsTextVerbosity) openaiOptions.textVerbosity = 'low';
  if (config.reasoningPolicy.effective !== 'disabled') openaiOptions.reasoningEffort = config.reasoningPolicy.effective;
  const providerOptions = Object.keys(openaiOptions).length > 0 ? {openai: openaiOptions} : undefined;
  return {
    ...(providerOptions ? {providerOptions} : {}),
    ...(caps.supportsStickySessionId ? {headers: {'x-session-id': config.cacheKey}} : {}),
  };
}
