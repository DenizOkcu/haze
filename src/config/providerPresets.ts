/**
 * Known OpenAI-compatible provider presets derived from provider documentation and
 * community conventions. Do not copy native-provider entries from multi-adapter clients:
 * every standard preset here must accept OpenAI Chat Completions requests at its base URL.
 * The OpenAI Subscription preset is the explicit exception and uses its own Codex adapter.
 * Hosted presets carry a pre-configured base URL so users only need to supply an API key
 * and model names. Local/keyless providers have sensible localhost defaults.
 */

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
      'anthropic/claude-opus-4.8',
      'openai/gpt-5.5',
      'google/gemini-3.1-pro-preview',
      // Fast
      'anthropic/claude-sonnet-5',
      'anthropic/claude-sonnet-4.6',
      'openai/gpt-5.4-mini',
      'google/gemini-3.5-flash',
      'deepseek/deepseek-v4-flash',
    ],
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
      'gpt-5.5',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'o3',
      // Fast
      'gpt-5.4',
      'gpt-5.4-mini',
      'o4-mini',
    ],
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
      'gemini-3.5-flash',
      // Fast
      'gemini-3.6-flash',
      'gemini-3.1-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
    ],
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
      'mistral-medium-3-5',
      // Fast
      'mistral-small-2603',
      'codestral-2508',
      'devstral-2512',
    ],
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
      'grok-4.5',
      'grok-4.3',
      // Fast
      'grok-build-0.1',
    ],
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
    ],
    category: 'cloud',
  },
  {
    id: 'z-ai-coding',
    name: 'Z.ai Coding Subscription',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4/',
    needsApiKey: true,
    apiKeyEnvVar: 'ZAI_API_KEY',
    suggestedModels: [
      'glm-5.2',
      'glm-5.1',
      'glm-5v-turbo',
    ],
    category: 'cloud',
  },
  {
    id: 'kimi-code',
    name: 'Kimi Code',
    baseUrl: 'https://api.kimi.com/coding/v1',
    needsApiKey: true,
    apiKeyEnvVar: 'KIMI_API_KEY',
    suggestedModels: [
      'kimi-for-coding',
      'k3',
    ],
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
      'qwen/qwen3-32b',
      'llama-3.3-70b-versatile',
    ],
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
      // Fast
      'moonshotai/Kimi-K2.7-Code',
      'zai-org/GLM-5.2',
    ],
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
    ],
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
      // Fast
      'deepseek-ai/DeepSeek-V4-Flash',
      'Qwen/Qwen3-Coder-Next',
    ],
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
      'nvidia/nemotron-3-super-120b-a12b',
      'minimaxai/minimax-m3',
    ],
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
      'qwen3.7-max',
      'glm-5.2',
      // Fast
      'qwen3.7-plus',
      'kimi-k2.7-code',
    ],
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
      'claude-opus-4-8',
      'gpt-5.5',
      // Fast
      'claude-sonnet-4-6',
      'kimi-k3',
      'minimax-m3',
    ],
    category: 'cloud',
  },
  {
    id: 'requesty',
    name: 'Requesty',
    baseUrl: 'https://router.requesty.ai/v1',
    needsApiKey: true,
    apiKeyHint: 'API Key (from https://app.requesty.ai/api-keys)',
    suggestedModels: [
      'openai/gpt-4o-mini',
    ],
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
      'claude-opus-4.8',
      'gpt-5.6-sol',
      'gpt-5.5',
      'gemini-3.5-flash',
      // Fast
      'gpt-5.4-mini',
      'claude-sonnet-4.6',
      'kimi-k2.5',
    ],
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
