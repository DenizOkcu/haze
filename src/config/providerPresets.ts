/**
 * Known provider presets derived from community conventions (nanocoder, OpenRouter docs, etc.).
 * Each preset carries a pre-configured base URL so users only need to supply an API key and model names.
 * Local/keyless providers have sensible localhost defaults.
 */

export interface ProviderPreset {
  /** Unique identifier used as the selection value. */
  id: string;
  /** Human-readable name shown in the picker. */
  name: string;
  /** Pre-configured OpenAI-compatible base URL. Optional for native SDK providers. */
  baseUrl?: string;
  /** Whether an API key is typically required. Local providers default to false. */
  needsApiKey: boolean;
  /** Hint shown when prompting for the API key. */
  apiKeyHint?: string;
  /** Optional suggested default model(s). */
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
    suggestedModels: [
      // SOTA
      'anthropic/claude-opus-4.8',
      'openai/gpt-5.4',
      'google/gemini-3.1-pro',
      // Fast
      'anthropic/claude-sonnet-4.6',
      'openai/gpt-5.4-mini',
      'google/gemini-3.5-flash',
      'deepseek/deepseek-v4-flash',
    ],
    category: 'cloud',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    needsApiKey: true,
    suggestedModels: [
      // SOTA
      'gpt-5.5',
      'o3',
      // Fast
      'gpt-5.4',
      'gpt-5.4-mini',
      'o4-mini',
    ],
    category: 'cloud',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    needsApiKey: true,
    suggestedModels: [
      // SOTA
      'claude-opus-4-8',
      'claude-fable-5',
      // Fast
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ],
    category: 'cloud',
  },
  {
    id: 'google-gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    needsApiKey: true,
    apiKeyHint: 'API Key (from https://aistudio.google.com/apikey)',
    suggestedModels: [
      // SOTA
      'gemini-3.5-flash',
      'gemini-3.1-pro',
      // Fast
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
    suggestedModels: [
      // SOTA
      'mistral-large-2512',
      'mistral-medium-3-5',
      // Fast
      'mistral-small-2603',
      'codestral-2508',
    ],
    category: 'cloud',
  },
  {
    id: 'z-ai',
    name: 'Z.ai',
    baseUrl: 'https://api.z.ai/api/paas/v4/',
    needsApiKey: true,
    suggestedModels: [
      'glm-5.1',
      'glm-5.1-fw',
    ],
    category: 'cloud',
  },
  {
    id: 'z-ai-coding',
    name: 'Z.ai Coding Subscription',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4/',
    needsApiKey: true,
    suggestedModels: [
      'glm-5.1',
      'glm-5.1-fw',
    ],
    category: 'cloud',
  },
  {
    id: 'github-models',
    name: 'GitHub Models',
    baseUrl: 'https://models.github.ai/inference',
    needsApiKey: true,
    apiKeyHint: 'GitHub Token (PAT with models:read scope)',
    suggestedModels: [
      'gpt-5.4',
      'gpt-5.4-mini',
      'claude-sonnet-4-6',
      'gemini-3.1-pro',
    ],
    category: 'cloud',
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    baseUrl: 'https://api.githubcopilot.com',
    needsApiKey: true,
    apiKeyHint: 'GitHub Copilot token (OAuth)',
    suggestedModels: [
      'gpt-5.4',
      'claude-fable-5',
      'claude-sonnet-4-6',
      'gemini-3.1-pro',
    ],
    category: 'cloud',
  },
  {
    id: 'chatgpt-codex',
    name: 'ChatGPT / Codex',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    needsApiKey: true,
    apiKeyHint: 'ChatGPT session token (OAuth)',
    suggestedModels: [
      'gpt-5.4',
      'o4-mini',
    ],
    category: 'cloud',
  },
  {
    id: 'kimi-code',
    name: 'Kimi Code',
    baseUrl: 'https://api.kimi.com/coding/v1',
    needsApiKey: true,
    suggestedModels: [
      'kimi-for-coding',
    ],
    category: 'cloud',
  },
  {
    id: 'minimax-coding',
    name: 'MiniMax Coding Plan',
    baseUrl: 'https://api.minimax.io/anthropic/v1',
    needsApiKey: true,
    suggestedModels: [
      // SOTA
      'MiniMax-M3',
      // Fast
      'MiniMax-M2.7',
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
  return PROVIDER_PRESETS.find(preset => preset.id === id);
}
