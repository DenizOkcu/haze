export type PasteBlock = {
  id: number;
  start: number;
  end: number;
  lineCount: number;
};

export type WrappedLine = {text: string; start: number; end: number};

export function normalizeLineEndings(text: string) {
  return text.replace(/\r\n|\r/g, '\n');
}

export function lineCount(text: string) {
  return normalizeLineEndings(text).split('\n').length;
}

export function pastePlaceholder(block: PasteBlock) {
  return `[paste #${block.id} +${block.lineCount} lines]`;
}

export function updatePasteBlocksForReplacement(blocks: PasteBlock[], start: number, end: number, insertedLength: number) {
  const delta = insertedLength - (end - start);
  return blocks.flatMap(block => {
    const replacesInsideBlock = start < block.end && end > block.start;
    const insertsInsideBlock = start === end && start > block.start && start < block.end;
    if (replacesInsideBlock || insertsInsideBlock) return [];
    if (block.start >= end) return [{...block, start: block.start + delta, end: block.end + delta}];
    return [block];
  });
}

export function displayCursorForValueCursor(blocks: PasteBlock[], valueCursor: number) {
  let displayCursor = valueCursor;
  for (const block of [...blocks].sort((a, b) => a.start - b.start)) {
    const placeholderLength = pastePlaceholder(block).length;
    const compactedLength = block.end - block.start - placeholderLength;
    if (valueCursor <= block.start) break;
    if (valueCursor < block.end) return block.start + placeholderLength;
    displayCursor -= compactedLength;
  }
  return displayCursor;
}

export function compactPasteBlocksForDisplay(value: string, blocks: PasteBlock[]) {
  if (blocks.length === 0) return value;
  let displayValue = '';
  let offset = 0;
  for (const block of [...blocks].sort((a, b) => a.start - b.start)) {
    displayValue += value.slice(offset, block.start);
    displayValue += pastePlaceholder(block);
    offset = block.end;
  }
  displayValue += value.slice(offset);
  return displayValue;
}

export function valueCursorForDisplayCursor(blocks: PasteBlock[], displayCursor: number) {
  let valueCursor = displayCursor;
  let displayOffset = 0;
  for (const block of [...blocks].sort((a, b) => a.start - b.start)) {
    const placeholderLength = pastePlaceholder(block).length;
    const displayStart = block.start - displayOffset;
    const displayEnd = displayStart + placeholderLength;
    if (displayCursor <= displayStart) break;
    if (displayCursor <= displayEnd) return block.end;
    const compactedLength = block.end - block.start - placeholderLength;
    valueCursor += compactedLength;
    displayOffset += compactedLength;
  }
  return valueCursor;
}

export function wrapDisplayValue(displayValue: string, width: number): WrappedLine[] {
  const wrapWidth = Math.max(1, width);
  const lines: WrappedLine[] = [];
  let start = 0;
  let text = '';
  for (let index = 0; index < displayValue.length; index += 1) {
    const char = displayValue[index]!;
    if (char === '\n') {
      lines.push({text, start, end: index});
      start = index + 1;
      text = '';
      continue;
    }
    if (text.length >= wrapWidth) {
      lines.push({text, start, end: index});
      start = index;
      text = '';
    }
    text += char;
  }
  lines.push({text, start, end: displayValue.length});
  return lines;
}

export function cursorPosition(lines: WrappedLine[], displayCursor: number) {
  const foundIndex = lines.findIndex((line, index) => {
    const isLast = index === lines.length - 1;
    if (line.start === line.end) return displayCursor === line.start;
    const nextLineStartsAfterNewline = lines[index + 1]?.start === line.end + 1;
    return displayCursor >= line.start && (displayCursor < line.end || (nextLineStartsAfterNewline && displayCursor === line.end) || (isLast && displayCursor <= line.end));
  });
  const lineIndex = Math.max(0, foundIndex);
  const line = lines[lineIndex] ?? lines[0] ?? {start: 0, end: 0};
  return {lineIndex, column: Math.max(0, Math.min(displayCursor - line.start, line.end - line.start))};
}
