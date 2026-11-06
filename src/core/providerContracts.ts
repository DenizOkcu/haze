import type {JSONValue} from 'ai';
import type {ReasoningLevel} from './agent/reasoningPolicy.js';

/**
 * Provider protocol capability and request-option types shared by the model
 * client (`llm`), worker runtimes, and reasoning policy. Lives at the core
 * root so neither layer reaches into the other's domain subtrees for them.
 */

export interface ProviderCapabilities {
  reportsCacheUsage: boolean;
  supportsPromptCacheKey: boolean;
  supportsExtendedCacheRetention: boolean;
  supportsStickySessionId: boolean;
  supportsServerCompaction: boolean;
  supportsTextVerbosity: boolean;
  /** The resolved model profile has at least one supported reasoning choice. */
  supportsReasoningEffort: boolean;
  /** Lowest supported worker effort when the model does not accept none. */
  workerReasoningEffort?: ReasoningLevel;
  /** OpenRouter accepts effort inside its provider-specific reasoning object. */
  reasoningTransport?: 'openrouter';
  /** Native template switch, independently of OpenAI effort pass-through. */
  supportsBinaryThinking?: boolean;
}

export interface ProviderRequestOptions {
  providerOptions?: Record<string, Record<string, JSONValue | undefined>>;
  headers?: Record<string, string>;
  /** AI SDK top-level `reasoning` call setting; omitted when unset/unsupported. */
  reasoning?: ReasoningLevel;
  /** Codex subscription requests let the provider manage the output limit. */
  omitMaxOutputTokens?: boolean;
}
