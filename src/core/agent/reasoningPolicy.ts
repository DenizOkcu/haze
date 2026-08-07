import type {ProviderCapabilities} from '../subagent/contracts.js';

/**
 * Provider-neutral reasoning-depth setting. Unset by default; explicitly user
 * controlled. Mapped to a supported provider protocol (not a model name).
 */
export type ReasoningLevel = 'low' | 'medium' | 'high';

export type EffectiveReasoning = ReasoningLevel | 'disabled';

export interface ResolvedReasoningPolicy {
  /** What the user requested, if anything. */
  requested: ReasoningLevel | undefined;
  /** What will actually be applied (a level, or 'disabled' when unsupported). */
  effective: EffectiveReasoning;
  /** Why effective differs from requested, when it does. */
  reason: string;
}

/**
 * Resolve a requested reasoning level against provider capabilities. Pure and
 * capability based: only protocols that accept the OpenAI `reasoningEffort`
 * provider option receive a level; everything else is disabled (never silently
 * passed in a shape the protocol does not define). No model-name branching.
 */
export function resolveReasoningPolicy(input: {requested: ReasoningLevel | undefined; capabilities: ProviderCapabilities}): ResolvedReasoningPolicy {
  const {requested, capabilities} = input;
  if (!requested) return {requested: undefined, effective: 'disabled', reason: 'no reasoning depth requested'};
  if (!capabilities.supportsReasoningEffort) return {requested, effective: 'disabled', reason: 'provider protocol does not support a reasoning-effort option'};
  return {requested, effective: requested, reason: 'applied via supported provider protocol'};
}

/**
 * The provider-option fragment to merge into request settings for a resolved
 * policy. Returns undefined when disabled so unsupported protocols send nothing.
 */
export function reasoningProviderOptions(policy: ResolvedReasoningPolicy): Record<string, unknown> | undefined {
  if (policy.effective === 'disabled') return undefined;
  return {openai: {reasoningEffort: policy.effective}};
}

const LEVELS: readonly ReasoningLevel[] = ['low', 'medium', 'high'];

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value);
}
