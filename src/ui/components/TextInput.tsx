import React, {useEffect, useRef, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {theme} from '../theme.js';

const COMPACT_PASTE_MIN_LINES = 4;

type PasteBlock = {
  id: number;
  start: number;
  end: number;
  lineCount: number;
};

function normalizeLineEndings(text: string) {
  return text.replace(/\r\n|\r/g, '\n');
}

function lineCount(text: string) {
  return normalizeLineEndings(text).split('\n').length;
}

function pastePlaceholder(block: PasteBlock) {
  return `[paste #${block.id} +${block.lineCount} lines]`;
}

function updatePasteBlocksForReplacement(blocks: PasteBlock[], start: number, end: number, insertedLength: number) {
  const delta = insertedLength - (end - start);
  return blocks.flatMap(block => {
    const replacesInsideBlock = start < block.end && end > block.start;
    const insertsInsideBlock = start === end && start > block.start && start < block.end;
    if (replacesInsideBlock || insertsInsideBlock) return [];
    if (block.start >= end) return [{...block, start: block.start + delta, end: block.end + delta}];
    return [block];
  });
}

function displayCursorForValueCursor(blocks: PasteBlock[], valueCursor: number) {
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

function compactPasteBlocksForDisplay(value: string, blocks: PasteBlock[]) {
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

function valueCursorForDisplayCursor(blocks: PasteBlock[], displayCursor: number) {
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

type WrappedLine = {text: string; start: number; end: number};

function wrapDisplayValue(displayValue: string, width: number): WrappedLine[] {
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

function cursorPosition(lines: WrappedLine[], displayCursor: number) {
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

export type TextInputSuggestion = {
  value: string;
  description?: string;
  kind?: 'command' | 'skill' | 'provider' | 'model';
};

export function TextInput({
  placeholder,
  disabled,
  mask,
  historyItems = [],
  recordHistory = true,
  suggestions = [],
  suggestionMode = 'slash',
  submitOnEmpty = false,
  width = 80,
  onHistoryAdd,
  onCancel,
  onEscape,
  onSubmit
}: {
  placeholder?: string;
  disabled?: boolean;
  mask?: boolean;
  historyItems?: string[];
  recordHistory?: boolean;
  suggestions?: TextInputSuggestion[];
  suggestionMode?: 'slash' | 'always';
  submitOnEmpty?: boolean;
  width?: number;
  onHistoryAdd?: (value: string) => void;
  onCancel?: () => void;
  onEscape?: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [pasteBlocks, setPasteBlocks] = useState<PasteBlock[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const history = useRef<string[]>(historyItems);
  const historyIndex = useRef<number | null>(null);
  const draft = useRef('');
  const nextPasteId = useRef(1);
  const preferredColumn = useRef<number | null>(null);

  useEffect(() => {
    history.current = historyItems;
  }, [historyItems]);

  useEffect(() => {
    if (!disabled) {
      setValue('');
      setCursor(0);
      setPasteBlocks([]);
      setSelectedSuggestionIndex(0);
      historyIndex.current = null;
      draft.current = '';
      nextPasteId.current = 1;
    }
  }, [disabled]);

  function setInput(next: string, nextCursor = next.length, nextPasteBlocks: PasteBlock[] = []) {
    preferredColumn.current = null;
    setValue(next);
    setCursor(Math.max(0, Math.min(nextCursor, next.length)));
    setPasteBlocks(nextPasteBlocks);
    setSelectedSuggestionIndex(0);
  }

  function replaceInput(start: number, end: number, inserted: string) {
    const normalizedInserted = normalizeLineEndings(inserted);
    const next = value.slice(0, start) + normalizedInserted + value.slice(end);
    const insertedLineCount = lineCount(normalizedInserted);
    const updatedPasteBlocks = updatePasteBlocksForReplacement(pasteBlocks, start, end, normalizedInserted.length);
    const insertedPasteBlock = !mask && insertedLineCount >= COMPACT_PASTE_MIN_LINES
      ? [{id: nextPasteId.current++, start, end: start + normalizedInserted.length, lineCount: insertedLineCount}]
      : [];
    setInput(next, start + normalizedInserted.length, [...updatedPasteBlocks, ...insertedPasteBlock]);
    historyIndex.current = null;
  }

  function showHistory(index: number) {
    historyIndex.current = index;
    setInput(history.current[index] ?? '');
  }

  const suggestionQuery = !mask && (suggestionMode === 'always' || value.startsWith('/'))
    ? (suggestionMode === 'always' ? value : value.slice(1)).toLowerCase()
    : undefined;
  const filteredSuggestions = suggestionQuery == null ? [] : suggestions
    .filter(suggestion => {
      const suggestionValue = suggestionMode === 'always' ? suggestion.value : suggestion.value.slice(1);
      return suggestionValue.toLowerCase().includes(suggestionQuery) || suggestion.description?.toLowerCase().includes(suggestionQuery);
    })
    .slice(0, 20);
  const activeSuggestionIndex = Math.min(selectedSuggestionIndex, Math.max(0, filteredSuggestions.length - 1));
  const activeSuggestion = filteredSuggestions[activeSuggestionIndex];
  const displayValue = mask ? '•'.repeat(value.length) : compactPasteBlocksForDisplay(value, pasteBlocks);
  const displayCursor = mask ? cursor : displayCursorForValueCursor(pasteBlocks, cursor);
  const inputWidth = Math.max(1, width - 2);
  const wrappedLines = wrapDisplayValue(displayValue, inputWidth);
  const currentCursorPosition = cursorPosition(wrappedLines, displayCursor);

  function moveCursorToDisplayPosition(nextDisplayCursor: number) {
    const clampedDisplayCursor = Math.max(0, Math.min(nextDisplayCursor, displayValue.length));
    setCursor(mask ? clampedDisplayCursor : valueCursorForDisplayCursor(pasteBlocks, clampedDisplayCursor));
  }

  function moveCursorVertically(direction: -1 | 1) {
    const targetLine = wrappedLines[currentCursorPosition.lineIndex + direction];
    if (!targetLine) return false;
    const column = preferredColumn.current ?? currentCursorPosition.column;
    preferredColumn.current = column;
    moveCursorToDisplayPosition(Math.min(targetLine.start + column, targetLine.end));
    return true;
  }

  function submitValue(submitted: string, historyValue = submitted) {
    if (recordHistory && historyValue) {
      if (history.current[history.current.length - 1] !== historyValue) history.current = [...history.current, historyValue];
      onHistoryAdd?.(historyValue);
    }
    onSubmit(submitted);
  }

  useInput((input, key) => {
    if (disabled) {
      if (key.escape) onCancel?.();
      return;
    }

    if (key.escape) {
      setInput('');
      historyIndex.current = null;
      draft.current = '';
      nextPasteId.current = 1;
      onEscape?.();
      return;
    }

    if (key.tab && activeSuggestion) {
      setInput(activeSuggestion.value);
      historyIndex.current = null;
      return;
    }

    if (key.return) {
      const shouldUseSuggestion = activeSuggestion && activeSuggestion.value !== value.trim() && (suggestionMode === 'always' || value.startsWith('/'));
      const submitted = shouldUseSuggestion ? activeSuggestion.value : value.trim();
      const submittedSuggestion = activeSuggestion?.value === submitted ? activeSuggestion : undefined;
      const historyValue = submittedSuggestion && submittedSuggestion.kind !== 'command' ? '' : submitted;
      setInput('');
      historyIndex.current = null;
      draft.current = '';
      nextPasteId.current = 1;
      if (submitted || submitOnEmpty) submitValue(submitted, historyValue);
      return;
    }

    if (key.leftArrow) {
      preferredColumn.current = null;
      setCursor(current => Math.max(0, current - 1));
      return;
    }

    if (key.rightArrow) {
      preferredColumn.current = null;
      setCursor(current => Math.min(value.length, current + 1));
      return;
    }

    if (key.upArrow) {
      if (filteredSuggestions.length > 0 && activeSuggestionIndex > 0) {
        setSelectedSuggestionIndex(current => Math.max(0, current - 1));
        return;
      }
      if (filteredSuggestions.length === 0 && moveCursorVertically(-1)) return;
      preferredColumn.current = null;
      if (history.current.length === 0) return;
      if (historyIndex.current === null) {
        draft.current = value;
        showHistory(history.current.length - 1);
      } else {
        showHistory(Math.max(0, historyIndex.current - 1));
      }
      return;
    }

    if (key.downArrow) {
      if (filteredSuggestions.length > 0 && activeSuggestionIndex < filteredSuggestions.length - 1) {
        setSelectedSuggestionIndex(current => Math.min(filteredSuggestions.length - 1, current + 1));
        return;
      }
      if (filteredSuggestions.length === 0 && moveCursorVertically(1)) return;
      preferredColumn.current = null;
      if (historyIndex.current === null) return;
      if (historyIndex.current < history.current.length - 1) {
        showHistory(historyIndex.current + 1);
      } else {
        historyIndex.current = null;
        setInput(draft.current);
      }
      return;
    }

    if (key.backspace) {
      if (cursor === 0) return;
      replaceInput(cursor - 1, cursor, '');
      return;
    }

    if (key.delete) {
      if (cursor >= value.length) return;
      replaceInput(cursor, cursor + 1, '');
      return;
    }

    if (key.ctrl && input === 'a') {
      preferredColumn.current = null;
      setCursor(0);
      return;
    }

    if (key.ctrl && input === 'e') {
      preferredColumn.current = null;
      setCursor(value.length);
      return;
    }

    if (key.ctrl && input === 'c') return;

    if (input) {
      replaceInput(cursor, cursor, input);
    }
  });

  const maxVisibleLines = 4;
  const firstVisibleLine = Math.max(0, Math.min(currentCursorPosition.lineIndex - maxVisibleLines + 1, wrappedLines.length - maxVisibleLines));
  const visibleLines = wrappedLines.slice(firstVisibleLine, firstVisibleLine + maxVisibleLines);

  return <Box flexDirection="column" width="100%">
    {filteredSuggestions.length > 0 && <Box flexDirection="column" marginBottom={1}>
      {filteredSuggestions.map((suggestion, index) => <Text key={suggestion.value} color={index === activeSuggestionIndex ? theme.success : theme.muted} wrap="truncate-end">
        {index === activeSuggestionIndex ? '› ' : '  '}{suggestion.value}<Text color={theme.muted}> {suggestion.kind ?? 'command'}{suggestion.description ? ` — ${suggestion.description}` : ''}</Text>
      </Text>)}
    </Box>}
    {value.length === 0 ? <Text wrap="truncate-end">
      <Text color={theme.purple}>› </Text>
      <Text inverse> </Text>
      <Text color={theme.muted} dimColor> {placeholder ?? 'Type a message...'}</Text>
    </Text> : visibleLines.map((line, index) => {
      const absoluteLineIndex = firstVisibleLine + index;
      const isCursorLine = absoluteLineIndex === currentCursorPosition.lineIndex;
      const lineCursor = isCursorLine ? Math.max(0, Math.min(displayCursor - line.start, line.text.length)) : -1;
      const beforeCursor = isCursorLine ? line.text.slice(0, lineCursor) : line.text;
      const cursorChar = isCursorLine ? line.text[lineCursor] ?? ' ' : '';
      const afterCursor = isCursorLine ? line.text.slice(lineCursor + 1) : '';
      return <Text key={`${line.start}-${absoluteLineIndex}`} wrap="truncate-end">
        <Text color={absoluteLineIndex === 0 ? theme.purple : theme.muted}>{absoluteLineIndex === 0 ? '› ' : '  '}</Text>
        {isCursorLine ? <>
          {beforeCursor}
          <Text inverse>{cursorChar}</Text>
          {afterCursor}
        </> : line.text}
      </Text>;
    })}
  </Box>;
}
