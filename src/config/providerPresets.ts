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
 * `modelLimits` values are curated from models.dev (the same catalog pi and nanocoder
 * consume; refreshed 2026-08-15). They are keyed by the exact suggested model id for
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
  /** Unique identifier used as the selection value. */
  id: string;
  /** Human-readable name shown in the picker. */
  name: string;
  /** Pre-configured OpenAI-compatible base URL. */
  baseUrl: string;
  /** Whether an API key is typically required. Local and OAuth providers use false. */
  needsApiKey: boolean;
  /** Provider-specific sign-in flow, when setup is not an API-key prompt. */
  auth?: 'chatgpt-oauth';
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
  id: string;
  name: string;
  baseUrl: string;
  /** Provider-specific sign-in flow; a cloud preset with a flow skips the API-key prompt. */
  auth?: 'chatgpt-oauth';
  apiKeyHint?: string;
  apiKeyEnvVar?: string;
  models?: readonly PresetModelSpec[];
  category: 'cloud' | 'local';
}

const PRESET_DEFINITIONS: readonly ProviderPresetDefinition[] = [
  // ── Cloud providers (API key required) ──────────────────────────────
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    models: [
      // SOTA
      ['anthropic/claude-opus-5', 1_048_576, 128_000],
      ['openai/gpt-5.6', 1_050_000, 128_000],
      ['google/gemini-3.7-flash', 1_048_576, 65_536],
      ['anthropic/claude-sonnet-5', 1_000_000, 128_000],
      ['qwen/qwen3.8-2.4t-a95b', 1_048_576, 262_144],
      // Fast
      ['x-ai/grok-4.6', 500_000, 500_000],
      ['openai/gpt-5.4-mini', 400_000, 128_000],
      ['google/gemini-3.5-flash', 1_048_576, 65_536],
      ['deepseek/deepseek-v4-flash', 1_048_576, 384_000],
    ],
    category: 'cloud',
  },
  {
    id: 'openai-api-key',
    name: 'OpenAI API Key',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    models: [
      // SOTA
      ['gpt-5.6', 1_050_000, 128_000],
      ['gpt-5.6-sol', 1_050_000, 128_000],
      ['gpt-5.6-terra', 1_050_000, 128_000],
      ['gpt-5.5-pro', 1_050_000, 128_000],
      ['o3', 200_000, 100_000],
      // Fast
      ['gpt-5.6-luna', 1_050_000, 128_000],
      ['gpt-5.5', 1_050_000, 128_000],
      ['gpt-5.4', 1_050_000, 128_000],
      ['gpt-5.4-mini', 400_000, 128_000],
    ],
    category: 'cloud',
  },
  {
    id: 'google-gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyHint: 'API Key (from https://aistudio.google.com/apikey)',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    models: [
      // SOTA
      ['gemini-3.1-pro-preview', 1_048_576, 65_536],
      ['gemini-3.7-flash', 1_048_576, 65_536],
      // Fast
      ['gemini-3.6-flash', 1_048_576, 65_536],
      ['gemini-3.5-flash', 1_048_576, 65_536],
      ['gemini-3.5-flash-lite', 1_048_576, 65_536],
      ['gemini-3.1-flash-lite', 1_048_576, 65_536],
      ['gemini-2.5-pro', 1_048_576, 65_536],
    ],
    category: 'cloud',
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnvVar: 'MISTRAL_API_KEY',
    models: [
      // SOTA
      ['mistral-large-2512', 262_144, 262_144],
      ['mistral-medium-2604', 262_144, 262_144],
      // Fast
      ['mistral-small-2603', 256_000, 256_000],
      ['codestral-latest', 256_000, 4_096],
    ],
    category: 'cloud',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    models: [
      // SOTA
      ['deepseek-v4-pro', 1_000_000, 384_000],
      // Fast
      ['deepseek-v4-flash', 1_000_000, 384_000],
    ],
    category: 'cloud',
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnvVar: 'XAI_API_KEY',
    models: [
      // SOTA
      ['grok-4.6', 500_000, 500_000],
      ['grok-4.5', 500_000, 500_000],
      ['grok-4.3', 1_000_000, 30_000],
      // Fast
      ['grok-build-0.1', 256_000, 256_000],
    ],
    category: 'cloud',
  },
  {
    id: 'z-ai',
    name: 'Z.ai',
    baseUrl: 'https://api.z.ai/api/paas/v4/',
    apiKeyEnvVar: 'ZAI_API_KEY',
    models: [
      ['glm-5.2', 1_000_000, 131_072],
      ['glm-5.1', 200_000, 131_072],
      ['glm-5-turbo', 200_000, 131_072],
      ['glm-4.7', 204_800, 131_072],
    ],
    category: 'cloud',
  },
  {
    id: 'z-ai-coding',
    name: 'Z.ai Coding Subscription',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4/',
    apiKeyEnvVar: 'ZAI_API_KEY',
    models: [
      ['glm-5.3', 1_000_000, 131_072],
      ['glm-5.2', 1_000_000, 131_072],
      ['glm-5.2-highspeed', 1_000_000, 131_072],
      ['glm-5-turbo', 200_000, 131_072],
    ],
    category: 'cloud',
  },
  {
    id: 'kimi-code',
    name: 'Kimi Code',
    baseUrl: 'https://api.kimi.com/coding/v1',
    apiKeyEnvVar: 'KIMI_API_KEY',
    models: [
      ['k3', 1_048_576, 131_072],
      ['k3-256k', 262_144, 131_072],
      ['kimi-for-coding', 262_144, 32_768],
      ['kimi-for-coding-highspeed', 262_144, 32_768],
    ],
    category: 'cloud',
  },
  {
    id: 'moonshot',
    name: 'Moonshot AI (Kimi API)',
    baseUrl: 'https://api.moonshot.ai/v1',
    apiKeyEnvVar: 'MOONSHOT_API_KEY',
    models: [
      // SOTA
      ['kimi-k3', 1_048_576, 131_072],
      ['kimi-k2.7-code', 262_144, 262_144],
      // Fast
      ['kimi-k2.6', 262_144, 262_144],
      ['kimi-k2.5', 262_144, 262_144],
    ],
    category: 'cloud',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnvVar: 'GROQ_API_KEY',
    models: [
      ['openai/gpt-oss-120b', 131_072, 65_536],
      ['qwen/qwen3.6-27b', 131_072, 16_384],
      ['llama-3.3-70b-versatile', 131_072, 32_768],
    ],
    category: 'cloud',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnvVar: 'CEREBRAS_API_KEY',
    models: [
      ['gpt-oss-120b', 131_072, 40_960],
      ['zai-glm-4.7', 131_072, 40_960],
    ],
    category: 'cloud',
  },
  {
    // Router-specific caps: Together serves some models below the origin's window.
    id: 'together',
    name: 'Together AI',
    baseUrl: 'https://api.together.ai/v1',
    apiKeyEnvVar: 'TOGETHER_API_KEY',
    models: [
      // SOTA
      ['moonshotai/Kimi-K3', 1_048_576, 131_072],
      ['deepseek-ai/DeepSeek-V4-Pro', 512_000, 384_000],
      ['Qwen/Qwen3.7-Max', 1_000_000, 500_000],
      // Fast
      ['moonshotai/Kimi-K2.7-Code', 262_144, 131_072],
      ['zai-org/GLM-5.2', 512_000, 164_000],
      ['MiniMaxAI/MiniMax-M3', 524_288, 250_000],
    ],
    category: 'cloud',
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    apiKeyEnvVar: 'FIREWORKS_API_KEY',
    models: [
      // SOTA
      ['accounts/fireworks/models/kimi-k3', 1_048_576, 131_072],
      ['accounts/fireworks/models/glm-5p2', 1_048_575, 131_072],
      // Fast
      ['accounts/fireworks/routers/kimi-k3-fast', 1_048_576, 131_072],
      ['accounts/fireworks/models/minimax-m3', 512_000, 512_000],
      ['accounts/fireworks/models/deepseek-v4-flash', 1_000_000, 384_000],
      ['accounts/fireworks/models/deepseek-v4-pro-0813', 1_000_000, 384_000],
    ],
    category: 'cloud',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face Router',
    baseUrl: 'https://router.huggingface.co/v1',
    apiKeyHint: 'Hugging Face token (from https://huggingface.co/settings/tokens)',
    apiKeyEnvVar: 'HF_TOKEN',
    models: [
      // SOTA
      ['moonshotai/Kimi-K3', 1_048_576, 131_072],
      ['zai-org/GLM-5.2', 262_144, 131_072],
      ['thinkingmachines/Inkling', 1_048_576, 1_048_576],
      // Fast
      ['deepseek-ai/DeepSeek-V4-Flash', 1_048_576, 384_000],
      ['Qwen/Qwen3-Coder-Next', 262_144, 65_536],
    ],
    category: 'cloud',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKeyEnvVar: 'NVIDIA_API_KEY',
    models: [
      ['nvidia/nemotron-3-ultra-550b-a55b', 1_000_000, 65_536],
      ['nvidia/nemotron-3.5-lightning-30b-a3b', 262_144, 262_144],
      ['nvidia/nemotron-3-super-120b-a12b', 262_144, 262_144],
      ['minimaxai/minimax-m3', 1_000_000, 16_384],
    ],
    category: 'cloud',
  },
  {
    id: 'qwen-token-plan',
    name: 'Qwen Token Plan',
    baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    apiKeyHint: 'Alibaba Cloud Model Studio API key with a token plan',
    apiKeyEnvVar: 'QWEN_TOKEN_PLAN_API_KEY',
    models: [
      // SOTA
      ['qwen3.8-max', 1_000_000, 131_072],
      ['qwen3.7-max', 1_000_000, 131_072],
      ['glm-5.2', 1_000_000, 131_072],
      ['deepseek-v4-pro', 1_000_000, 384_000],
      // Fast
      ['qwen3.7-plus', 1_000_000, 65_536],
      ['kimi-k2.7-code', 262_144, 262_144],
      ['deepseek-v4-flash', 1_000_000, 384_000],
    ],
    category: 'cloud',
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    apiKeyEnvVar: 'OPENCODE_API_KEY',
    models: [
      // SOTA
      ['claude-opus-5', 1_000_000, 128_000],
      ['gpt-5.5', 1_050_000, 128_000],
      ['claude-opus-4-8', 1_000_000, 128_000],
      // Fast
      ['claude-sonnet-4-6', 1_000_000, 64_000],
      ['kimi-k3', 1_048_576, 131_072],
      ['gemini-3.7-flash', 1_048_576, 65_536],
      ['minimax-m3', 512_000, 128_000],
    ],
    category: 'cloud',
  },
  {
    id: 'requesty',
    name: 'Requesty',
    baseUrl: 'https://router.requesty.ai/v1',
    apiKeyHint: 'API Key (from https://app.requesty.ai/api-keys)',
    models: [
      ['claude-opus-4-8', 1_000_000, 128_000],
      ['gpt-5.5@eu', 1_050_000, 128_000],
      ['gemini-3.5-flash', 1_048_576, 65_535],
      ['kimi-k3', 1_048_576, 262_144],
    ],
    category: 'cloud',
  },
  {
    id: 'thesean',
    name: 'Thesean AI',
    baseUrl: 'https://api.thesean.ai',
    apiKeyHint: 'API Key (from https://app.thesean.ai/)',
    models: [
      'ship-like/claude-opus-4-8',
    ],
    category: 'cloud',
  },
  {
    id: 'atlas-cloud',
    name: 'Atlas Cloud',
    baseUrl: 'https://api.atlascloud.ai/v1',
    apiKeyHint: 'API Key (from atlascloud.ai/developer)',
    models: [
      // No models.dev entry for Atlas; the gpt-5.6 family reports an identical
      // window across every catalogued provider that serves it.
      ['gpt-5.6-sol', 1_050_000, 128_000],
    ],
    category: 'cloud',
  },
  {
    id: 'openai-subscription',
    name: 'OpenAI Subscription',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    auth: 'chatgpt-oauth',
    models: [
      ['gpt-5.6-sol', 1_050_000, 128_000],
      ['gpt-5.6-terra', 1_050_000, 128_000],
      ['gpt-5.6-luna', 1_050_000, 128_000],
      ['gpt-5.5', 1_050_000, 128_000],
      ['gpt-5.4', 1_050_000, 128_000],
      ['gpt-5.4-mini', 400_000, 128_000],
      // The spark variant is the lightweight Codex line: 128K context, 32K output.
      ['gpt-5.3-codex-spark', 128_000, 32_000],
    ],
    category: 'cloud',
  },
  {
    // Poe model ids are provider-prefixed, and Poe caps several models below the
    // origin window (e.g. gpt-5.5 at 400K despite OpenAI's 1.05M).
    id: 'poe',
    name: 'Poe',
    baseUrl: 'https://api.poe.com/v1',
    apiKeyHint: 'API Key (from poe.com/api_key)',
    models: [
      // SOTA
      ['anthropic/claude-opus-4.8', 1_048_576, 128_000],
      ['openai/gpt-5.5', 400_000, 128_000],
      ['google/gemini-3.5-flash', 1_048_576, 65_536],
      // Fast
      ['openai/gpt-5.4-mini', 400_000, 128_000],
      ['anthropic/claude-sonnet-4.6', 983_040, 128_000],
      ['novita/kimi-k2.5', 128_000, 262_144],
    ],
    category: 'cloud',
  },
  {
    id: 'kilo',
    name: 'Kilo Gateway',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    apiKeyEnvVar: 'KILO_API_KEY',
    models: [
      // SOTA
      ['anthropic/claude-opus-5', 1_000_000, 128_000],
      ['openai/gpt-5.6-sol', 1_050_000, 128_000],
      ['moonshotai/kimi-k3', 1_048_576, 1_048_576],
      ['z-ai/glm-5.2', 1_048_576, 131_072],
      // Fast
      ['google/gemini-3.7-flash', 1_048_576, 65_536],
      ['x-ai/grok-4.6', 500_000, 500_000],
      ['deepseek/deepseek-v4-pro-0813', 1_048_576, 384_000],
      ['kilo-auto/frontier', 1_000_000, 128_000],
    ],
    category: 'cloud',
  },
  {
    id: 'novita',
    name: 'Novita AI',
    baseUrl: 'https://api.novita.ai/openai',
    apiKeyEnvVar: 'NOVITA_API_KEY',
    models: [
      // SOTA
      ['moonshotai/kimi-k3', 1_048_576, 1_048_576],
      ['zai-org/glm-5.2', 1_048_576, 131_072],
      ['qwen/qwen3.7-max', 1_000_000, 65_536],
      ['deepseek/deepseek-v4-pro', 1_048_576, 393_216],
      // Fast
      ['moonshotai/kimi-k2.7-code', 262_144, 262_144],
    ],
    category: 'cloud',
  },
  {
    id: 'deep-infra',
    name: 'Deep Infra',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    apiKeyEnvVar: 'DEEPINFRA_API_KEY',
    models: [
      // SOTA
      ['moonshotai/Kimi-K3', 1_048_576, 131_072],
      ['thinkingmachines/Inkling', 524_288, 1_048_576],
      // Fast
      ['deepseek-ai/DeepSeek-V4-Flash-0731', 1_048_576, 384_000],
      ['MiniMaxAI/MiniMax-M3', 524_288, 128_000],
      ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 131_072, 131_072],
    ],
    category: 'cloud',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.com/v1',
    apiKeyEnvVar: 'SILICONFLOW_API_KEY',
    models: [
      // SOTA
      ['zai-org/GLM-5.2', 1_049_000, 262_000],
      ['deepseek-ai/DeepSeek-V4-Pro', 1_000_000, 384_000],
      // Fast
      ['Qwen/Qwen3-Coder-480B-A35B-Instruct', 262_000, 262_000],
      ['moonshotai/Kimi-K2.6', 262_000, 262_000],
    ],
    category: 'cloud',
  },
  {
    id: 'nebius',
    name: 'Nebius AI Studio',
    baseUrl: 'https://api.studio.nebius.com/v1',
    apiKeyEnvVar: 'NEBIUS_API_KEY',
    models: [
      // SOTA
      ['deepseek-ai/DeepSeek-V4-Pro', 1_000_000, 384_000],
      ['moonshotai/Kimi-K3', 1_048_576, 8_000],
      // Fast
      ['zai-org/GLM-5.2', 432_000, 432_000],
      ['nvidia/nemotron-3-super-120b-a12b', 256_000, 32_768],
    ],
    category: 'cloud',
  },

  // ── Local providers (no API key) ────────────────────────────────────
  {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    models: [
      'qwen3-coder',
      'devstral-small-2512',
      'gemma4:26b',
      'llama4:scout',
    ],
    category: 'local',
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp server',
    baseUrl: 'http://localhost:8080/v1',
    category: 'local',
  },
  {
    id: 'mlx-server',
    name: 'MLX Server',
    baseUrl: 'http://localhost:8080/v1',
    category: 'local',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    category: 'local',
  },
];

/** Expand one compact definition into the public preset record. */
function expandPreset(definition: ProviderPresetDefinition): ProviderPreset {
  const tuples = definition.models?.filter((model): model is Exclude<PresetModelSpec, string> => Array.isArray(model)) ?? [];
  return {
    id: definition.id,
    name: definition.name,
    baseUrl: definition.baseUrl,
    needsApiKey: definition.category === 'cloud' && definition.auth == null,
    ...(definition.auth ? {auth: definition.auth} : {}),
    ...(definition.apiKeyHint ? {apiKeyHint: definition.apiKeyHint} : {}),
    ...(definition.apiKeyEnvVar ? {apiKeyEnvVar: definition.apiKeyEnvVar} : {}),
    ...(definition.models ? {suggestedModels: definition.models.map(model => typeof model === 'string' ? model : model[0])} : {}),
    ...(tuples.length > 0 ? {modelLimits: Object.fromEntries(tuples.map(([model, contextWindowTokens, maxOutputTokens]) => [model, {contextWindowTokens, maxOutputTokens}]))} : {}),
    category: definition.category,
  };
}

export const PROVIDER_PRESETS: ProviderPreset[] = PRESET_DEFINITIONS.map(expandPreset);

export function findPreset(id: string): ProviderPreset | undefined {
  // Accept the former picker ids without keeping duplicate preset records.
  const canonicalId = id === 'openai' ? 'openai-api-key' : id === 'chatgpt-codex' ? 'openai-subscription' : id;
  return PROVIDER_PRESETS.find(preset => preset.id === canonicalId);
}

/**
 * Limits for models a wizard flow is adding to a provider, matched by the
 * provider's base URL or its name (a provider created from a preset keeps the
 * preset's name unless the user renamed it). Returns only entries the caller
 * should merge into the provider's settings `modelLimits`; user-configured
 * limits always win because callers merge without overwriting existing keys.
 */
export function presetModelLimitsForModels(provider: {name?: string; url?: string}, models: readonly string[]): Record<string, PresetModelLimits> {
  const preset = PROVIDER_PRESETS.find(candidate => candidate.modelLimits
    && ((provider.url && candidate.baseUrl === provider.url)
      || (provider.name && (candidate.name === provider.name || candidate.id === provider.name))));
  if (!preset?.modelLimits) return {};
  const out: Record<string, PresetModelLimits> = {};
  for (const model of models) {
    const limits = preset.modelLimits[model];
    if (limits) out[model] = limits;
  }
  return out;
}
