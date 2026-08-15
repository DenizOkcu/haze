/**
 * Known OpenAI-compatible provider presets derived from provider documentation and
 * community conventions. Do not copy native-provider entries from multi-adapter clients:
 * every standard preset here must accept OpenAI Chat Completions requests at its base URL.
 * The OpenAI Subscription preset is the explicit exception and uses its own Codex adapter.
 * Hosted presets carry a pre-configured base URL so users only need to supply an API key
 * and model names. Local/keyless providers have sensible localhost defaults.
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

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // ── Cloud providers (API key required) ──────────────────────────────
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsApiKey: true,
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    suggestedModels: [
      // SOTA
      'anthropic/claude-opus-5',
      'openai/gpt-5.6',
      'google/gemini-3.7-flash',
      'anthropic/claude-sonnet-5',
      'qwen/qwen3.8-2.4t-a95b',
      // Fast
      'x-ai/grok-4.6',
      'openai/gpt-5.4-mini',
      'google/gemini-3.5-flash',
      'deepseek/deepseek-v4-flash',
    ],
    modelLimits: {
      'anthropic/claude-opus-5': {contextWindowTokens: 1_048_576, maxOutputTokens: 128_000},
      'openai/gpt-5.6': {contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
      'google/gemini-3.7-flash': {contextWindowTokens: 1_048_576, maxOutputTokens: 65_536},
      'anthropic/claude-sonnet-5': {contextWindowTokens: 1_000_000, maxOutputTokens: 128_000},
      'qwen/qwen3.8-2.4t-a95b': {contextWindowTokens: 1_048_576, maxOutputTokens: 262_144},
      'x-ai/grok-4.6': {contextWindowTokens: 500_000, maxOutputTokens: 500_000},
      'openai/gpt-5.4-mini': {contextWindowTokens: 400_000, maxOutputTokens: 128_000},
      'google/gemini-3.5-flash': {contextWindowTokens: 1_048_576, maxOutputTokens: 65_536},
      'deepseek/deepseek-v4-flash': {contextWindowTokens: 1_048_576, maxOutputTokens: 384_000},
    },
    category: 'cloud',
  },
  {
    id: 'openai-api-key',
    name: 'OpenAI API Key',
    baseUrl: 'https://api.openai.com/v1',
    needsApiKey: true,
    apiKeyEnvVar: 'OPENAI_API_KEY',
    suggestedModels: [
      // SOTA
      'gpt-5.6',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.5-pro',
      'o3',
      // Fast
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
    ],
    modelLimits: {
      'gpt-5.6': {contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
      'gpt-5.6-sol': {contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
      'gpt-5.6-terra': {contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
      'gpt-5.6-luna': {contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
      'gpt-5.5-pro': {contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
      'gpt-5.5': {contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
      'gpt-5.4': {contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
      'gpt-5.4-mini': {contextWindowTokens: 400_000, maxOutputTokens: 128_000},
      'o3': {contextWindowTokens: 200_000, maxOutputTokens: 100_000},
    },
    category: 'cloud',
  },
  {
    id: 'google-gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    needsApiKey: true,
    apiKeyHint: 'API Key (from https://aistudio.google.com/apikey)',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    suggestedModels: [
      // SOTA
      'gemini-3.1-pro-preview',
      'gemini-3.7-flash',
      // Fast
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      'gemini-2.5-pro',
    ],
    modelLimits: {
      'gemini-3.1-pro-preview': {contextWindowTokens: 1_048_576, maxOutputTokens: 65_536},
      'gemini-3.7-flash': {contextWindowTokens: 1_048_576, maxOutputTokens: 65_536},
      'gemini-3.6-flash': {contextWindowTokens: 1_048_576, maxOutputTokens: 65_536},
      'gemini-3.5-flash': {contextWindowTokens: 1_048_576, maxOutputTokens: 65_536},
      'gemini-3.5-flash-lite': {contextWindowTokens: 1_048_576, maxOutputTokens: 65_536},
      'gemini-3.1-flash-lite': {contextWindowTokens: 1_048_576, maxOutputTokens: 65_536},
      'gemini-2.5-pro': {contextWindowTokens: 1_048_576, maxOutputTokens: 65_536},
    },
    category: 'cloud',
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    needsApiKey: true,
    apiKeyEnvVar: 'MISTRAL_API_KEY',
    suggestedModels: [
      // SOTA
      'mistral-large-2512',
      'mistral-medium-2604',
      // Fast
      'mistral-small-2603',
      'codestral-latest',
    ],
    modelLimits: {
      'mistral-large-2512': {contextWindowTokens: 262_144, maxOutputTokens: 262_144},
      'mistral-medium-2604': {contextWindowTokens: 262_144, maxOutputTokens: 262_144},
      'mistral-small-2603': {contextWindowTokens: 256_000, maxOutputTokens: 256_000},
      'codestral-latest': {contextWindowTokens: 256_000, maxOutputTokens: 4_096},
    },
    category: 'cloud',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    needsApiKey: true,
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    suggestedModels: [
      // SOTA
      'deepseek-v4-pro',
      // Fast
      'deepseek-v4-flash',
    ],
    modelLimits: {
      'deepseek-v4-pro': {contextWindowTokens: 1_000_000, maxOutputTokens: 384_000},
      'deepseek-v4-flash': {contextWindowTokens: 1_000_000, maxOutputTokens: 384_000},
    },
    category: 'cloud',
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    needsApiKey: true,
    apiKeyEnvVar: 'XAI_API_KEY',
    suggestedModels: [
      // SOTA
      'grok-4.6',
      'grok-4.5',
      'grok-4.3',
      // Fast
      'grok-build-0.1',
    ],
    modelLimits: {
      'grok-4.6': {contextWindowTokens: 500_000, maxOutputTokens: 500_000},
      'grok-4.5': {contextWindowTokens: 500_000, maxOutputTokens: 500_000},
      'grok-4.3': {contextWindowTokens: 1_000_000, maxOutputTokens: 30_000},
      'grok-build-0.1': {contextWindowTokens: 256_000, maxOutputTokens: 256_000},
    },
    category: 'cloud',
  },
  {
    id: 'z-ai',
    name: 'Z.ai',
    baseUrl: 'https://api.z.ai/api/paas/v4/',
    needsApiKey: true,
    apiKeyEnvVar: 'ZAI_API_KEY',
    suggestedModels: [
      'glm-5.2',
      'glm-5.1',
      'glm-5-turbo',
      'glm-4.7',
    ],
    modelLimits: {
      'glm-5.2': {contextWindowTokens: 1_000_000, maxOutputTokens: 131_072},
      'glm-5.1': {contextWindowTokens: 200_000, maxOutputTokens: 131_072},
      'glm-5-turbo': {contextWindowTokens: 200_000, maxOutputTokens: 131_072},
      'glm-4.7': {contextWindowTokens: 204_800, maxOutputTokens: 131_072},
    },
    category: 'cloud',
  },
  {
    id: 'z-ai-coding',
    name: 'Z.ai Coding Subscription',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4/',
    needsApiKey: true,
    apiKeyEnvVar: 'ZAI_API_KEY',
    suggestedModels: [
      'glm-5.3',
      'glm-5.2',
      'glm-5.2-highspeed',
      'glm-5-turbo',
    ],
    modelLimits: {
      'glm-5.3': {contextWindowTokens: 1_000_000, maxOutputTokens: 131_072},
      'glm-5.2': {contextWindowTokens: 1_000_000, maxOutputTokens: 131_072},
      'glm-5.2-highspeed': {contextWindowTokens: 1_000_000, maxOutputTokens: 131_072},
      'glm-5-turbo': {contextWindowTokens: 200_000, maxOutputTokens: 131_072},
    },
    category: 'cloud',
  },
  {
    id: 'kimi-code',
    name: 'Kimi Code',
    baseUrl: 'https://api.kimi.com/coding/v1',
    needsApiKey: true,
    apiKeyEnvVar: 'KIMI_API_KEY',
    suggestedModels: [
      'k3',
      'k3-256k',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ],
    modelLimits: {
      'k3': {contextWindowTokens: 1_048_576, maxOutputTokens: 131_072},
      'k3-256k': {contextWindowTokens: 262_144, maxOutputTokens: 131_072},
      'kimi-for-coding': {contextWindowTokens: 262_144, maxOutputTokens: 32_768},
      'kimi-for-coding-highspeed': {contextWindowTokens: 262_144, maxOutputTokens: 32_768},
    },
    category: 'cloud',
  },
  {
    id: 'moonshot',
    name: 'Moonshot AI (Kimi API)',
    baseUrl: 'https://api.moonshot.ai/v1',
    needsApiKey: true,
    apiKeyEnvVar: 'MOONSHOT_API_KEY',
    suggestedModels: [
      // SOTA
      'kimi-k3',
      'kimi-k2.7-code',
      // Fast
      'kimi-k2.6',
      'kimi-k2.5',
    ],
    modelLimits: {
      'kimi-k3': {contextWindowTokens: 1_048_576, maxOutputTokens: 131_072},
      'kimi-k2.7-code': {contextWindowTokens: 262_144, maxOutputTokens: 262_144},
      'kimi-k2.6': {contextWindowTokens: 262_144, maxOutputTokens: 262_144},
      'kimi-k2.5': {contextWindowTokens: 262_144, maxOutputTokens: 262_144},
    },
    category: 'cloud',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsApiKey: true,
    apiKeyEnvVar: 'GROQ_API_KEY',
    suggestedModels: [
      'openai/gpt-oss-120b',
      'qwen/qwen3.6-27b',
      'llama-3.3-70b-versatile',
    ],
    modelLimits: {
      'openai/gpt-oss-120b': {contextWindowTokens: 131_072, maxOutputTokens: 65_536},
      'qwen/qwen3.6-27b': {contextWindowTokens: 131_072, maxOutputTokens: 16_384},
      'llama-3.3-70b-versatile': {contextWindowTokens: 131_072, maxOutputTokens: 32_768},
    },
    category: 'cloud',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    needsApiKey: true,
    apiKeyEnvVar: 'CEREBRAS_API_KEY',
    suggestedModels: [
      'gpt-oss-120b',
      'zai-glm-4.7',
    ],
    modelLimits: {
      'gpt-oss-120b': {contextWindowTokens: 131_072, maxOutputTokens: 40_960},
      'zai-glm-4.7': {contextWindowTokens: 131_072, maxOutputTokens: 40_960},
    },
    category: 'cloud',
  },
  {
    id: 'together',
    name: 'Together AI',
    baseUrl: 'https://api.together.ai/v1',
    needsApiKey: true,
    apiKeyEnvVar: 'TOGETHER_API_KEY',
    suggestedModels: [
      // SOTA
      'moonshotai/Kimi-K3',
      'deepseek-ai/DeepSeek-V4-Pro',
      'Qwen/Qwen3.7-Max',
      // Fast
      'moonshotai/Kimi-K2.7-Code',
      'zai-org/GLM-5.2',
      'MiniMaxAI/MiniMax-M3',
    ],    // Router-specific caps: Together serves some models below the origin's window.
    modelLimits: {
      'moonshotai/Kimi-K3': {contextWindowTokens: 1_048_576, maxOutputTokens: 131_072},
      'deepseek-ai/DeepSeek-V4-Pro': {contextWindowTokens: 512_000, maxOutputTokens: 384_000},
      'Qwen/Qwen3.7-Max': {contextWindowTokens: 1_000_000, maxOutputTokens: 500_000},
      'moonshotai/Kimi-K2.7-Code': {contextWindowTokens: 262_144, maxOutputTokens: 131_072},
      'zai-org/GLM-5.2': {contextWindowTokens: 512_000, maxOutputTokens: 164_000},
      'MiniMaxAI/MiniMax-M3': {contextWindowTokens: 524_288, maxOutputTokens: 250_000},
    },
    category: 'cloud',
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    needsApiKey: true,
    apiKeyEnvVar: 'FIREWORKS_API_KEY',
    suggestedModels: [
      // SOTA
      'accounts/fireworks/models/kimi-k3',
      'accounts/fireworks/models/glm-5p2',
      // Fast
      'accounts/fireworks/routers/kimi-k3-fast',
      'accounts/fireworks/models/minimax-m3',
      'accounts/fireworks/models/deepseek-v4-flash',
      'accounts/fireworks/models/deepseek-v4-pro-0813',
    ],
    modelLimits: {
      'accounts/fireworks/models/kimi-k3': {contextWindowTokens: 1_048_576, maxOutputTokens: 131_072},
      'accounts/fireworks/models/glm-5p2': {contextWindowTokens: 1_048_575, maxOutputTokens: 131_072},
      'accounts/fireworks/routers/kimi-k3-fast': {contextWindowTokens: 1_048_576, maxOutputTokens: 131_072},
      'accounts/fireworks/models/minimax-m3': {contextWindowTokens: 512_000, maxOutputTokens: 512_000},
      'accounts/fireworks/models/deepseek-v4-flash': {contextWindowTokens: 1_000_000, maxOutputTokens: 384_000},
      'accounts/fireworks/models/deepseek-v4-pro-0813': {contextWindowTokens: 1_000_000, maxOutputTokens: 384_000},
    },
    category: 'cloud',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face Router',
    baseUrl: 'https://router.huggingface.co/v1',
    needsApiKey: true,
    apiKeyHint: 'Hugging Face token (from https://huggingface.co/settings/tokens)',
    apiKeyEnvVar: 'HF_TOKEN',
    suggestedModels: [
      // SOTA
      'moonshotai/Kimi-K3',
      'zai-org/GLM-5.2',
      'thinkingmachines/Inkling',
      // Fast
      'deepseek-ai/DeepSeek-V4-Flash',
      'Qwen/Qwen3-Coder-Next',
    ],
    modelLimits: {
      'moonshotai/Kimi-K3': {contextWindowTokens: 1_048_576, maxOutputTokens: 131_072},
      'zai-org/GLM-5.2': {contextWindowTokens: 262_144, maxOutputTokens: 131_072},
      'thinkingmachines/Inkling': {contextWindowTokens: 1_048_576, maxOutputTokens: 1_048_576},
      'deepseek-ai/DeepSeek-V4-Flash': {contextWindowTokens: 1_048_576, maxOutputTokens: 384_000},
      'Qwen/Qwen3-Coder-Next': {contextWindowTokens: 262_144, maxOutputTokens: 65_536},
    },
    category: 'cloud',
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    needsApiKey: true,
    apiKeyEnvVar: 'NVIDIA_API_KEY',
    suggestedModels: [
      'nvidia/nemotron-3-ultra-550b-a55b',
      'nvidia/nemotron-3.5-lightning-30b-a3b',
      'nvidia/nemotron-3-super-120b-a12b',
      'minimaxai/minimax-m3',
    ],
    modelLimits: {
      'nvidia/nemotron-3-ultra-550b-a55b': {contextWindowTokens: 1_000_000, maxOutputTokens: 65_536},
      'nvidia/nemotron-3.5-lightning-30b-a3b': {contextWindowTokens: 262_144, maxOutputTokens: 262_144},
      'nvidia/nemotron-3-super-120b-a12b': {contextWindowTokens: 262_144, maxOutputTokens: 262_144},
      'minimaxai/minimax-m3': {contextWindowTokens: 1_000_000, maxOutputTokens: 16_384},
    },
    category: 'cloud',
  },
  {
    id: 'qwen-token-plan',
    name: 'Qwen Token Plan',
    baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
    needsApiKey: true,
    apiKeyHint: 'Alibaba Cloud Model Studio API key with a token plan',
    apiKeyEnvVar: 'QWEN_TOKEN_PLAN_API_KEY',
    suggestedModels: [
      // SOTA
      'qwen3.8-max',
      'qwen3.7-max',
      'glm-5.2',
      'deepseek-v4-pro',
      // Fast
      'qwen3.7-plus',
      'kimi-k2.7-code',
      'deepseek-v4-flash',
    ],
    modelLimits: {
      'qwen3.8-max': {contextWindowTokens: 1_000_000, maxOutputTokens: 131_072},
      'qwen3.7-max': {contextWindowTokens: 1_000_000, maxOutputTokens: 131_072},
      'glm-5.2': {contextWindowTokens: 1_000_000, maxOutputTokens: 131_072},
      'deepseek-v4-pro': {contextWindowTokens: 1_000_000, maxOutputTokens: 384_000},
      'qwen3.7-plus': {contextWindowTokens: 1_000_000, maxOutputTokens: 65_536},
      'kimi-k2.7-code': {contextWindowTokens: 262_144, maxOutputTokens: 262_144},
      'deepseek-v4-flash': {contextWindowTokens: 1_000_000, maxOutputTokens: 384_000},
    },
    category: 'cloud',
  },
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    needsApiKey: true,
    apiKeyEnvVar: 'OPENCODE_API_KEY',
    suggestedModels: [
      // SOTA
      'claude-opus-5',
      'gpt-5.5',
      'claude-opus-4-8',
      // Fast
      'claude-sonnet-4-6',
      'kimi-k3',
      'gemini-3.7-flash',
      'minimax-m3',
    ],
    modelLimits: {
      'claude-opus-5': {contextWindowTokens: 1_000_000, maxOutputTokens: 128_000},
      'gpt-5.5': {contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
      'claude-opus-4-8': {contextWindowTokens: 1_000_000, maxOutputTokens: 128_000},
      'claude-sonnet-4-6': {contextWindowTokens: 1_000_000, maxOutputTokens: 64_000},
      'kimi-k3': {contextWindowTokens: 1_048_576, maxOutputTokens: 131_072},
      'gemini-3.7-flash': {contextWindowTokens: 1_048_576, maxOutputTokens: 65_536},
      'minimax-m3': {contextWindowTokens: 512_000, maxOutputTokens: 128_000},
    },
    category: 'cloud',
  },
  {
    id: 'requesty',
    name: 'Requesty',
    baseUrl: 'https://router.requesty.ai/v1',
    needsApiKey: true,
    apiKeyHint: 'API Key (from https://app.requesty.ai/api-keys)',
    suggestedModels: [
      'claude-opus-4-8',
      'gpt-5.5@eu',
      'gemini-3.5-flash',
      'kimi-k3',
    ],
    modelLimits: {
      'claude-opus-4-8': {contextWindowTokens: 1_000_000, maxOutputTokens: 128_000},
      'gpt-5.5@eu': {contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
      'gemini-3.5-flash': {contextWindowTokens: 1_048_576, maxOutputTokens: 65_535},
      'kimi-k3': {contextWindowTokens: 1_048_576, maxOutputTokens: 262_144},
    },
    category: 'cloud',
  },
  {
    id: 'thesean',
    name: 'Thesean AI',
    baseUrl: 'https://api.thesean.ai',
    needsApiKey: true,
    apiKeyHint: 'API Key (from https://app.thesean.ai/)',
    suggestedModels: [
      'ship-like/claude-opus-4-8',
    ],
    category: 'cloud',
  },
  {
    id: 'atlas-cloud',
    name: 'Atlas Cloud',
    baseUrl: 'https://api.atlascloud.ai/v1',
    needsApiKey: true,
    apiKeyHint: 'API Key (from atlascloud.ai/developer)',
    suggestedModels: [
      'gpt-5.6-sol',
    ],
    modelLimits: {
      // No models.dev entry for Atlas; the gpt-5.6 family reports an identical
      // window across every catalogued provider that serves it.
      'gpt-5.6-sol': {contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
    },
    category: 'cloud',
  },
  {
    id: 'openai-subscription',
    name: 'OpenAI Subscription',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    needsApiKey: false,
    auth: 'chatgpt-oauth',
    suggestedModels: [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ],
    modelLimits: {
      'gpt-5.6-sol': {contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
      'gpt-5.6-terra': {contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
      'gpt-5.6-luna': {contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
      'gpt-5.5': {contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
      'gpt-5.4': {contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
      'gpt-5.4-mini': {contextWindowTokens: 400_000, maxOutputTokens: 128_000},
      // The spark variant is the lightweight Codex line: 128K context, 32K output.
      'gpt-5.3-codex-spark': {contextWindowTokens: 128_000, maxOutputTokens: 32_000},
    },
    category: 'cloud',
  },
  {
    id: 'poe',
    name: 'Poe',
    baseUrl: 'https://api.poe.com/v1',
    needsApiKey: true,
    apiKeyHint: 'API Key (from poe.com/api_key)',
    suggestedModels: [
      // SOTA
      'anthropic/claude-opus-4.8',
      'openai/gpt-5.5',
      'google/gemini-3.5-flash',
      // Fast
      'openai/gpt-5.4-mini',
      'anthropic/claude-sonnet-4.6',
      'novita/kimi-k2.5',
    ],
    // Poe model ids are provider-prefixed, and Poe caps several models below the
    // origin window (e.g. gpt-5.5 at 400K despite OpenAI's 1.05M).
    modelLimits: {
      'anthropic/claude-opus-4.8': {contextWindowTokens: 1_048_576, maxOutputTokens: 128_000},
      'openai/gpt-5.5': {contextWindowTokens: 400_000, maxOutputTokens: 128_000},
      'google/gemini-3.5-flash': {contextWindowTokens: 1_048_576, maxOutputTokens: 65_536},
      'openai/gpt-5.4-mini': {contextWindowTokens: 400_000, maxOutputTokens: 128_000},
      'anthropic/claude-sonnet-4.6': {contextWindowTokens: 983_040, maxOutputTokens: 128_000},
      'novita/kimi-k2.5': {contextWindowTokens: 128_000, maxOutputTokens: 262_144},
    },
    category: 'cloud',
  },

  {
    id: 'kilo',
    name: 'Kilo Gateway',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    needsApiKey: true,
    apiKeyEnvVar: 'KILO_API_KEY',
    suggestedModels: [
      // SOTA
      'anthropic/claude-opus-5',
      'openai/gpt-5.6-sol',
      'moonshotai/kimi-k3',
      'z-ai/glm-5.2',
      // Fast
      'google/gemini-3.7-flash',
      'x-ai/grok-4.6',
      'deepseek/deepseek-v4-pro-0813',
      'kilo-auto/frontier',
    ],
    modelLimits: {
      'anthropic/claude-opus-5': {contextWindowTokens: 1_000_000, maxOutputTokens: 128_000},
      'openai/gpt-5.6-sol': {contextWindowTokens: 1_050_000, maxOutputTokens: 128_000},
      'moonshotai/kimi-k3': {contextWindowTokens: 1_048_576, maxOutputTokens: 1_048_576},
      'z-ai/glm-5.2': {contextWindowTokens: 1_048_576, maxOutputTokens: 131_072},
      'google/gemini-3.7-flash': {contextWindowTokens: 1_048_576, maxOutputTokens: 65_536},
      'x-ai/grok-4.6': {contextWindowTokens: 500_000, maxOutputTokens: 500_000},
      'deepseek/deepseek-v4-pro-0813': {contextWindowTokens: 1_048_576, maxOutputTokens: 384_000},
      'kilo-auto/frontier': {contextWindowTokens: 1_000_000, maxOutputTokens: 128_000},
    },
    category: 'cloud',
  },
  {
    id: 'novita',
    name: 'Novita AI',
    baseUrl: 'https://api.novita.ai/openai',
    needsApiKey: true,
    apiKeyEnvVar: 'NOVITA_API_KEY',
    suggestedModels: [
      // SOTA
      'moonshotai/kimi-k3',
      'zai-org/glm-5.2',
      'qwen/qwen3.7-max',
      'deepseek/deepseek-v4-pro',
      // Fast
      'moonshotai/kimi-k2.7-code',
    ],
    modelLimits: {
      'moonshotai/kimi-k3': {contextWindowTokens: 1_048_576, maxOutputTokens: 1_048_576},
      'zai-org/glm-5.2': {contextWindowTokens: 1_048_576, maxOutputTokens: 131_072},
      'qwen/qwen3.7-max': {contextWindowTokens: 1_000_000, maxOutputTokens: 65_536},
      'deepseek/deepseek-v4-pro': {contextWindowTokens: 1_048_576, maxOutputTokens: 393_216},
      'moonshotai/kimi-k2.7-code': {contextWindowTokens: 262_144, maxOutputTokens: 262_144},
    },
    category: 'cloud',
  },
  {
    id: 'deep-infra',
    name: 'Deep Infra',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    needsApiKey: true,
    apiKeyEnvVar: 'DEEPINFRA_API_KEY',
    suggestedModels: [
      // SOTA
      'moonshotai/Kimi-K3',
      'thinkingmachines/Inkling',
      // Fast
      'deepseek-ai/DeepSeek-V4-Flash-0731',
      'MiniMaxAI/MiniMax-M3',
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    ],
    modelLimits: {
      'moonshotai/Kimi-K3': {contextWindowTokens: 1_048_576, maxOutputTokens: 131_072},
      'thinkingmachines/Inkling': {contextWindowTokens: 524_288, maxOutputTokens: 1_048_576},
      'deepseek-ai/DeepSeek-V4-Flash-0731': {contextWindowTokens: 1_048_576, maxOutputTokens: 384_000},
      'MiniMaxAI/MiniMax-M3': {contextWindowTokens: 524_288, maxOutputTokens: 128_000},
      'meta-llama/Llama-3.3-70B-Instruct-Turbo': {contextWindowTokens: 131_072, maxOutputTokens: 131_072},
    },
    category: 'cloud',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.com/v1',
    needsApiKey: true,
    apiKeyEnvVar: 'SILICONFLOW_API_KEY',
    suggestedModels: [
      // SOTA
      'zai-org/GLM-5.2',
      'deepseek-ai/DeepSeek-V4-Pro',
      // Fast
      'Qwen/Qwen3-Coder-480B-A35B-Instruct',
      'moonshotai/Kimi-K2.6',
    ],
    modelLimits: {
      'zai-org/GLM-5.2': {contextWindowTokens: 1_049_000, maxOutputTokens: 262_000},
      'deepseek-ai/DeepSeek-V4-Pro': {contextWindowTokens: 1_000_000, maxOutputTokens: 384_000},
      'Qwen/Qwen3-Coder-480B-A35B-Instruct': {contextWindowTokens: 262_000, maxOutputTokens: 262_000},
      'moonshotai/Kimi-K2.6': {contextWindowTokens: 262_000, maxOutputTokens: 262_000},
    },
    category: 'cloud',
  },
  {
    id: 'nebius',
    name: 'Nebius AI Studio',
    baseUrl: 'https://api.studio.nebius.com/v1',
    needsApiKey: true,
    apiKeyEnvVar: 'NEBIUS_API_KEY',
    suggestedModels: [
      // SOTA
      'deepseek-ai/DeepSeek-V4-Pro',
      'moonshotai/Kimi-K3',
      // Fast
      'zai-org/GLM-5.2',
      'nvidia/nemotron-3-super-120b-a12b',
    ],
    modelLimits: {
      'deepseek-ai/DeepSeek-V4-Pro': {contextWindowTokens: 1_000_000, maxOutputTokens: 384_000},
      'moonshotai/Kimi-K3': {contextWindowTokens: 1_048_576, maxOutputTokens: 8_000},
      'zai-org/GLM-5.2': {contextWindowTokens: 432_000, maxOutputTokens: 432_000},
      'nvidia/nemotron-3-super-120b-a12b': {contextWindowTokens: 256_000, maxOutputTokens: 32_768},
    },
    category: 'cloud',
  },

  // ── Local providers (no API key) ────────────────────────────────────
  {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    needsApiKey: false,
    suggestedModels: [
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
    needsApiKey: false,
    category: 'local',
  },
  {
    id: 'mlx-server',
    name: 'MLX Server',
    baseUrl: 'http://localhost:8080/v1',
    needsApiKey: false,
    category: 'local',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    needsApiKey: false,
    category: 'local',
  },
];

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
