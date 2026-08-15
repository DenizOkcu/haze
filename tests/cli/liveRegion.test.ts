import {describe, expect, it} from 'vitest';
import {clampTextTail, lineRows, wrapLine} from '../../src/cli/chat/liveRegion.js';

describe('wrapLine', () => {
  it('passes short lines through unchanged', () => {
    expect(wrapLine('hello', 20)).toEqual(['hello']);
  });

  it('wraps long lines at word boundaries like Ink', () => {
    // trim:false keeps the trailing space on the wrapped row, matching Ink.
    expect(wrapLine('alpha beta gamma', 11)).toEqual(['alpha beta ', 'gamma']);
  });

  it('hard-splits words longer than the width', () => {
    expect(wrapLine('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('keeps an empty line as a single row', () => {
    expect(wrapLine('', 10)).toEqual(['']);
    expect(lineRows('', 10)).toBe(1);
  });
});

describe('clampTextTail', () => {
  it('returns text unchanged when it fits the budget', () => {
    const result = clampTextTail('one\ntwo\nthree', 20, 5);
    expect(result).toEqual({text: 'one\ntwo\nthree', hiddenLineCount: 0});
  });

  it('keeps the tail and reports hidden wrapped rows', () => {
    // Budget 2 = indicator + last row; three rows hidden.
    const result = clampTextTail('one\ntwo\nthree\nfour', 20, 2);
    expect(result.hiddenLineCount).toBe(3);
    expect(result.text).toBe('four');
  });

  it('reserves an indicator row when clamping', () => {
    // Three rows of text, budget 2: indicator (1) + last text row (1).
    const result = clampTextTail('one\ntwo\nthree', 20, 2);
    expect(result.hiddenLineCount).toBe(2);
    expect(result.text).toBe('three');
  });

  it('drops whole logical lines even when only part of one overflows', () => {
    // 'aaaa bbbb' wraps to two rows at width 4 ('aaaa' is hard-split, 'bbbb' next).
    const result = clampTextTail('aaaa bbbb\ntail', 4, 2);
    expect(result.text).toBe('tail');
    expect(result.hiddenLineCount).toBeGreaterThanOrEqual(1);
  });

  it('clamps to the last row for a budget of one row', () => {
    const result = clampTextTail('one\ntwo', 20, 1);
    expect(result.hiddenLineCount).toBe(1);
    expect(result.text).toBe('two');
  });
});
