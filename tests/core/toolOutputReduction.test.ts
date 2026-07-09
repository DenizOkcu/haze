import {describe, expect, it} from 'vitest';
import {capOutputForProcessing, PROCESSING_OUTPUT_CHAR_LIMIT} from '../../src/core/toolOutput/reduction.js';

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
