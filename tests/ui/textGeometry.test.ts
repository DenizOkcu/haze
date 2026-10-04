import {expect, it} from 'vitest';
import {cellWidth, clipCells, graphemes, nextBoundary, offsetAtColumn, previousBoundary, safeInputDisplay} from '../../src/ui/textGeometry.js';
import {cursorPosition, wrapDisplayValue, displayCursorForValueCursor, valueCursorForDisplayCursor, pastePlaceholder} from '../../src/ui/inputBuffer.js';

it.each(['界', '🙂', 'e\u0301', '👨‍👩‍👧‍👦'])('navigates and wraps complete graphemes: %s', text => {
  expect(graphemes(text)).toHaveLength(1);
  expect(nextBoundary(text, 0)).toBe(text.length);
  expect(previousBoundary(text, text.length)).toBe(0);
  expect(wrapDisplayValue(text.repeat(2), cellWidth(text))).toEqual([
    {text, start: 0, end: text.length}, {text, start: text.length, end: text.length * 2},
  ]);
  expect(cursorPosition(wrapDisplayValue(text, 10), text.length).column).toBe(cellWidth(text));
  expect(offsetAtColumn(text + 'a', cellWidth(text))).toBe(text.length);
});
it('clips by cells and preserves oversize graphemes in underlying wraps', () => {
  expect(clipCells('界🙂a', 3)).toBe('界');
  expect(wrapDisplayValue('🙂a', 1)[0]?.text).toBe('🙂');
  expect(cellWidth('\x1b[31m界\x1b[0m')).toBe(2);
  expect(safeInputDisplay('\x1b[31m\x03')).toBe('�[31m�');
});
it('maps a cursor inside the second compact block after the first block shortened the display', () => {
  const blocks = [{id: 1, start: 2, end: 102, lineCount: 4}, {id: 2, start: 104, end: 204, lineCount: 4}];
  const display = displayCursorForValueCursor(blocks, 150);
  expect(display).toBe(2 + pastePlaceholder(blocks[0]!).length + 2 + pastePlaceholder(blocks[1]!).length);
  expect(valueCursorForDisplayCursor(blocks, display)).toBe(204);
});
