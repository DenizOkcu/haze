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
    .slice(0, 8);
  const activeSuggestionIndex = Math.min(selectedSuggestionIndex, Math.max(0, filteredSuggestions.length - 1));
  const activeSuggestion = filteredSuggestions[activeSuggestionIndex];

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
      setCursor(current => Math.max(0, current - 1));
      return;
    }

    if (key.rightArrow) {
      setCursor(current => Math.min(value.length, current + 1));
      return;
    }

    if (key.upArrow) {
      if (filteredSuggestions.length > 0 && activeSuggestionIndex > 0) {
        setSelectedSuggestionIndex(current => Math.max(0, current - 1));
        return;
      }
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
      setCursor(0);
      return;
    }

    if (key.ctrl && input === 'e') {
      setCursor(value.length);
      return;
    }

    if (key.ctrl && input === 'c') return;

    if (input) {
      replaceInput(cursor, cursor, input);
    }
  });

  const displayValue = mask ? '•'.repeat(value.length) : compactPasteBlocksForDisplay(value, pasteBlocks);
  const displayCursor = mask ? cursor : displayCursorForValueCursor(pasteBlocks, cursor);
  const beforeCursor = displayValue.slice(0, displayCursor);
  const cursorChar = displayValue[displayCursor] ?? ' ';
  const afterCursor = displayValue.slice(displayCursor + 1);

  return <Box flexDirection="column" width="100%">
    {filteredSuggestions.length > 0 && <Box flexDirection="column" marginBottom={1}>
      {filteredSuggestions.map((suggestion, index) => <Text key={suggestion.value} color={index === activeSuggestionIndex ? theme.success : theme.muted} wrap="truncate-end">
        {index === activeSuggestionIndex ? '› ' : '  '}{suggestion.value}<Text color={theme.muted}> {suggestion.kind ?? 'command'}{suggestion.description ? ` — ${suggestion.description}` : ''}</Text>
      </Text>)}
    </Box>}
    <Text wrap="truncate-end">
      <Text color={theme.purple}>› </Text>
      {value.length === 0 ? <>
        <Text inverse> </Text>
        <Text color={theme.muted} dimColor> {placeholder ?? 'Type a message...'}</Text>
      </> : <>
        {beforeCursor}
        <Text inverse>{cursorChar}</Text>
        {afterCursor}
      </>}
    </Text>
  </Box>;
}
