import type {ProviderCapabilities} from '../subagent/contracts.js';

/**
 * Provider-neutral reasoning-depth levels (the AI SDK `reasoning` enum minus
 * `provider-default`). `'none'` is an explicit request to disable reasoning;
 * the stored `provider-default` sentinel means "send no parameter at all".
 */
export type ReasoningLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export const REASONING_LEVELS: readonly ReasoningLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/**
 * Level applied when settings carry no `reasoning` key. Users opt out with an
 * explicit `none` (reasoning off) or the stored `provider-default` sentinel
 * (written by `/reasoning unset`); key-absent means this default.
 */
export const DEFAULT_REASONING_LEVEL: ReasoningLevel = 'high';

/** Value the settings file may store: a level or the `provider-default` sentinel. */
export type StoredReasoningSetting = ReasoningLevel | 'provider-default';

/** Stored sentinel meaning "send no reasoning parameter at all". */
export const REASONING_PROVIDER_DEFAULT = 'provider-default' as const;

export function isStoredReasoning(value: unknown): value is StoredReasoningSetting {
  return isReasoningLevel(value) || value === REASONING_PROVIDER_DEFAULT;
}

/**
 * The level a session actually requests: the stored setting when present, the
 * default when the key is absent. The `provider-default` sentinel maps to
 * undefined — no parameter is sent.
 */
export function effectiveRequestedReasoning(setting: StoredReasoningSetting | undefined): ReasoningLevel | undefined {
  if (setting === REASONING_PROVIDER_DEFAULT) return undefined;
  return setting ?? DEFAULT_REASONING_LEVEL;
}

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
 * capability based: only protocols that accept the reasoning parameter receive
 * a level; everything else is disabled (the parameter is omitted entirely,
 * never sent in a shape the protocol does not define). No model-name branching.
 */
export function resolveReasoningPolicy(input: {requested: ReasoningLevel | undefined; capabilities: ProviderCapabilities}): ResolvedReasoningPolicy {
  const {requested, capabilities} = input;
  if (!requested) return {requested: undefined, effective: 'disabled', reason: 'no reasoning depth requested'};
  if (!capabilities.supportsReasoningEffort) return {requested, effective: 'disabled', reason: 'provider protocol does not support a reasoning-effort option'};
  return {requested, effective: requested, reason: 'applied via supported provider protocol'};
}

/**
 * The AI SDK top-level `reasoning` call setting for a resolved policy.
 * Returns undefined when disabled so unsupported or unrequested turns omit the
 * parameter entirely. Never returns `'provider-default'` today; the sentinel
 * stays in the return type for forward compatibility.
 */
export function reasoningCallSetting(policy: ResolvedReasoningPolicy): ReasoningLevel | 'provider-default' | undefined {
  if (policy.effective === 'disabled') return undefined;
  return policy.effective;
}

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === 'string' && (REASONING_LEVELS as readonly string[]).includes(value);
}

/** Aliases accepted by CLI paths (`/reasoning`, `--reasoning`) for "send no reasoning parameter". */
export function isReasoningUnsetAlias(value: string): boolean {
  return value === 'unset' || value === 'off' || value === REASONING_PROVIDER_DEFAULT;
}

export type ParsedReasoningOverride = {ok: true; setting: StoredReasoningSetting} | {ok: false; error: string};

/**
 * Parse a `--reasoning` CLI value (case-insensitive): a level maps directly,
 * the unset aliases mean "send no reasoning parameter for this run". Shared by
 * the commander flag surface and the headless option validation.
 */
export function parseReasoningOverride(raw: string): ParsedReasoningOverride {
  const value = raw.trim().toLowerCase();
  if (isReasoningUnsetAlias(value)) return {ok: true, setting: REASONING_PROVIDER_DEFAULT};
  if (isReasoningLevel(value)) return {ok: true, setting: value};
  return {ok: false, error: `Unknown reasoning level "${raw.trim()}". Valid levels: ${REASONING_LEVELS.join(', ')} — or unset for the provider default.`};
}
