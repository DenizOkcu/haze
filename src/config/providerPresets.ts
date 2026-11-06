// Curated provider presets, verified against provider catalogs on 2026-11-06.

/**
 * Known OpenAI-compatible provider presets derived from provider documentation and
 * community conventions. Do not copy native-provider entries from multi-adapter clients:
 * every standard preset here must accept OpenAI Chat Completions requests at its base URL.
 * The OpenAI Subscription preset is the explicit exception and uses its own Codex adapter.
 * Hosted presets carry a pre-configured base URL so users only need to supply an API key
 * and model names. Local/keyless providers have sensible localhost defaults.
 *
 * Presets are authored in a compact definition form (`ProviderPresetDefinition`) and
 * expanded once into the public `ProviderPreset` records: each curated model is a single
 * `[id, contextWindowTokens, maxOutputTokens]` tuple instead of appearing twice (once in
 * `suggestedModels`, once in `modelLimits`), and `needsApiKey` is derived from the
 * category (cloud presets need a key unless they carry an explicit OAuth flow; local
 * ones never do).
 *
 * `modelLimits` values are curated from provider catalogs and models.dev. They are keyed by the exact suggested model id for
 * THIS preset: aggregators may cap context below the origin model's capability (e.g.
 * Together serves DeepSeek-V4-Pro at 512K vs DeepSeek's own 1M), so limits never
 * transfer between providers. When the wizard adds a suggested model, these values are
 * written into the provider's settings `modelLimits`, where they remain user-editable.
 * Local providers (Ollama/llama.cpp/MLX/LM Studio) intentionally carry no limits: their
 * effective context depends on the local server configuration, not the model.
 */

export interface PresetModelLimits {
  contextWindowTokens: number;
  maxOutputTokens: number;
}

export interface ProviderPreset {
  kind?: 'haze-build';
  requiresEndpoint?: boolean;
  /** Unique identifier used as the selection value. */
  id: string;
  /** Human-readable name shown in the picker. */
  name: string;
  /** Pre-configured OpenAI-compatible base URL. */
  baseUrl: string;
  /** Whether an API key is typically required. Local and OAuth providers use false. */
  needsApiKey: boolean;
  /** Provider-specific sign-in flow, when setup is not an API-key prompt. */
  auth?: 'chatgpt-oauth' | 'mistral-vibe';
  /** Hint shown when prompting for the API key. */
  apiKeyHint?: string;
  /**
   * Conventional environment variable holding this provider's API key (from Pi's
   * auth registry). Informational only — haze never reads provider env vars itself.
   */
  apiKeyEnvVar?: string;
  /**
   * Curated model ids. Pinned atop the live /models discovery picker when the
   * endpoint actually serves them (stale entries simply don't pin), and shown
   * as type-in examples when discovery fails.
   */
  suggestedModels?: string[];
  /**
   * Context-window and output-token limits keyed by exact suggested model id
   * (provider-specific; see the module comment). Feeds request budgeting when a
   * user adds the model without configuring limits themselves.
   */
  modelLimits?: Record<string, PresetModelLimits>;
  /** Category for grouping in the picker. */
  category: 'cloud' | 'local';
}

/**
 * A curated model in authoring form: a bare id, or a
 * `[id, contextWindowTokens, maxOutputTokens]` tuple when models.dev limits are
 * known for this preset's serving of the model.
 */
type PresetModelSpec = string | readonly [model: string, contextWindowTokens: number, maxOutputTokens: number];

/** Compact authoring form shared by every preset (see the module comment). */
interface ProviderPresetDefinition {
  kind?: 'haze-build';
  requiresEndpoint?: boolean;
  id: string;
  name: string;
  baseUrl: string;
  /** Provider-specific sign-in flow; a cloud preset with a flow skips the API-key prompt. */
  auth?: 'chatgpt-oauth' | 'mistral-vibe';
  apiKeyHint?: string;
  apiKeyEnvVar?: string;
  models?: readonly PresetModelSpec[];
  category: 'cloud' | 'local';
}

const PRESET_DEFINITIONS: readonly ProviderPresetDefinition[] = [
  {id: 'haze.build', name: 'haze.build', kind: 'haze-build', baseUrl: 'https://llm.haze.build/v1', category: 'cloud', models: ['haze1.5-builder-flash'], apiKeyHint: 'your deployed haze.build inference key'},
  {id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnvVar: 'OPENROUTER_API_KEY', category: 'cloud', models: [
    ['anthropic/claude-opus-5.5', 1_000_000, 128_000], ['anthropic/claude-sonnet-5.5', 1_000_000, 128_000],
    ['openai/gpt-6.1-sol', 922_000, 128_000], ['openai/gpt-6-luna', 922_000, 128_000],
    ['google/gemini-4-argon', 1_048_576, 32_768], ['google/gemini-3.8-flash', 1_048_576, 65_536],
    ['mistralai/mistral-large-4-0', 1_048_576, 262_144], ['deepseek/deepseek-v4.1-flash', 1_048_576, 393_216],
    ['moonshotai/kimi-k3.1-pro', 1_048_576, 131_072], ['z-ai/glm-5.3', 1_000_000, 131_072],
    ['qwen/qwen3.8-2.4t-a95b', 1_048_576, 131_072], ['minimax/minimax-m3.1-flash', 1_048_576, 524_288],
    ['x-ai/grok-4.7', 500_000, 450_000],
  ]},
  {id: 'openai-api-key', name: 'OpenAI API Key', baseUrl: 'https://api.openai.com/v1', apiKeyEnvVar: 'OPENAI_API_KEY', category: 'cloud', models: [
    ['gpt-6.1-sol', 922_000, 128_000], ['gpt-6-astra', 922_000, 128_000], ['gpt-6-luna', 922_000, 128_000],
  ]},
  {id: 'openai-subscription', name: 'OpenAI Subscription', baseUrl: 'https://chatgpt.com/backend-api/codex', auth: 'chatgpt-oauth', category: 'cloud', models: [
    ['gpt-6.1-sol', 500_000, 128_000], ['gpt-6.1-terra', 500_000, 128_000], ['gpt-6-luna', 272_000, 128_000],
    ['gpt-5.6-sol', 272_000, 128_000], ['gpt-5.6-terra', 272_000, 128_000], ['gpt-5.6-luna', 272_000, 128_000],
  ]},
  {id: 'google-gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyHint: 'API Key (from https://aistudio.google.com/apikey)', apiKeyEnvVar: 'GEMINI_API_KEY', category: 'cloud', models: [
    ['gemini-4-argon', 1_048_576, 32_768], ['gemini-3.8-flash', 1_048_576, 65_536],
  ]},
  {id: 'mistral-api', name: 'Mistral AI (API Key)', baseUrl: 'https://api.mistral.ai/v1', apiKeyHint: 'API Key (from https://console.mistral.ai)', apiKeyEnvVar: 'MISTRAL_API_KEY', category: 'cloud', models: [
    ['mistral-large-4', 1_048_576, 262_144], 'mistral-small-latest', 'codestral-latest',
  ]},
  {id: 'mistral-vibe', name: 'Mistral Vibe Subscription', baseUrl: 'https://api.mistral.ai/v1', auth: 'mistral-vibe', category: 'cloud', models: ['mistral-vibe-cli-latest', 'mistral-large-4']},
  {id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnvVar: 'DEEPSEEK_API_KEY', category: 'cloud', models: [
    ['deepseek-v4-pro', 1_048_576, 393_216], ['deepseek-flash', 1_048_576, 393_216],
  ]},
  {id: 'xai', name: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', apiKeyEnvVar: 'XAI_API_KEY', category: 'cloud', models: [
    ['grok-4.7', 500_000, 500_000], ['grok-4.6', 500_000, 500_000],
  ]},
  {id: 'z-ai-api', name: 'Z.ai (General API)', baseUrl: 'https://api.z.ai/api/paas/v4/', apiKeyEnvVar: 'ZAI_API_KEY', category: 'cloud', models: [
    ['glm-5.3', 1_000_000, 131_072], ['glm-5.3-flash', 1_000_000, 131_072],
  ]},
  {id: 'z-ai-coding', name: 'Z.ai (Coding Plan)', baseUrl: 'https://api.z.ai/api/coding/paas/v4/', apiKeyEnvVar: 'ZAI_API_KEY', category: 'cloud', models: [
    ['glm-5.3', 1_000_000, 131_072], ['glm-5.2-highspeed', 1_000_000, 131_072],
  ]},
  {id: 'moonshot', name: 'Moonshot AI (Kimi API)', baseUrl: 'https://api.moonshot.ai/v1', apiKeyEnvVar: 'MOONSHOT_API_KEY', category: 'cloud', models: [
    ['kimi-k3.1-pro', 1_048_576, 131_072], ['kimi-k3', 1_048_576, 131_072],
  ]},
  {id: 'kimi-code', name: 'Kimi Code', baseUrl: 'https://api.kimi.com/coding/v1', apiKeyEnvVar: 'KIMI_API_KEY', category: 'cloud', models: [
    ['k3', 1_048_576, 131_072], ['k3.1-pro', 1_048_576, 131_072], 'kimi-for-coding',
  ]},
  {id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnvVar: 'GROQ_API_KEY', category: 'cloud', models: [
    ['openai/gpt-oss-120b', 131_072, 65_536], ['qwen/qwen3.8-27b', 131_072, 16_384],
  ]},
  {id: 'together', name: 'Together AI', baseUrl: 'https://api.together.ai/v1', apiKeyEnvVar: 'TOGETHER_API_KEY', category: 'cloud', models: [
    ['deepseek-ai/DeepSeek-V4-Pro-0813', 1_048_576, 384_000], ['moonshotai/Kimi-K3.1-Pro', 1_048_576, 131_072],
  ]},
  {id: 'ollama', name: 'Ollama (Local Server)', baseUrl: 'http://localhost:11434/v1', category: 'local'},
  {id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', category: 'local'},
  {id: 'llamacpp', name: 'llama.cpp server', baseUrl: 'http://localhost:8080/v1', category: 'local'},
  {id: 'mlx-server', name: 'MLX Server', baseUrl: 'http://localhost:8080/v1', category: 'local'},
  {id: 'vllm', name: 'vLLM', baseUrl: 'http://localhost:8000/v1', category: 'local'},
];

// Alias mappings for backward compatibility
const PRESET_ALIASES: Record<string, string> = {
  mistral: 'mistral-api', // Legacy → new API preset
  'z-ai': 'z-ai-api',     // Legacy → new general API preset
  openai: 'openai-api-key', // Legacy → new API preset
  'chatgpt-codex': 'openai-subscription', // Legacy → subscription preset
  'llama-cpp': 'llamacpp',
  'lm-studio': 'lmstudio',
};

function expandPreset(definition: ProviderPresetDefinition): ProviderPreset {
  const suggestedModels: string[] = [];
  const modelLimits: Record<string, PresetModelLimits> = {};

  for (const model of definition.models || []) {
    if (typeof model === 'string') {
      suggestedModels.push(model);
    } else {
      const [id, contextWindowTokens, maxOutputTokens] = model;
      suggestedModels.push(id);
      modelLimits[id] = { contextWindowTokens, maxOutputTokens };
    }
  }

  return {
    id: definition.id,
    name: definition.name,
    baseUrl: definition.baseUrl,
    category: definition.category,
    ...(definition.kind ? {kind: definition.kind} : {}),
    ...(definition.requiresEndpoint ? {requiresEndpoint: true} : {}),
    ...(definition.auth ? {auth: definition.auth} : {}),
    ...(definition.apiKeyHint ? {apiKeyHint: definition.apiKeyHint} : {}),
    ...(definition.apiKeyEnvVar ? {apiKeyEnvVar: definition.apiKeyEnvVar} : {}),
    suggestedModels: suggestedModels.length > 0 ? suggestedModels : undefined,
    modelLimits: Object.keys(modelLimits).length > 0 ? modelLimits : undefined,
    needsApiKey: definition.category === 'cloud' && !definition.auth,
  };
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = PRESET_DEFINITIONS.map(expandPreset);

// Backward-compatible lookup function
export function findPreset(id: string): ProviderPreset | undefined {
  const resolvedId = PRESET_ALIASES[id] || id;
  return PROVIDER_PRESETS.find(preset => preset.id === resolvedId);
}

/** Only copy limits for selected models and an unambiguous provider endpoint. */
export function presetModelLimitsForModels(provider: {name?: string; url?: string}, models: readonly string[]): Record<string, PresetModelLimits> {
  const normalize = (url: string) => url.replace(/\/+$/, '').toLowerCase();
  const named = PROVIDER_PRESETS.find(p => provider.name && (p.name.toLowerCase() === provider.name.toLowerCase() || p.id === provider.name));
  const url = provider.url;
  const matches = url ? PROVIDER_PRESETS.filter(p => normalize(p.baseUrl) === normalize(url)) : [];
  const candidates = named && (!provider.url || matches.includes(named)) ? [named] : matches.length === 1 ? matches : [];
  const out: Record<string, PresetModelLimits> = {};
  for (const model of models) {
    const limits = candidates[0]?.modelLimits?.[model];
    if (limits) out[model] = limits;
  }
  return out;
}
