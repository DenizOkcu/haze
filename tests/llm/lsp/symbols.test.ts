import {describe, expect, it} from 'vitest';
import {flattenSemanticSymbols, matchesNamePath, semanticSymbols, smallestContainingSymbol} from '../../../src/llm/lsp/symbols.js';

const raw = [{name: 'Service', kind: 5, range: {start: {line: 0, character: 0}, end: {line: 9, character: 1}}, selectionRange: {start: {line: 0, character: 6}, end: {line: 0, character: 13}}, children: [{name: 'run', kind: 6, range: {start: {line: 2, character: 2}, end: {line: 4, character: 3}}, selectionRange: {start: {line: 2, character: 2}, end: {line: 2, character: 5}}}]}];

describe('semantic symbol helpers', () => {
  it('builds hierarchical name paths and preserves ranges', () => {
    const symbols = semanticSymbols(raw);
    expect(flattenSemanticSymbols(symbols).map(symbol => symbol.namePath)).toEqual(['Service', 'Service/run']);
    expect(symbols[0]?.children?.[0]?.range.start).toEqual({line: 3, character: 3});
  });

  it('supports absolute, suffix, simple, and substring matching', () => {
    const method = flattenSemanticSymbols(semanticSymbols(raw))[1]!;
    expect(matchesNamePath(method, '/Service/run', false)).toBe(true);
    expect(matchesNamePath(method, 'Service/run', false)).toBe(true);
    expect(matchesNamePath(method, 'run', false)).toBe(true);
    expect(matchesNamePath(method, 'ru', true)).toBe(true);
  });

  it('finds the smallest enclosing symbol for a reference', () => {
    expect(smallestContainingSymbol(semanticSymbols(raw), 4, 3)?.namePath).toBe('Service/run');
    expect(smallestContainingSymbol(semanticSymbols(raw), 8, 1)?.namePath).toBe('Service');
  });
});
