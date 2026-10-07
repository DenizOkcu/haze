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
  /**
   * Protocol accepts a reasoning-effort request. Explicit-first: a provider
   * `capabilities.reasoningEffort` override in settings wins. The default is
   * the SDK pass-through (`true`) for hosted OpenAI-compatible endpoints and
   * `false` for loopback/local inference servers, whose own reasoning switches
   * (e.g. LM Studio's `on`/`off`) coerce unsupported levels — even `none` — to
   * `on`, silently inverting the request. `false` omits the parameter entirely.
   */
  supportsReasoningEffort: boolean;
}

export interface ProviderRequestOptions {
  providerOptions?: Record<string, Record<string, JSONValue | undefined>>;
  headers?: Record<string, string>;
  /** AI SDK top-level `reasoning` call setting; omitted when unset/unsupported. */
  reasoning?: ReasoningLevel;
  /** Codex subscription requests let the provider manage the output limit. */
  omitMaxOutputTokens?: boolean;
}
