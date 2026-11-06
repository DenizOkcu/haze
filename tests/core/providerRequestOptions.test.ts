import {expect, it} from 'vitest';
import {auxiliaryRequestOptions, type ProviderCapabilities} from '../../src/core/providerContracts.js';

const caps: ProviderCapabilities = {reportsCacheUsage: false, supportsPromptCacheKey: false, supportsExtendedCacheRetention: false, supportsStickySessionId: false, supportsServerCompaction: false, supportsTextVerbosity: false, supportsReasoningEffort: true};

it('omits the output limit for both worker and compaction requests when the provider manages it', () => {
  const options = {omitMaxOutputTokens: true, reasoning: 'high' as const};
  expect(auxiliaryRequestOptions(options, {...caps, workerReasoningEffort: 'low'}, 'worker', 100)).toEqual({reasoning: 'low'});
  expect(auxiliaryRequestOptions(options, caps, 'compaction', 100)).toEqual({reasoning: 'high'});
});

it('sends workers the provider default when no supported OpenRouter minimum is known', () => {
  const options = {providerOptions: {openrouter: {reasoning: {effort: 'high'}, user: 'user'}}};
  expect(auxiliaryRequestOptions(options, {...caps, reasoningTransport: 'openrouter'}, 'worker', 100)).toEqual({providerOptions: {openrouter: {user: 'user'}}, maxOutputTokens: 100});
  expect(options.providerOptions.openrouter.reasoning).toEqual({effort: 'high'});
});
