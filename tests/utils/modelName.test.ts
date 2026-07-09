import {describe, expect, it} from 'vitest';
import {modelThinkingLabel, shortModelName} from '../../src/utils/modelName.js';

describe('modelName helpers', () => {
  it('falls back to model for blank names', () => {
    expect(shortModelName(undefined)).toBe('model');
    expect(modelThinkingLabel('')).toBe('model is thinking');
  });

  it('keeps the model segment of provider/model names', () => {
    expect(shortModelName('openrouter/anthropic/claude-sonnet-4.5')).toBe('claude-sonnet-4.5');
  });

  it('keeps slash model suffixes such as reasoning variants', () => {
    expect(shortModelName('anthropic/claude-sonnet-4.5:thinking')).toBe('claude-sonnet-4.5:thinking');
  });

  it('supports provider:model selectors without hiding model paths', () => {
    expect(shortModelName('local:gpt-oss')).toBe('gpt-oss');
    expect(shortModelName('openrouter:anthropic/claude-sonnet-4.5:thinking')).toBe('claude-sonnet-4.5:thinking');
  });
});
