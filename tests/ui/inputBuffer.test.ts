import {describe, expect, it} from 'vitest';
import {
  compactPasteBlocksForDisplay,
  cursorPosition,
  displayCursorForValueCursor,
  lineCount,
  normalizeLineEndings,
  pastePlaceholder,
  updatePasteBlocksForReplacement,
  valueCursorForDisplayCursor,
  wrapDisplayValue,
  type PasteBlock,
} from '../../src/ui/inputBuffer.js';

describe('inputBuffer', () => {
  const block: PasteBlock = {id: 1, start: 3, end: 14, lineCount: 4};

  it('normalizes line endings and counts lines', () => {
    expect(normalizeLineEndings('a\r\nb\rc')).toBe('a\nb\nc');
    expect(lineCount('a\r\nb\rc')).toBe(3);
  });

  it('renders compact paste placeholders', () => {
    expect(pastePlaceholder(block)).toBe('[paste #1 +4 lines]');
    expect(compactPasteBlocksForDisplay('preone\ntwo\nxxxpost', [block])).toBe('pre[paste #1 +4 lines]post');
  });

  it('drops paste blocks edited inside and shifts later blocks', () => {
    expect(updatePasteBlocksForReplacement([block], 5, 6, 1)).toEqual([]);
    expect(updatePasteBlocksForReplacement([block], 5, 5, 1)).toEqual([]);
    expect(updatePasteBlocksForReplacement([block], 0, 1, 3)).toEqual([{...block, start: 5, end: 16}]);
  });

  it('maps cursors between full value and compact display', () => {
    const valueCursorAfterBlock = 15;
    const displayCursor = displayCursorForValueCursor([block], valueCursorAfterBlock);
    expect(displayCursor).toBe(23);
    expect(valueCursorForDisplayCursor([block], displayCursor)).toBe(valueCursorAfterBlock);
    expect(displayCursorForValueCursor([block], 5)).toBe(block.start + pastePlaceholder(block).length);
    expect(valueCursorForDisplayCursor([block], 4)).toBe(block.end);
  });

  it('wraps display values and locates the cursor', () => {
    const lines = wrapDisplayValue('abcde\nf', 3);
    expect(lines).toEqual([
      {text: 'abc', start: 0, end: 3},
      {text: 'de', start: 3, end: 5},
      {text: 'f', start: 6, end: 7},
    ]);
    expect(cursorPosition(lines, 4)).toEqual({lineIndex: 1, column: 1});
    expect(cursorPosition(lines, 7)).toEqual({lineIndex: 2, column: 1});
  });
});
