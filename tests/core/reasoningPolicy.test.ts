import {describe, expect, it} from 'vitest';
import {DEFAULT_REASONING_LEVEL, effectiveRequestedReasoning, isReasoningLevel, parseReasoningOverride, reasoningCallSetting, REASONING_LEVELS, REASONING_PROVIDER_DEFAULT, resolveReasoningPolicy} from '../../src/core/agent/reasoningPolicy.js';
import type {ProviderCapabilities} from '../../src/core/subagent/contracts.js';
import {providerRequestSettings, type ModelRuntimeConfig} from '../../src/llm/client.js';

const baseCaps = (over: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  reportsCacheUsage: false,
  supportsPromptCacheKey: false,
  supportsExtendedCacheRetention: false,
  supportsStickySessionId: false,
  supportsServerCompaction: false,
  supportsTextVerbosity: false,
  supportsReasoningEffort: false,
  ...over,
});

const baseConfig = (over: Partial<ModelRuntimeConfig> & {capabilities?: ProviderCapabilities; reasoningPolicy?: ModelRuntimeConfig['reasoningPolicy']} = {}): ModelRuntimeConfig => ({
  providerName: 'openai',
  baseURL: 'https://api.openai.com/v1',
  modelName: 'gpt-test',
  cacheKey: 'k',
  capabilities: baseCaps({supportsReasoningEffort: true, supportsPromptCacheKey: true, supportsTextVerbosity: true}),
  reasoningPolicy: {requested: undefined, effective: 'disabled', reason: 'none'},
  ...over,
});

describe('resolveReasoningPolicy', () => {
  it('defaults to high when nothing is requested', () => {
    expect(DEFAULT_REASONING_LEVEL).toBe('high');
    expect(effectiveRequestedReasoning(undefined)).toBe('high');
    expect(effectiveRequestedReasoning('provider-default')).toBeUndefined();
    expect(effectiveRequestedReasoning('medium')).toBe('medium');
  });
  it('is disabled when nothing is requested', () => {
    const p = resolveReasoningPolicy({requested: undefined, capabilities: baseCaps({supportsReasoningEffort: true})});
    expect(p.effective).toBe('disabled');
    expect(p.requested).toBeUndefined();
  });

  it('applies every level of the widened enum when the protocol supports it', () => {
    for (const level of REASONING_LEVELS) {
      const p = resolveReasoningPolicy({requested: level, capabilities: baseCaps({supportsReasoningEffort: true})});
      expect(p.effective, level).toBe(level);
      expect(p.requested, level).toBe(level);
      expect(p.reason, level).toMatch(/supported provider protocol/);
    }
  });

  it("treats 'none' as an explicit request, distinct from unset", () => {
    const p = resolveReasoningPolicy({requested: 'none', capabilities: baseCaps({supportsReasoningEffort: true})});
    expect(p.requested).toBe('none');
    expect(p.effective).toBe('none');
    // Unset still means no parameter at all.
    const unset = resolveReasoningPolicy({requested: undefined, capabilities: baseCaps({supportsReasoningEffort: true})});
    expect(unset.requested).toBeUndefined();
    expect(unset.effective).toBe('disabled');
  });

  it('disables a requested level only when the capability is false (never passed in an undefined shape)', () => {
    const p = resolveReasoningPolicy({requested: 'medium', capabilities: baseCaps({supportsReasoningEffort: false})});
    expect(p.effective).toBe('disabled');
    expect(p.requested).toBe('medium');
    expect(reasoningCallSetting(p)).toBeUndefined();
  });

  it('never branches on a model name', () => {
    // The decision depends only on the capability, not on any model identifier.
    const a = resolveReasoningPolicy({requested: 'low', capabilities: baseCaps({supportsReasoningEffort: true})});
    const b = resolveReasoningPolicy({requested: 'low', capabilities: baseCaps({supportsReasoningEffort: true})});
    expect(a).toEqual(b);
  });
});

describe('reasoningCallSetting', () => {
  it('returns the effective level for every supported level', () => {
    for (const level of REASONING_LEVELS) {
      expect(reasoningCallSetting({requested: level, effective: level, reason: 'ok'}), level).toBe(level);
    }
  });

  it('returns undefined when disabled so the parameter is omitted entirely', () => {
    expect(reasoningCallSetting({requested: undefined, effective: 'disabled', reason: 'none'})).toBeUndefined();
    expect(reasoningCallSetting({requested: 'high', effective: 'disabled', reason: 'unsupported'})).toBeUndefined();
  });
});

describe('parseReasoningOverride (CLI --reasoning)', () => {
  it('maps every level directly, case-insensitively', () => {
    for (const level of REASONING_LEVELS) {
      expect(parseReasoningOverride(level)).toEqual({ok: true, setting: level});
      expect(parseReasoningOverride(level.toUpperCase())).toEqual({ok: true, setting: level});
    }
  });

  it('maps the unset aliases to the provider-default sentinel (no parameter sent)', () => {
    for (const alias of ['unset', 'off', 'provider-default']) {
      expect(parseReasoningOverride(alias)).toEqual({ok: true, setting: REASONING_PROVIDER_DEFAULT});
    }
  });

  it('rejects unknown values with the valid-level list', () => {
    const result = parseReasoningOverride('ultra');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('none');
    if (!result.ok) expect(result.error).toContain('xhigh');
    if (!result.ok) expect(result.error).toContain('unset');
  });
});

describe('providerRequestSettings (reasoning transport, no network)', () => {
  it('emits the top-level reasoning setting, never openai.reasoningEffort', () => {
    const cfg = baseConfig({reasoningPolicy: {requested: 'xhigh', effective: 'xhigh', reason: 'ok'}});
    const opts = providerRequestSettings(cfg);
    expect(opts.reasoning).toBe('xhigh');
    expect(opts.providerOptions?.openai?.reasoningEffort).toBeUndefined();
    // Existing cache/verbosity behavior is preserved.
    expect(opts.providerOptions?.openai?.promptCacheKey).toBe('k');
    expect(opts.providerOptions?.openai?.textVerbosity).toBe('low');
  });

  it('omits reasoning entirely when the policy is disabled', () => {
    const cfg = baseConfig({capabilities: baseCaps({supportsReasoningEffort: false}), reasoningPolicy: {requested: 'high', effective: 'disabled', reason: 'unsupported'}});
    const opts = providerRequestSettings(cfg);
    expect(opts.reasoning).toBeUndefined();
    expect('reasoning' in opts).toBe(false);
    expect(opts.providerOptions?.openai?.reasoningEffort).toBeUndefined();
  });

  it('leaves reasoning unset by default (no user setting)', () => {
    const cfg = baseConfig({reasoningPolicy: {requested: undefined, effective: 'disabled', reason: 'none'}});
    const opts = providerRequestSettings(cfg);
    expect(opts.reasoning).toBeUndefined();
    expect('reasoning' in opts).toBe(false);
  });

  it('carries reasoning alongside the fixed codex providerOptions', () => {
    const cfg = baseConfig({providerKind: 'chatgpt-codex', reasoningPolicy: {requested: 'none', effective: 'none', reason: 'ok'}});
    const opts = providerRequestSettings(cfg);
    expect(opts.omitMaxOutputTokens).toBe(true);
    expect(opts.providerOptions).toEqual({openai: {store: false, include: ['reasoning.encrypted_content']}});
    expect(opts.reasoning).toBe('none');
  });
});

describe('isReasoningLevel', () => {
  it('accepts every widened level and rejects everything else', () => {
    for (const level of REASONING_LEVELS) expect(isReasoningLevel(level), level).toBe(true);
    expect(isReasoningLevel('provider-default')).toBe(false);
    expect(isReasoningLevel('max')).toBe(false);
    expect(isReasoningLevel('unset')).toBe(false);
    expect(isReasoningLevel(undefined)).toBe(false);
  });
});
