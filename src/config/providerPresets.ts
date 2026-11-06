import {endpointModelFacts} from './providerModelFacts.js';

// Curated provider presets, verified against provider catalogs on 2026-11-06.

/**
 * Known OpenAI-compatible provider presets derived from provider documentation and
 * community conventions. Do not copy native-provider entries from multi-adapter clients:
 * every standard preset here must accept OpenAI Chat Completions requests at its base URL.
 * The OpenAI Subscription preset is the explicit exception and uses its own Codex adapter.
 * Hosted presets carry a pre-configured base URL so users only need to supply an API key
 * and model names. Local/keyless providers have sensible localhost defaults.
 *
 * Presets list model IDs; limits and reasoning capabilities live in the shared
 * endpoint/model facts. `needsApiKey` is derived from category and auth flow.
 *
 * `modelLimits` values are curated from provider catalogs and models.dev. They are keyed by the exact suggested model id for
 * THIS preset: aggregators may cap context below the origin model's capability (e.g.
 * Together serves DeepSeek-V4-Pro at 512K vs DeepSeek's own 1M), so limits never
 * transfer between providers. These values remain in the shared facts and are resolved at
 * runtime after explicit settings and live discovery.
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

/** A curated model ID; endpoint-specific facts live in providerModelFacts. */
type PresetModelSpec = string;

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
    'anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5',
    'openai/gpt-6.1-sol', 'openai/gpt-6-luna',
    'google/gemini-4-argon', 'google/gemini-3.8-flash',
    'mistralai/mistral-large-4-0', 'deepseek/deepseek-v4.1-flash',
    'moonshotai/kimi-k3.1-pro', 'z-ai/glm-5.3',
    'qwen/qwen3.8-2.4t-a95b', 'minimax/minimax-m3.1-flash',
    'x-ai/grok-4.7',
  ]},
  {id: 'openai-api-key', name: 'OpenAI API Key', baseUrl: 'https://api.openai.com/v1', apiKeyEnvVar: 'OPENAI_API_KEY', category: 'cloud', models: [
    'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna',
  ]},
  {id: 'openai-subscription', name: 'OpenAI Subscription', baseUrl: 'https://chatgpt.com/backend-api/codex', auth: 'chatgpt-oauth', category: 'cloud', models: [
    'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna',
    'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  ]},
  {id: 'google-gemini', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyHint: 'API Key (from https://aistudio.google.com/apikey)', apiKeyEnvVar: 'GEMINI_API_KEY', category: 'cloud', models: [
    'gemini-4-argon', 'gemini-3.8-flash',
  ]},
  {id: 'mistral-api', name: 'Mistral AI (API Key)', baseUrl: 'https://api.mistral.ai/v1', apiKeyHint: 'API Key (from https://console.mistral.ai)', apiKeyEnvVar: 'MISTRAL_API_KEY', category: 'cloud', models: [
    'mistral-large-4', 'mistral-small-latest', 'codestral-latest',
  ]},
  {id: 'mistral-vibe', name: 'Mistral Vibe Subscription', baseUrl: 'https://api.mistral.ai/v1', auth: 'mistral-vibe', category: 'cloud', models: ['mistral-vibe-cli-latest', 'mistral-large-4']},
  {id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnvVar: 'DEEPSEEK_API_KEY', category: 'cloud', models: [
    'deepseek-v4-pro', 'deepseek-flash',
  ]},
  {id: 'xai', name: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', apiKeyEnvVar: 'XAI_API_KEY', category: 'cloud', models: [
    'grok-4.7', 'grok-4.6',
  ]},
  {id: 'z-ai-api', name: 'Z.ai (General API)', baseUrl: 'https://api.z.ai/api/paas/v4/', apiKeyEnvVar: 'ZAI_API_KEY', category: 'cloud', models: [
    'glm-5.3', 'glm-5.3-flash',
  ]},
  {id: 'z-ai-coding', name: 'Z.ai (Coding Plan)', baseUrl: 'https://api.z.ai/api/coding/paas/v4/', apiKeyEnvVar: 'ZAI_API_KEY', category: 'cloud', models: [
    'glm-5.3', 'glm-5.2-highspeed',
  ]},
  {id: 'moonshot', name: 'Moonshot AI (Kimi API)', baseUrl: 'https://api.moonshot.ai/v1', apiKeyEnvVar: 'MOONSHOT_API_KEY', category: 'cloud', models: [
    'kimi-k3.1-pro', 'kimi-k3',
  ]},
  {id: 'kimi-code', name: 'Kimi Code', baseUrl: 'https://api.kimi.com/coding/v1', apiKeyEnvVar: 'KIMI_API_KEY', category: 'cloud', models: [
    'k3', 'k3.1-pro', 'kimi-for-coding',
  ]},
  {id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnvVar: 'GROQ_API_KEY', category: 'cloud', models: [
    'openai/gpt-oss-120b', 'qwen/qwen3.8-27b',
  ]},
  {id: 'together', name: 'Together AI', baseUrl: 'https://api.together.ai/v1', apiKeyEnvVar: 'TOGETHER_API_KEY', category: 'cloud', models: [
    'deepseek-ai/DeepSeek-V4-Pro-0813', 'moonshotai/Kimi-K3.1-Pro',
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
    suggestedModels.push(model);
    const limits = endpointModelFacts(definition.baseUrl, model).limits;
    if (limits) modelLimits[model] = limits;
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
  const named = PROVIDER_PRESETS.find(p => provider.name && (p.name.toLowerCase() === provider.name.toLowerCase() || p.id === provider.name));
  const endpoint = provider.url ?? named?.baseUrl;
  const out: Record<string, PresetModelLimits> = {};
  if (!endpoint) return out;
  for (const model of models) {
    const limits = endpointModelFacts(endpoint, model).limits;
    if (limits) out[model] = limits;
  }
  return out;
}
