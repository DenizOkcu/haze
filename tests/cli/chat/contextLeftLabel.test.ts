import {describe, expect, it} from 'vitest';
import {contextLeftLabel} from '../../../src/cli/chat/chatMetrics.js';
import {EMPTY_CONTEXT_USAGE} from '../../../src/cli/chat/turnState.js';

describe('contextLeftLabel', () => {
  it('stays hidden until the model window is known', () => {
    expect(contextLeftLabel({...EMPTY_CONTEXT_USAGE}, 500)).toBeUndefined();
    expect(contextLeftLabel({...EMPTY_CONTEXT_USAGE, windowTokens: 0}, 500)).toBeUndefined();
  });

  it('uses the provider-measured request size once a step reported', () => {
    expect(contextLeftLabel({windowTokens: 200_000, usedTokens: 50_000, estimated: false}, 999)).toBe('75% context left');
  });

  it('falls back to the transcript estimate, marked as a guess only when nonzero', () => {
    expect(contextLeftLabel({...EMPTY_CONTEXT_USAGE, windowTokens: 200_000}, 0)).toBe('100% context left');
    expect(contextLeftLabel({...EMPTY_CONTEXT_USAGE, windowTokens: 200_000}, 50_000)).toBe('~75% context left');
    expect(contextLeftLabel({windowTokens: 200_000, usedTokens: 50_000, estimated: true}, 0)).toBe('75% context left');
  });

  it('clamps to 0–100 when the measurement exceeds the window', () => {
    expect(contextLeftLabel({windowTokens: 200_000, usedTokens: 260_000, estimated: false}, 0)).toBe('0% context left');
    expect(contextLeftLabel({windowTokens: 200_000, usedTokens: -5, estimated: false}, 0)).toBe('100% context left');
  });
});
