import {createOpenAI} from '@ai-sdk/openai';
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';
import {createOpenRouter} from '@openrouter/ai-sdk-provider';
import {discoverHazeBuildManifest, type HazeBuildManifest} from '../config/hazeBuild.js';
import {createHazeBuildModel} from './hazeBuild.js';
import {isMistralApi, reasoningLevelsForProvider, resolveProviderReasoning} from '../config/providerReasoning.js';
import {mistralRequestBody} from './mistralReasoning.js';
import crypto from 'node:crypto';
import {isIP} from 'node:net';
import {readSettings, type HazeProviderSettings} from '../config/settings.js';
import {catalogLimitsFor} from '../config/providerModelFacts.js';
import {ollamaModelLimits, type HarvestedModelLimits} from '../config/modelDiscovery.js';
import {presetModelLimitsForModels} from '../config/providerPresets.js';
import {activeModel, modelSelector, providerApiKey, resolveModelSelector} from '../config/providers.js';
import {assertCredentialedEndpointSecure, isLoopbackHostname} from '../config/endpointSecurity.js';
import type {ProviderCapabilities, ProviderRequestOptions} from '../core/providerContracts.js';
import type {WorkerRuntime} from '../core/subagent/contracts.js';
import {effectiveRequestedReasoning, isStoredReasoning, reasoningCallSetting, resolveAttemptReasoning, REASONING_LEVELS, type ReasoningLevel, type ResolvedReasoningPolicy, type StoredReasoningSetting} from '../core/agent/reasoningPolicy.js';
import {FALLBACK_CONTEXT_WINDOW_TOKENS, FALLBACK_LOCAL_CONTEXT_TOKENS} from '../core/agent/contextBudget.js';
import {createChatGptCodexFetch} from './openaiCodex.js';
export type {ProviderCapabilities, ProviderRequestOptions} from '../core/providerContracts.js';

export interface ModelRuntimeSelection {
  model: WorkerRuntime['model'];
  config: ModelRuntimeConfig;
  selector: string;
}

export interface ModelRuntimeConfig {
  providerName: string;
  providerKind?: HazeProviderSettings['kind'];
  baseURL: string;
  isLocal?: boolean;
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
  /** Where the context window came from. */
  contextWindowSource: 'settings' | 'discovery' | 'preset' | 'catalog' | 'user-fallback' | 'default-fallback' | 'deployment';
  deployment?: HazeBuildManifest;
  warnings?: string[];
  /** Optional output-token limit metadata for request budgeting (RH-005). */
  maxOutputTokens?: number;
}

const HAZE_SITE_URL = 'https://github.com/DenizOkcu/haze';
const HAZE_TITLE = 'Haze';
// The SDK requires a non-empty apiKey even though the OAuth fetch adapter
// replaces authentication. Generate a non-credential sentinel at runtime so
// static scanners cannot mistake a fixed placeholder for a shipped secret.
const OAUTH_SDK_SENTINEL = `oauth-sentinel-${crypto.randomUUID()}`;

function isOpenRouter(_providerName: string, baseURL: string): boolean {
  try { return new URL(baseURL).hostname.toLowerCase() === 'openrouter.ai'; } catch { return false; }
}

/** Groq Qwen requires parsed reasoning when tools are present. */
function groqRequestTransform(baseURL: string, model: string): ((body: Record<string, unknown>) => Record<string, unknown>) | undefined {
  try {
    if (new URL(baseURL).hostname.toLowerCase() !== 'api.groq.com' || model.toLowerCase() !== 'qwen/qwen3.8-27b') return undefined;
  } catch { return undefined; }
  return body => Array.isArray(body.tools) && body.tools.length ? {...body, reasoning_format: 'parsed'} : body;
}

function openRouterHeaders(providerName: string, baseURL: string): Record<string, string> | undefined {
  if (!isOpenRouter(providerName, baseURL)) return undefined;
  return {
    'HTTP-Referer': HAZE_SITE_URL,
    'X-Title': HAZE_TITLE,
  };
}

/** True when the endpoint is OpenAI's own API, not a gateway/local server speaking the compatible subset. */
function isDirectOpenAi(_providerName: string, baseURL: string, providerKind: HazeProviderSettings['kind']): boolean {
  try { return providerKind !== 'chatgpt-codex' && new URL(baseURL).hostname.toLowerCase() === 'api.openai.com'; } catch { return false; }
}

function capabilities(provider: HazeProviderSettings, modelName: string): ProviderCapabilities {
  const {name: providerName, url: baseURL, kind: providerKind} = provider;
  const directOpenAI = isDirectOpenAi(providerName, baseURL, providerKind);
  const openRouter = isOpenRouter(providerName, baseURL);
  // The same profile drives UI choices, main requests, and worker defaults.
  const levels = reasoningLevelsForProvider(provider, modelName);
  const supportsReasoningEffort = levels.length > 0;
  return {
    reportsCacheUsage: providerKind === 'haze-build' || directOpenAI || openRouter,
    supportsPromptCacheKey: directOpenAI,
    supportsExtendedCacheRetention: false,
    supportsStickySessionId: openRouter,
    supportsServerCompaction: false,
    supportsTextVerbosity: directOpenAI,
    supportsReasoningEffort,
    ...(openRouter ? {reasoningTransport: 'openrouter' as const} : {}),
    ...(supportsReasoningEffort && (!openRouter || provider.reasoningLevels || provider.modelReasoningLevels?.[modelName]) ? {workerReasoningEffort: REASONING_LEVELS.find(level => levels.includes(level))} : {}),
    ...(providerKind === 'haze-build' ? {supportsBinaryThinking: true} : {}),
  };
}

/** True for loopback/local inference servers, whose effective window is server-configured (often far below the model's). */
export function isLocalProviderUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (isLoopbackHostname(hostname) || hostname === '0.0.0.0' || hostname.endsWith('.local')) return true;
    if (isIP(hostname) === 4) {
      const [a, b] = hostname.split('.').map(Number);
      return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
    }
    return isIP(hostname) === 6 && /^(?:f[cd]|fe[89ab])/i.test(hostname);
  } catch {
    return false;
  }
}

export function isLocalProvider(provider: Pick<HazeProviderSettings, 'url' | 'location'>): boolean {
  return provider.location ? provider.location === 'local' : isLocalProviderUrl(provider.url);
}

function runtimeForSelection(settings: Awaited<ReturnType<typeof readSettings>>, selection: {provider: HazeProviderSettings; model: string}, cwd?: string, reasoningOverride?: StoredReasoningSetting, sessionReasoningByModel?: Record<string, StoredReasoningSetting>, deployment?: HazeBuildManifest, freshLocalLimits?: HarvestedModelLimits): ModelRuntimeSelection {
  const baseURL = selection.provider.url;
  const providerKind = selection.provider.kind;
  const configuredKey = providerKind === 'chatgpt-codex' ? undefined : providerApiKey(settings, selection.provider);
  assertCredentialedEndpointSecure(baseURL, configuredKey);
  const apiKey = configuredKey ?? 'not-needed';
  const name = selection.model;
  const cacheSeed = cwd ?? process.cwd();
  const cacheKey = crypto.createHash('sha256').update(`${cacheSeed}\0${name}`).digest('hex').slice(0, 32);
  const caps = capabilities(selection.provider, name);
  const selector = modelSelector(selection.provider, name);
  // The full precedence chain lives in one pure resolver
  // (`resolveAttemptReasoning`): run-scoped override → session per-model map →
  // global settings → built-in default (low). The stored or session
  // `provider-default` sentinel sends no parameter at all. The capability gate
  // in resolveReasoningPolicy is unchanged — nothing forces the parameter onto
  // an unsupported protocol.
  const storedReasoning = resolveAttemptReasoning({
    modelSelector: selector,
    runOverride: reasoningOverride,
    sessionReasoningByModel,
    globalSetting: isStoredReasoning(settings.reasoning) ? settings.reasoning : undefined,
  });
  const requestedReasoning = effectiveRequestedReasoning(storedReasoning);

  const resolvedPolicy = resolveProviderReasoning(selection.provider, name, requestedReasoning);
  const reasoningPolicy = deployment && resolvedPolicy.effective !== 'disabled'
    ? {...resolvedPolicy, reason: `haze.build binary thinking ${requestedReasoning === 'none' ? 'off' : 'on'}; effort levels do not imply different compute budgets`}
    : resolvedPolicy;
  // Preserve native reasoning continuation on Responses and OpenRouter.
  const headers = openRouterHeaders(selection.provider.name, baseURL);
  const customFormat = selection.provider.reasoningFormat;
  const transformRequestBody = customFormat === 'thinking' || customFormat === 'enable-thinking'
    ? (body: Record<string, unknown>) => {
      if (typeof body.reasoning_effort !== 'string') return body;
      const {reasoning_effort: effort, ...rest} = body;
      return customFormat === 'thinking' ? {...rest, thinking: {type: effort === 'none' ? 'disabled' : 'enabled'}} : {...rest, enable_thinking: effort !== 'none'};
    }
    : isMistralApi(baseURL) ? mistralRequestBody : groqRequestTransform(baseURL, name);
  const model = deployment
    ? createHazeBuildModel({baseURL, apiKey, manifest: deployment})
    : providerKind === 'chatgpt-codex'
      ? createOpenAI({apiKey: OAUTH_SDK_SENTINEL, baseURL, fetch: createChatGptCodexFetch(selection.provider.name)}).responses(name)
      : isDirectOpenAi(selection.provider.name, baseURL, providerKind)
        ? /^gpt-6(?:\.|-)/i.test(name) ? createOpenAI({apiKey, baseURL, headers}).responses(name) : createOpenAI({apiKey, baseURL, headers}).chat(name)
        : isOpenRouter(selection.provider.name, baseURL)
          ? createOpenRouter({apiKey, baseURL, headers, compatibility: 'strict'}).chat(name)
        : createOpenAICompatible({name: selection.provider.name, baseURL, apiKey, headers, includeUsage: true, ...(transformRequestBody ? {transformRequestBody} : {})}).chatModel(name);
  const limits = modelLimitsFor(selection.provider, name);
  // Class-aware fallback so unknown local models (server-configured window,
  // silent truncation) stay conservative while unknown hosted models get the
  // modern 128K floor. The curated catalog (Pillar 1.8) fills known families
  // before any fallback; local servers never consult it because their
  // effective window is server-configured. A user-set fallback setting
  // overrides the built-in default; the source tag distinguishes an
  // intentional guess (no warning) from the default guess (warned once per
  // session) (RH-005).
  const isLocal = isLocalProvider(selection.provider);
  // Local loaded context can change on restart; a persisted discovery is only a
  // hint to re-probe, never a safe runtime budget on its own.
  const discovered = isLocal ? freshLocalLimits?.[name] : selection.provider.discoveredModelLimits?.[name];
  const preset = isLocal ? undefined : presetModelLimitsForModels(selection.provider, [name])[name];
  const catalog = isLocal ? undefined : catalogLimitsFor(name);
  const userFallback = isLocal ? settings.localContextWindowFallbackTokens : settings.contextWindowFallbackTokens;
  const fallbackTokens = userFallback ?? (isLocal ? FALLBACK_LOCAL_CONTEXT_TOKENS : FALLBACK_CONTEXT_WINDOW_TOKENS);
  const contextWindowSource = limits.contextWindowTokens !== undefined
    ? 'settings' as const
    : discovered?.contextWindowTokens !== undefined ? 'discovery' as const
    : preset?.contextWindowTokens !== undefined ? 'preset' as const
    : catalog
      ? 'catalog' as const
      : userFallback !== undefined ? 'user-fallback' as const : 'default-fallback' as const;
  const maxOutputTokens = limits.maxOutputTokens ?? discovered?.maxOutputTokens ?? preset?.maxOutputTokens ?? catalog?.maxOutputTokens;
  return {
    model,
    selector,
    config: {
      providerName: selection.provider.name,
      providerKind,
      baseURL,
      isLocal,
      modelName: name,
      cacheKey,
      capabilities: caps,
      reasoningPolicy,
      contextWindowTokens: deployment ? Math.min(limits.contextWindowTokens ?? deployment.contextWindowTokens, deployment.contextWindowTokens) : limits.contextWindowTokens ?? discovered?.contextWindowTokens ?? preset?.contextWindowTokens ?? catalog?.contextWindowTokens ?? fallbackTokens,
      contextWindowSource: deployment ? 'deployment' : contextWindowSource,
      ...(deployment ? {deployment, maxOutputTokens: Math.min(limits.maxOutputTokens ?? deployment.maxOutputTokens, deployment.maxOutputTokens),
        warnings: [
          ...(limits.contextWindowTokens !== undefined && limits.contextWindowTokens !== deployment.contextWindowTokens ? ['Configured context differs from the current haze.build deployment; using the smaller safe limit.'] : []),
          ...(limits.maxOutputTokens !== undefined && limits.maxOutputTokens !== deployment.maxOutputTokens ? ['Configured output tokens differ from the current haze.build deployment; using the smaller safe limit.'] : []),
        ]}
        : maxOutputTokens !== undefined ? {maxOutputTokens} : {}),
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

export async function modelWithConfig(session?: {cwd?: string; modelSelector?: string; reasoningOverride?: StoredReasoningSetting; reasoningByModel?: Record<string, StoredReasoningSetting>}, settings?: Awaited<ReturnType<typeof readSettings>>) {
  // Callers may pass pre-read settings so a turn performs a single settings
  // read (CR-024); otherwise read fresh.
  const resolvedSettings = settings ?? await readSettings();
  const override = session?.modelSelector?.trim();
  let selection: {provider: HazeProviderSettings; model: string} | undefined;
  if (override) {
    const resolved = resolveModelSelector(resolvedSettings, override);
    if (resolved.status === 'found') selection = {provider: resolved.provider, model: resolved.model};
  } else selection = activeModel(resolvedSettings);
  if (!selection) return undefined;
  assertCredentialedEndpointSecure(selection.provider.url, selection.provider.kind === 'chatgpt-codex' ? undefined : providerApiKey(resolvedSettings, selection.provider));
  const deployment = selection.provider.kind === 'haze-build' ? await discoverHazeBuildManifest(selection.provider) : undefined;
  if (deployment && selection.model !== deployment.model) throw new Error(`haze.build currently serves ${deployment.model}; choose it explicitly via /model.`);
  const freshLocalLimits = await refreshLocalLimits(selection, resolvedSettings);
  return runtimeForSelection(resolvedSettings, selection, session?.cwd, session?.reasoningOverride, session?.reasoningByModel, deployment, freshLocalLimits);
}

async function refreshLocalLimits(selection: {provider: HazeProviderSettings; model: string}, settings: Awaited<ReturnType<typeof readSettings>>): Promise<HarvestedModelLimits | undefined> {
  if (!isLocalProvider(selection.provider) || selection.provider.kind === 'haze-build' || selection.provider.modelLimits?.[selection.model]?.contextWindowTokens !== undefined || !selection.provider.discoveredModelLimits?.[selection.model]) return undefined;
  return ollamaModelLimits({baseUrl: selection.provider.url, models: [selection.model], conservativeCap: settings.localContextWindowFallbackTokens ?? FALLBACK_LOCAL_CONTEXT_TOKENS, timeoutMs: 1000}).catch(() => undefined);
}

export async function resolveWorkerRuntime(input: {active: ModelRuntimeSelection; settings: Awaited<ReturnType<typeof readSettings>>; selector?: string; cwd?: string}): Promise<{status: 'found'; runtime: WorkerRuntime} | {status: 'missing' | 'ambiguous'; message: string}> {
  const requested = input.selector?.trim();
  let selected = input.active;
  if (requested) {
    const resolved = resolveModelSelector(input.settings, requested);
    if (resolved.status !== 'found') return {status: resolved.status, message: resolved.status === 'ambiguous' ? `Worker model ${requested} is ambiguous; use provider:model.` : `Worker model ${requested} is not configured. Configure it via /provider or remove subagents.workerModel.`};
    assertCredentialedEndpointSecure(resolved.provider.url, resolved.provider.kind === 'chatgpt-codex' ? undefined : providerApiKey(input.settings, resolved.provider));
    // The active deployment was fetched and validated for this attempt. An
    // explicit worker selecting that same provider/model can reuse it rather
    // than making a second network round trip; different endpoints still refresh.
    const sameDeployment = resolved.provider.kind === 'haze-build'
      && input.active.config.deployment
      && resolved.provider.name === input.active.config.providerName
      && resolved.provider.url === input.active.config.baseURL
      && resolved.model === input.active.config.modelName;
    const deployment = resolved.provider.kind === 'haze-build'
      ? sameDeployment ? input.active.config.deployment : await discoverHazeBuildManifest(resolved.provider)
      : undefined;
    if (deployment && resolved.model !== deployment.model) return {status: 'missing', message: `haze.build currently serves ${deployment.model}.`};
    const selection = {provider: resolved.provider, model: resolved.model};
    selected = runtimeForSelection(input.settings, selection, input.cwd, undefined, undefined, deployment, await refreshLocalLimits(selection, input.settings));
  }
  return {status: 'found', runtime: {model: selected.model, selector: selected.selector, providerName: selected.config.providerName, capabilities: selected.config.capabilities, requestOptions: providerRequestSettings(selected.config), contextWindowTokens: selected.config.contextWindowTokens, maxOutputTokens: selected.config.maxOutputTokens, ...(selected.config.deployment ? {nativeMaxConcurrency: selected.config.deployment.activeSequences} : {})}};
}

export function providerRequestSettings(config: ModelRuntimeConfig): ProviderRequestOptions {
  // Top-level AI SDK `reasoning` setting; the key is omitted entirely when the
  // policy is disabled so the parameter is never sent (and never merged with a
  // providerOptions reasoning key — the SDK ignores the top-level value then).
  const setting = reasoningCallSetting(config.reasoningPolicy);
  const reasoning: ReasoningLevel | undefined = setting !== undefined && setting !== 'provider-default' ? setting : undefined;
  if (config.providerKind === 'chatgpt-codex') {
    return {
      omitMaxOutputTokens: true,
      providerOptions: {openai: {store: false, include: ['reasoning.encrypted_content']}},
      headers: {'session-id': config.cacheKey},
      ...(reasoning ? {reasoning} : {}),
    };
  }
  if (isOpenRouter(config.providerName, config.baseURL)) return {
    headers: {'x-session-id': config.cacheKey},
    ...(reasoning ? {providerOptions: {openrouter: {reasoning: {effort: reasoning}}}} : {}),
  };
  const caps = config.capabilities;
  const openaiOptions: Record<string, import('ai').JSONValue | undefined> = {};
  if (caps.supportsPromptCacheKey) openaiOptions.promptCacheKey = config.cacheKey;
  if (caps.supportsTextVerbosity) openaiOptions.textVerbosity = 'low';
  if (caps.supportsPromptCacheKey && /^gpt-6(?:\.|-)/i.test(config.modelName)) {
    openaiOptions.store = false;
    openaiOptions.include = ['reasoning.encrypted_content'];
  }
  const providerOptions = Object.keys(openaiOptions).length > 0 ? {openai: openaiOptions} : undefined;
  return {
    ...(providerOptions ? {providerOptions} : {}),
    ...(caps.supportsStickySessionId ? {headers: {'x-session-id': config.cacheKey}} : {}),
    ...(reasoning ? {reasoning} : {}),
  };
}
