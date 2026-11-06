import type {ReasoningLevel} from '../core/agent/reasoningPolicy.js';
import {REASONING_LEVELS, type ResolvedReasoningPolicy} from '../core/agent/reasoningPolicy.js';
import type {HazeProviderSettings} from './settings.js';
import {endpointModelFacts} from './providerModelFacts.js';

/** Apply Mistral-specific transport only to its direct API. */
export function isMistralApi(url: string): boolean {
  try { return new URL(url).hostname.toLowerCase() === 'api.mistral.ai'; } catch { return false; }
}

/** Known effort levels for direct endpoints; gateways retain their own policy. */
export function providerReasoningLevels(url: string, model: string): readonly ReasoningLevel[] | undefined {
  return endpointModelFacts(url, model).reasoningLevels;
}

export interface ReasoningCapabilities {
  support: 'supported' | 'unsupported' | 'unknown';
  levels: readonly ReasoningLevel[];
}

/** One shared profile for the UI, main request, and auxiliary calls. */
export function reasoningCapabilitiesForProvider(provider: HazeProviderSettings, model: string): ReasoningCapabilities {
  const known = (levels: readonly ReasoningLevel[]): ReasoningCapabilities => ({support: levels.length ? 'supported' : 'unsupported', levels});
  if (provider.capabilities?.reasoningEffort === false) return known([]);
  const override = provider.modelReasoningLevels?.[model] ?? provider.reasoningLevels;
  if (override) return known(provider.reasoningFormat === 'thinking' || provider.reasoningFormat === 'enable-thinking' ? override.filter(level => level === 'none' || level === 'high') : override);
  if (provider.reasoningFormat === 'thinking' || provider.reasoningFormat === 'enable-thinking') return known(['none', 'high']);
  if (provider.capabilities?.reasoningEffort === true) return known(REASONING_LEVELS);
  const documented = providerReasoningLevels(provider.kind === 'chatgpt-codex' ? 'https://api.openai.com' : provider.url, model);
  if (documented) return known(documented);
  if (provider.kind === 'haze-build') return known(['none', 'high']);
  // Official OpenAI and OpenRouter protocols support portable effort settings.
  // A model-specific profile above narrows the choices when documented.
  try {
    const host = new URL(provider.url).hostname.toLowerCase();
    if (host === 'openrouter.ai') return known(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  } catch { /* Invalid URLs are rejected when creating the runtime. */ }
  return {support: 'unknown', levels: []};
}

export function reasoningLevelsForProvider(provider: HazeProviderSettings, model: string): readonly ReasoningLevel[] {
  return reasoningCapabilitiesForProvider(provider, model).levels;
}

/** Shared requested-versus-sent decision for UI and all request paths. */
export function resolveProviderReasoning(provider: HazeProviderSettings, model: string, requested: ReasoningLevel | undefined): ResolvedReasoningPolicy {
  if (!requested) return {requested, effective: 'disabled', reason: 'no reasoning depth requested'};
  const {support, levels} = reasoningCapabilitiesForProvider(provider, model);
  if (!levels.length) return {requested, effective: 'disabled', reason: support === 'unknown' ? 'reasoning support is unknown; parameter omitted (provider default)' : 'reasoning effort is unsupported; parameter omitted (provider default)'};
  if (!levels.includes(requested)) return {requested, effective: 'disabled', reason: `${model} does not support reasoning effort ${requested}; parameter omitted (provider default). Choose ${levels.join(', ')}, or unset.`};
  return {requested, effective: requested, reason: 'applied via supported provider protocol'};
}
