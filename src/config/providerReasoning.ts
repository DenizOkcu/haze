import type {ReasoningLevel} from '../core/agent/reasoningPolicy.js';
import {REASONING_LEVELS} from '../core/agent/reasoningPolicy.js';
import type {HazeProviderSettings} from './settings.js';

/** Apply Mistral-specific transport only to its direct API. */
export function isMistralApi(url: string): boolean {
  try { return new URL(url).hostname.toLowerCase() === 'api.mistral.ai'; } catch { return false; }
}

/** Known effort levels for direct endpoints; gateways retain their own policy. */
export function providerReasoningLevels(url: string, model: string): readonly ReasoningLevel[] | undefined {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return undefined; }
  if (host === 'api.mistral.ai') {
    switch (model.toLowerCase()) {
      case 'mistral-small-2603':
      case 'mistral-small-latest':
      case 'mistral-medium-latest':
      case 'mistral-medium-3-5':
      case 'mistral-vibe-cli-latest': return ['none', 'high'];
      case 'mistral-large-4':
      case 'mistral-large-4-0': return ['low', 'medium', 'high'];
      case 'zai-glm-5-3':
      case 'zai-glm-5-3-flash': return ['low', 'high', 'max'];
      default: return undefined;
    }
  }
  if (host === 'api.openai.com') {
    if (/^gpt-4o(?:-|$)/i.test(model)) return [];
    if (/^gpt-5\.(?:2|4)(?:-mini)?$/i.test(model)) return ['none', 'low', 'medium', 'high', 'xhigh'];
    if (/^gpt-5\.6(?:-(?:sol|terra|luna))?$/i.test(model)) return ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
    if (/^gpt-6(?:\.1)?-(?:astra|sol|terra|luna)$/i.test(model)) {
      return /^gpt-6(?:-sol|-luna|\.1-terra)$/i.test(model) ? ['none', 'low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high', 'xhigh', 'max'];
    }
  }
  if (host === 'api.deepseek.com' && /^(?:deepseek-flash|deepseek-v4(?:\.1)?-(?:flash|pro))$/i.test(model)) return ['none', 'low', 'high', 'max'];
  if (host === 'api.groq.com') {
    if (/^openai\/gpt-oss-(?:20b|120b)$/i.test(model)) return ['low', 'medium', 'high'];
    if (model.toLowerCase() === 'qwen/qwen3.8-27b') return ['none', 'low', 'medium', 'high'];
  }
  if ((host === 'api.x.ai' || host.endsWith('.api.x.ai')) && /^grok-4\.[67]$/i.test(model)) return ['low', 'medium', 'high', 'xhigh'];
  // The coding subscription and direct API have always-thinking K3 variants;
  // use the shared subset instead of sending unsupported none to workers.
  if ((host === 'api.moonshot.ai' && /^kimi-k3(?:\.1-pro)?$/i.test(model))
    || ((host === 'api.kimi.com' || host === 'api.kimi.ai') && /^k3(?:\.1-pro)?$/i.test(model))) return ['low', 'high', 'max'];
  return undefined;
}

/** One shared profile for the UI, main request, and auxiliary calls. */
export function reasoningLevelsForProvider(provider: HazeProviderSettings, model: string): readonly ReasoningLevel[] {
  if (provider.capabilities?.reasoningEffort === false) return [];
  const override = provider.modelReasoningLevels?.[model] ?? provider.reasoningLevels;
  if (override) return provider.reasoningFormat === 'thinking' || provider.reasoningFormat === 'enable-thinking' ? override.filter(level => level === 'none' || level === 'high') : override;
  if (provider.reasoningFormat === 'thinking' || provider.reasoningFormat === 'enable-thinking') return ['none', 'high'];
  const documented = providerReasoningLevels(provider.kind === 'chatgpt-codex' ? 'https://api.openai.com' : provider.url, model);
  if (documented) return documented;
  if (provider.kind === 'haze-build') return ['none', 'high'];
  if (provider.capabilities?.reasoningEffort === true) return REASONING_LEVELS;
  // Official OpenAI and OpenRouter protocols support portable effort settings.
  // A model-specific profile above narrows the choices when documented.
  try {
    const host = new URL(provider.url).hostname.toLowerCase();
    if (host === 'openrouter.ai') return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
    if (host === 'api.openai.com' || provider.kind === 'chatgpt-codex') return REASONING_LEVELS;
  } catch { /* Invalid URLs are rejected when creating the runtime. */ }
  return [];
}
