import type {ReasoningLevel} from '../core/agent/reasoningPolicy.js';

/** Curated endpoint/model facts. Unknown entries remain unknown, not inferred. */
export interface EndpointModelFacts {
  limits?: {contextWindowTokens: number; maxOutputTokens: number};
  reasoningLevels?: readonly ReasoningLevel[];
}

const ENDPOINT_MODEL_LIMITS: Record<string, Record<string, readonly [number, number]>> = {
  'https://openrouter.ai/api/v1': {
    'anthropic/claude-opus-5.5': [1_000_000, 128_000],
    'anthropic/claude-sonnet-5.5': [1_000_000, 128_000],
    'openai/gpt-6.1-sol': [922_000, 128_000],
    'openai/gpt-6-luna': [922_000, 128_000],
    'google/gemini-4-argon': [1_048_576, 32_768],
    'google/gemini-3.8-flash': [1_048_576, 65_536],
    'mistralai/mistral-large-4-0': [1_048_576, 262_144],
    'deepseek/deepseek-v4.1-flash': [1_048_576, 393_216],
    'moonshotai/kimi-k3.1-pro': [1_048_576, 131_072],
    'z-ai/glm-5.3': [1_000_000, 131_072],
    'qwen/qwen3.8-2.4t-a95b': [1_048_576, 131_072],
    'minimax/minimax-m3.1-flash': [1_048_576, 524_288],
    'x-ai/grok-4.7': [500_000, 450_000],
  },
  'https://api.openai.com/v1': {
    'gpt-6.1-sol': [922_000, 128_000],
    'gpt-6-astra': [922_000, 128_000],
    'gpt-6-luna': [922_000, 128_000],
  },
  'https://chatgpt.com/backend-api/codex': {
    'gpt-6.1-sol': [500_000, 128_000],
    'gpt-6.1-terra': [500_000, 128_000],
    'gpt-6-luna': [272_000, 128_000],
    'gpt-5.6-sol': [272_000, 128_000],
    'gpt-5.6-terra': [272_000, 128_000],
    'gpt-5.6-luna': [272_000, 128_000],
  },
  'https://generativelanguage.googleapis.com/v1beta/openai': {
    'gemini-4-argon': [1_048_576, 32_768],
    'gemini-3.8-flash': [1_048_576, 65_536],
  },
  'https://api.mistral.ai/v1': {
    'mistral-large-4': [1_048_576, 262_144],
  },
  'https://api.deepseek.com/v1': {
    'deepseek-v4-pro': [1_048_576, 393_216],
    'deepseek-flash': [1_048_576, 393_216],
  },
  'https://api.x.ai/v1': {
    'grok-4.7': [500_000, 500_000],
    'grok-4.6': [500_000, 500_000],
  },
  'https://api.z.ai/api/paas/v4': {
    'glm-5.3': [1_000_000, 131_072],
    'glm-5.3-flash': [1_000_000, 131_072],
  },
  'https://api.z.ai/api/coding/paas/v4': {
    'glm-5.3': [1_000_000, 131_072],
    'glm-5.2-highspeed': [1_000_000, 131_072],
  },
  'https://api.moonshot.ai/v1': {
    'kimi-k3.1-pro': [1_048_576, 131_072],
    'kimi-k3': [1_048_576, 131_072],
  },
  'https://api.kimi.com/coding/v1': {
    'k3': [1_048_576, 131_072],
    'k3.1-pro': [1_048_576, 131_072],
  },
  'https://api.groq.com/openai/v1': {
    'openai/gpt-oss-120b': [131_072, 65_536],
    'qwen/qwen3.8-27b': [131_072, 16_384],
  },
  'https://api.together.ai/v1': {
    'deepseek-ai/DeepSeek-V4-Pro-0813': [1_048_576, 384_000],
    'moonshotai/Kimi-K3.1-Pro': [1_048_576, 131_072],
  },
};

function documentedReasoningLevels(url: string, model: string): readonly ReasoningLevel[] | undefined {
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
    if (/^gpt-4(?:o|\.1)(?:-|$)/i.test(model)) return [];
    if (/^gpt-5\.(?:2|4)(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?$/i.test(model)) return ['none', 'low', 'medium', 'high', 'xhigh'];
    if (/^gpt-5\.6(?:-(?:sol|terra|luna))?$/i.test(model)) return ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
    if (/^gpt-5\.5$/i.test(model)) return ['none', 'low', 'medium', 'high', 'xhigh'];
    if (/^gpt-6(?:\.1)?-(?:astra|sol|terra|luna)$/i.test(model)) {
      return /^gpt-6(?:-sol|-luna|\.1-terra)$/i.test(model) ? ['none', 'low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high', 'xhigh', 'max'];
    }
  }
  if (host === 'generativelanguage.googleapis.com') {
    if (/^gemini-3\.(?:7|8)-flash(?:-|$)/i.test(model)) return ['low', 'medium', 'high'];
    if (/^gemini-3-pro(?:-|$)/i.test(model)) return ['low', 'high'];
    if (/^gemini-3\.1-pro(?:-|$)/i.test(model)) return ['low', 'medium', 'high'];
    if (/^gemini-3(?:\.1)?-(?:pro|flash)(?:-lite)?(?:-|$)/i.test(model)) return ['minimal', 'low', 'medium', 'high'];
    if (/^gemini-2\.5-pro(?:-|$)/i.test(model)) return ['low', 'medium', 'high'];
    if (/^gemini-2\.5-flash(?:-lite)?(?:-|$)/i.test(model)) return ['none', 'low', 'medium', 'high'];
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


/** Lookup uses the actual endpoint and exact model ID; documented aliases are handled by the reasoning profiles. */
export function endpointModelFacts(url: string, model: string): EndpointModelFacts {
  const endpoint = url.replace(/\/+$/, '').toLowerCase();
  const entries = ENDPOINT_MODEL_LIMITS[endpoint];
  const key = model.toLowerCase();
  const values = entries && Object.entries(entries).find(([id]) => id.toLowerCase() === key)?.[1];
  const limits = values ? {contextWindowTokens: values[0], maxOutputTokens: values[1]} : undefined;
  const reasoningLevels = documentedReasoningLevels(url, model);
  return {...(limits ? {limits} : {}), ...(reasoningLevels !== undefined ? {reasoningLevels} : {})};
}

/**
 * Curated model metadata catalog (Pillar 1.8 of the Pi learning roadmap).
 *
 * Keys are **model-name patterns** (not provider names) because haze reaches
 * most models through user-configured OpenAI-compatible gateways where the
 * provider name is arbitrary — the model id is the only stable identity.
 *
 * Precedence (enforced in `llm/client.ts`): explicit model limits → discovered
 * limits → provider preset → this catalog → user fallback → built-in fallback.
 * Values are deliberately conservative (input-safe): when a family differs
 * between variants, the smaller window wins — under-budgeting only compacts a
 * little earlier, over-budgeting hard-fails the request. First match wins, so
 * keep more specific patterns before broader family prefixes.
 *
 * Refreshed 2026-10-04 against https://models.dev/api.json. Provider-specific
 * caps belong in provider presets/settings, not these conservative family entries.
 *
 * Local inference servers (localhost URLs) never consult the catalog: their
 * effective window is set by server configuration (often far below the model's
 * nominal window) and silent truncation there is undetectable.
 */

export interface CatalogModelLimits {
  contextWindowTokens: number;
  maxOutputTokens?: number;
}

interface CatalogEntry extends CatalogModelLimits {
  /** Lower-cased model-name pattern; matched with `startsWith` unless it contains '*', then prefix-before-'*' match. */
  match: string;
  note?: string;
}

const MODEL_CATALOG: readonly CatalogEntry[] = [
  // ── OpenAI ────────────────────────────────────────────────────────────────
  {match: 'gpt-6.1-sol', contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
  {match: 'gpt-6-astra', contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
  {match: 'gpt-6-sol', contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
  {match: 'gpt-6-luna', contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
  {match: 'gpt-5.6', contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
  {match: 'gpt-5.5', contextWindowTokens: 400_000, maxOutputTokens: 128_000, note: 'Poe caps this family at 400K; origin limits belong in presets'},
  {match: 'gpt-5.4-mini', contextWindowTokens: 400_000, maxOutputTokens: 128_000},
  {match: 'gpt-5.4-nano', contextWindowTokens: 400_000, maxOutputTokens: 128_000},
  {match: 'gpt-5.4', contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
  {match: 'gpt-5.3-codex-spark', contextWindowTokens: 128_000, maxOutputTokens: 32_000},
  {match: 'gpt-5.1-codex', contextWindowTokens: 400_000, maxOutputTokens: 128_000},
  {match: 'gpt-5.1-codex-mini', contextWindowTokens: 400_000, maxOutputTokens: 128_000},
  {match: 'gpt-5', contextWindowTokens: 400_000, maxOutputTokens: 128_000},
  {match: 'gpt-4.1', contextWindowTokens: 1_047_576, maxOutputTokens: 32_768},
  {match: 'gpt-4o', contextWindowTokens: 128_000, maxOutputTokens: 16_384},
  {match: 'o4', contextWindowTokens: 200_000, maxOutputTokens: 100_000},
  {match: 'o3', contextWindowTokens: 200_000, maxOutputTokens: 100_000},
  {match: 'o1', contextWindowTokens: 200_000, maxOutputTokens: 100_000},
  // ── Anthropic ─────────────────────────────────────────────────────────────
  {match: 'claude-opus-5', contextWindowTokens: 1_000_000, maxOutputTokens: 128_000},
  {match: 'claude-sonnet-5', contextWindowTokens: 1_000_000, maxOutputTokens: 128_000},
  {match: 'claude-fable-5', contextWindowTokens: 1_000_000, maxOutputTokens: 128_000},
  {match: 'claude-opus-4', contextWindowTokens: 200_000, maxOutputTokens: 32_000},
  {match: 'claude-sonnet-4', contextWindowTokens: 200_000, maxOutputTokens: 64_000},
  {match: 'claude-haiku-4', contextWindowTokens: 200_000, maxOutputTokens: 32_000},
  {match: 'claude-3-7', contextWindowTokens: 200_000, maxOutputTokens: 64_000},
  {match: 'claude-3-5', contextWindowTokens: 200_000, maxOutputTokens: 8_192},
  // ── Google ────────────────────────────────────────────────────────────────
  {match: 'gemini-3', contextWindowTokens: 1_048_576, maxOutputTokens: 65_536},
  {match: 'gemini-2.5', contextWindowTokens: 1_048_576, maxOutputTokens: 65_536},
  {match: 'gemini-2.0', contextWindowTokens: 1_048_576, maxOutputTokens: 8_192},
  // ── xAI ───────────────────────────────────────────────────────────────────
  {match: 'grok-4.7', contextWindowTokens: 500_000, maxOutputTokens: 450_000, note: 'smaller OpenRouter output cap'},
  {match: 'grok-4.6', contextWindowTokens: 500_000, maxOutputTokens: 500_000},
  {match: 'grok-4.5', contextWindowTokens: 500_000, maxOutputTokens: 500_000},
  {match: 'grok-4', contextWindowTokens: 256_000, maxOutputTokens: 32_768},
  {match: 'grok-3', contextWindowTokens: 131_072, maxOutputTokens: 32_768},
  // ── DeepSeek ──────────────────────────────────────────────────────────────
  {match: 'deepseek-v4.1', contextWindowTokens: 1_000_000, maxOutputTokens: 384_000, note: 'smaller gateway window and output cap'},
  {match: 'deepseek-v4', contextWindowTokens: 512_000, maxOutputTokens: 384_000, note: 'Together caps V4 Pro at 512K'},
  {match: 'deepseek-flash', contextWindowTokens: 1_000_000, maxOutputTokens: 393_216},
  {match: 'deepseek-reasoner', contextWindowTokens: 128_000, maxOutputTokens: 32_768, note: 'R1/reasoner family'},
  {match: 'deepseek-r1', contextWindowTokens: 128_000, maxOutputTokens: 32_768},
  {match: 'deepseek', contextWindowTokens: 128_000, maxOutputTokens: 8_192},
  // ── Alibaba / Moonshot / Zhipu / MiniMax ─────────────────────────────────
  {match: 'qwen3.8-max', contextWindowTokens: 262_144, maxOutputTokens: 131_072, note: 'smaller OpenCode window'},
  {match: 'qwen3-coder', contextWindowTokens: 262_144, maxOutputTokens: 32_768},
  {match: 'qwen3', contextWindowTokens: 131_072, maxOutputTokens: 32_768, note: 'native window without YaRN extension'},
  {match: 'qwen', contextWindowTokens: 131_072, maxOutputTokens: 8_192},
  {match: 'kimi-k3', contextWindowTokens: 1_048_576, maxOutputTokens: 131_072, note: 'smaller gateway output cap'},
  {match: 'kimi-k2', contextWindowTokens: 131_072, maxOutputTokens: 32_768, note: 'input-safe half of the 256K total'},
  {match: 'glm-5.3', contextWindowTokens: 1_000_000, maxOutputTokens: 131_072},
  {match: 'glm-5.2', contextWindowTokens: 262_144, maxOutputTokens: 131_072, note: 'smaller Hugging Face window'},
  {match: 'glm-5.1', contextWindowTokens: 200_000, maxOutputTokens: 131_072},
  {match: 'glm-5-turbo', contextWindowTokens: 200_000, maxOutputTokens: 131_072},
  {match: 'glm-4.7', contextWindowTokens: 200_000, maxOutputTokens: 131_072},
  {match: 'glm-4.6', contextWindowTokens: 200_000, maxOutputTokens: 32_768},
  {match: 'glm-4.5', contextWindowTokens: 131_072, maxOutputTokens: 32_768},
  {match: 'minimax-m2', contextWindowTokens: 204_800, maxOutputTokens: 1_048_576, note: 'output budget exceeds window in interleave mode'},
  // ── Meta / Mistral ───────────────────────────────────────────────────────
  {match: 'llama-4-maverick', contextWindowTokens: 1_048_576, maxOutputTokens: 32_768},
  {match: 'llama-4-scout', contextWindowTokens: 1_048_576, maxOutputTokens: 32_768, note: 'gateway-served window; self-host is server-configured'},
  {match: 'llama-3.3', contextWindowTokens: 128_000, maxOutputTokens: 8_192},
  {match: 'llama-3.1', contextWindowTokens: 128_000, maxOutputTokens: 8_192},
  {match: 'mistral-large', contextWindowTokens: 128_000, maxOutputTokens: 32_768},
  {match: 'mistral-medium', contextWindowTokens: 128_000, maxOutputTokens: 32_768},
  {match: 'devstral', contextWindowTokens: 128_000, maxOutputTokens: 32_768},
  {match: 'codestral', contextWindowTokens: 256_000, maxOutputTokens: 32_768},
  {match: 'mistral', contextWindowTokens: 128_000, maxOutputTokens: 8_192},
];

/** Look up catalog limits for a model name (case-insensitive prefix families). Gateway-style `vendor/model` and `vendor:model` identifiers match on their final segment. */
export function catalogLimitsFor(modelName: string): CatalogModelLimits | undefined {
  const name = modelName.trim().toLowerCase();
  if (!name) return undefined;
  for (const entry of MODEL_CATALOG) {
    if (name.startsWith(entry.match) || lastSegment(name).startsWith(entry.match)) {
      return {contextWindowTokens: entry.contextWindowTokens, ...(entry.maxOutputTokens !== undefined ? {maxOutputTokens: entry.maxOutputTokens} : {})};
    }
  }
  return undefined;
}

function lastSegment(name: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf(':'));
  return slash === -1 ? name : name.slice(slash + 1);
}

/** Catalog entries exposed for pinning tests (like the theme registry). */
export function getModelCatalog(): readonly CatalogEntry[] {
  return MODEL_CATALOG;
}
