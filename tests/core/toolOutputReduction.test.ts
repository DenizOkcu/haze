import {describe, expect, it} from 'vitest';
import {capOutputForProcessing, compactOutput, passthroughReduction, PROCESSING_OUTPUT_CHAR_LIMIT} from '../../src/core/toolOutput/reduction.js';

describe('capOutputForProcessing', () => {
  it('leaves bounded output unchanged', () => {
    expect(capOutputForProcessing('')).toBe('');
    expect(capOutputForProcessing('x'.repeat(PROCESSING_OUTPUT_CHAR_LIMIT))).toBe('x'.repeat(PROCESSING_OUTPUT_CHAR_LIMIT));
  });

  it('keeps head and tail within the requested limit', () => {
    const capped = capOutputForProcessing('0123456789'.repeat(20), 60);
    expect(capped).toHaveLength(60);
    expect(capped).toContain('truncated');
    expect(capped.startsWith('01234567')).toBe(true);
    expect(capped.endsWith('123456789')).toBe(true);
  });
});

describe('compacting stored output', () => {
  it('retains a retrievable handle when using the default reduction', () => {
    const raw = 'abcdefghijklmnopqrstuvwxyz';
    const result = passthroughReduction(raw, {compactMaxChars: 10, storeRawOutput: value => value === raw ? 'saved-output' : 'unexpected'});
    expect(result).toMatchObject({truncated: true, handle: 'saved-output', rawHandle: 'saved-output'});
    expect(result.text).toContain('handle saved-output');
  });

  it('does not claim a handle exists when no storage is available', () => {
    const result = compactOutput('abcdefghijklmnopqrstuvwxyz', 10);
    expect(result.truncated).toBe(true);
    expect(result.handle).toBeUndefined();
    expect(result.text).not.toContain('handle undefined');
  });
});
