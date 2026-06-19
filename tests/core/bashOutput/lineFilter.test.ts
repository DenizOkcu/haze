import {describe, expect, it} from 'vitest';
import {applyLineFilter} from '../../../src/core/bashOutput/lineFilter.js';

const filter = {
  name: 'demo',
  matchCommand: /demo/,
  stripAnsi: true,
  stripLinesMatching: [/^noise/],
  truncateLinesAt: 8,
  maxLines: 3,
  onEmpty: 'demo: ok',
};

describe('line output filters', () => {
  it('strips ansi, removes noisy lines, truncates, and caps lines', () => {
    const result = applyLineFilter(filter, 'demo run', '\u001B[31mkeep this long line\u001B[0m\nnoise one\nkeep two\nkeep three\nkeep four\n');
    expect(result?.text).toBe('keep thi…\nkeep two\n[... 1 lines omitted ...]\nkeep fou…');
    expect(result?.filtered).toBe(true);
  });

  it('uses onEmpty when all lines are removed', () => {
    const result = applyLineFilter(filter, 'demo run', 'noise one\n');
    expect(result?.text).toBe('demo: ok');
  });

  it('does not apply to unmatched commands', () => {
    expect(applyLineFilter(filter, 'other', 'noise one\n')).toBeUndefined();
  });
});
