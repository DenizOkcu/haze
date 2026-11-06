import type {ReasoningLevel} from '../core/agent/reasoningPolicy.js';

/** Only apply Mistral-specific policy to its direct API, never a gateway. */
export function isMistralApi(url: string): boolean {
  try { return new URL(url).hostname.toLowerCase() === 'api.mistral.ai'; } catch { return false; }
}

/** Documented model IDs and their accepted Chat Completions reasoning levels. */
export function mistralReasoningLevels(url: string, model: string): readonly ReasoningLevel[] | undefined {
  if (!isMistralApi(url)) return undefined;
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
