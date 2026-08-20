import React, {useEffect, useRef, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {theme} from '../theme.js';
import {
  compactPasteBlocksForDisplay,
  cursorPosition,
  displayCursorForValueCursor,
  lineCount,
  normalizeLineEndings,
  updatePasteBlocksForReplacement,
  valueCursorForDisplayCursor,
  wrapDisplayValue,
  type PasteBlock,
} from '../inputBuffer.js';
import {useInputSuggestions} from './useInputSuggestions.js';

const COMPACT_PASTE_MIN_LINES = 4;

const CTRL_ENTER_ESCAPE_INPUTS = new Set(['\u001B[13;5u', '\u001B[13;5~']);

type TextInputKey = {return?: boolean; shift?: boolean; ctrl?: boolean};

export function shouldInsertNewline(input: string, key: TextInputKey) {
  return (key.return === true && (key.shift === true || key.ctrl === true))
    || input === '\n'
    || CTRL_ENTER_ESCAPE_INPUTS.has(input);
}

export type TextInputSuggestion = {
  value: string;
  description?: string;
  kind?: 'command' | 'skill' | 'provider' | 'model' | 'lsp' | 'mcp' | 'session' | 'file' | 'theme';
};

/** Cursor-aware path completer for `@token` mentions; receives the token verbatim. */
export type MentionSuggestionsProvider = (token: string) => Promise<TextInputSuggestion[]> | TextInputSuggestion[];

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
  getMentionSuggestions,
  onHistoryAdd,
  onCancel,
  onEscape,
  onToggleTasks,
  onResumeKey,
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
  getMentionSuggestions?: MentionSuggestionsProvider;
  onHistoryAdd?: (value: string) => void;
  onCancel?: () => void;
  onEscape?: () => void;
  onToggleTasks?: () => void;
  /**
   * One-key resume affordance: when provided and the input is empty, a bare
   * R/R resumes the paused task instead of typing the character. The caller
   * (chat) only provides it while a paused turn is pending and renders the
   * matching hint line, so ordinary typing is unaffected.
   */
  onResumeKey?: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [pasteBlocks, setPasteBlocks] = useState<PasteBlock[]>([]);
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
      historyIndex.current = null;
      draft.current = '';
      nextPasteId.current = 1;
    }
  }, [disabled]);

  const suggestionLayers = useInputSuggestions({value, cursor, suggestions, suggestionMode, mask, getMentionSuggestions});
  const {detectedMention, inMentionMode, filteredSuggestions, mentionList, activeMentionIndex, activeSuggestionIndex, activeSuggestion} = suggestionLayers;

  function setInput(next: string, nextCursor = next.length, nextPasteBlocks: PasteBlock[] = []) {
    preferredColumn.current = null;
    setValue(next);
    setCursor(Math.max(0, Math.min(nextCursor, next.length)));
    setPasteBlocks(nextPasteBlocks);
    suggestionLayers.resetSelection();
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

    if (onResumeKey && value.length === 0 && !key.ctrl && !key.meta && (input === 'r' || input === 'R')) {
      onResumeKey();
      return;
    }

    if (key.tab && activeSuggestion) {
      if (inMentionMode && detectedMention) {
        // Partial replacement of the `@token` range, not the whole input —
        // mention completion fires mid-prompt.
        replaceInput(detectedMention.start, detectedMention.end, activeSuggestion.value);
        historyIndex.current = null;
        return;
      }
      setInput(activeSuggestion.value);
      historyIndex.current = null;
      return;
    }

    if (shouldInsertNewline(input, key)) {
      replaceInput(cursor, cursor, '\n');
      return;
    }

    if (key.return) {
      // Mention mode: complete the `@token` range before submitting, so
      // pressing Enter on `read @packa` with `@package.json` highlighted
      // submits `read @package.json` (matches slash-command behavior).
      let submittedValue: string;
      let submittedSuggestion: TextInputSuggestion | undefined;
      if (inMentionMode && detectedMention && activeSuggestion && activeSuggestion.value !== detectedMention.token) {
        submittedValue = value.slice(0, detectedMention.start) + activeSuggestion.value + value.slice(detectedMention.end);
        submittedSuggestion = activeSuggestion;
      } else {
        const shouldUseSuggestion = !!activeSuggestion && activeSuggestion.value !== value.trim() && (suggestionMode === 'always' || value.startsWith('/'));
        submittedValue = shouldUseSuggestion && activeSuggestion ? activeSuggestion.value : value;
        submittedSuggestion = shouldUseSuggestion ? activeSuggestion : undefined;
      }
      const submitted = submittedValue.trim();
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
      if (suggestionLayers.moveSelection(-1)) return;
      if (filteredSuggestions.length === 0 && !inMentionMode && moveCursorVertically(-1)) return;
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
      if (suggestionLayers.moveSelection(1)) return;
      if (filteredSuggestions.length === 0 && !inMentionMode && moveCursorVertically(1)) return;
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

    if (key.ctrl && input === 'o') {
      onToggleTasks?.();
      return;
    }

    if (input) {
      replaceInput(cursor, cursor, input);
    }
  });

  const maxVisibleLines = 4;
  const firstVisibleLine = Math.max(0, Math.min(currentCursorPosition.lineIndex - maxVisibleLines + 1, wrappedLines.length - maxVisibleLines));
  const visibleLines = wrappedLines.slice(firstVisibleLine, firstVisibleLine + maxVisibleLines);
  const displayList = inMentionMode ? mentionList : filteredSuggestions;
  const displayActiveIndex = inMentionMode ? activeMentionIndex : activeSuggestionIndex;

  return <Box flexDirection="column" width="100%">
    {displayList.length > 0 && <Box flexDirection="column" marginBottom={1}>
      {displayList.map((suggestion, index) => <Text key={suggestion.value} color={index === displayActiveIndex ? theme.success : theme.muted} wrap="truncate-end">
        {index === displayActiveIndex ? '› ' : '  '}{suggestion.value}<Text color={theme.muted}> {suggestion.kind ?? 'command'}{suggestion.description ? ` — ${suggestion.description}` : ''}</Text>
      </Text>)}
    </Box>}
    {value.length === 0 ? <Text wrap="truncate-end">
<Text color={theme.accent}>› </Text>
      <Text inverse> </Text>
      <Text color={theme.muted}> {placeholder ?? 'Type a message...'}</Text>
    </Text> : visibleLines.map((line, index) => {
      const absoluteLineIndex = firstVisibleLine + index;
      const isCursorLine = absoluteLineIndex === currentCursorPosition.lineIndex;
      const lineCursor = isCursorLine ? Math.max(0, Math.min(displayCursor - line.start, line.text.length)) : -1;
      const beforeCursor = isCursorLine ? line.text.slice(0, lineCursor) : line.text;
      const cursorChar = isCursorLine ? line.text[lineCursor] ?? ' ' : '';
      const afterCursor = isCursorLine ? line.text.slice(lineCursor + 1) : '';
      return <Text key={`${line.start}-${absoluteLineIndex}`} wrap="truncate-end">
<Text color={theme.accent}>{absoluteLineIndex === 0 ? '› ' : '  '}</Text>
        {isCursorLine ? <>
          {beforeCursor}
          <Text inverse>{cursorChar}</Text>
          {afterCursor}
        </> : line.text}
      </Text>;
    })}
  </Box>;
}
