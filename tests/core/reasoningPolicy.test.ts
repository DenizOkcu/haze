import {describe, expect, it} from 'vitest';
import {isReasoningLevel, reasoningProviderOptions, resolveReasoningPolicy} from '../../src/core/agent/reasoningPolicy.js';
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
  it('is disabled when nothing is requested', () => {
    const p = resolveReasoningPolicy({requested: undefined, capabilities: baseCaps({supportsReasoningEffort: true})});
    expect(p.effective).toBe('disabled');
    expect(p.requested).toBeUndefined();
  });

  it('applies a requested level when the protocol supports it', () => {
    const p = resolveReasoningPolicy({requested: 'high', capabilities: baseCaps({supportsReasoningEffort: true})});
    expect(p.effective).toBe('high');
    expect(p.reason).toMatch(/supported provider protocol/);
  });

  it('disables a requested level on an unsupported protocol (never passed in an undefined shape)', () => {
    const p = resolveReasoningPolicy({requested: 'medium', capabilities: baseCaps({supportsReasoningEffort: false})});
    expect(p.effective).toBe('disabled');
    expect(p.requested).toBe('medium');
    expect(reasoningProviderOptions(p)).toBeUndefined();
  });

  it('never branches on a model name', () => {
    // The decision depends only on the capability, not on any model identifier.
    const a = resolveReasoningPolicy({requested: 'low', capabilities: baseCaps({supportsReasoningEffort: true})});
    const b = resolveReasoningPolicy({requested: 'low', capabilities: baseCaps({supportsReasoningEffort: true})});
    expect(a).toEqual(b);
  });
});

describe('providerRequestSettings (reasoning mapping, no network)', () => {
  it('includes openai.reasoningEffort when a level is effective', () => {
    const cfg = baseConfig({reasoningPolicy: {requested: 'high', effective: 'high', reason: 'ok'}});
    const opts = providerRequestSettings(cfg);
    expect(opts.providerOptions?.openai?.reasoningEffort).toBe('high');
  });

  it('omits reasoningEffort entirely when the policy is disabled', () => {
    const cfg = baseConfig({capabilities: baseCaps({supportsReasoningEffort: false}), reasoningPolicy: {requested: 'high', effective: 'disabled', reason: 'unsupported'}});
    const opts = providerRequestSettings(cfg);
    expect(opts.providerOptions?.openai?.reasoningEffort).toBeUndefined();
  });

  it('leaves reasoningEffort unset by default (no user setting)', () => {
    const cfg = baseConfig({reasoningPolicy: {requested: undefined, effective: 'disabled', reason: 'none'}});
    const opts = providerRequestSettings(cfg);
    expect(opts.providerOptions?.openai?.reasoningEffort).toBeUndefined();
    // Existing cache/verbosity behavior is preserved.
    expect(opts.providerOptions?.openai?.promptCacheKey).toBe('k');
    expect(opts.providerOptions?.openai?.textVerbosity).toBe('low');
  });
});

describe('isReasoningLevel', () => {
  it('accepts only low/medium/high', () => {
    expect(isReasoningLevel('low')).toBe(true);
    expect(isReasoningLevel('medium')).toBe(true);
    expect(isReasoningLevel('high')).toBe(true);
    expect(isReasoningLevel('max')).toBe(false);
    expect(isReasoningLevel(undefined)).toBe(false);
  });
});
