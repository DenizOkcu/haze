import React, {useEffect, useRef, useState} from 'react';
import {Box, Text, measureElement, useCursor, useInput, useIsScreenReaderEnabled, usePaste, type DOMElement} from 'ink';
import {cellWidth, graphemes, nextBoundary, offsetAtColumn, previousBoundary, safeInputDisplay} from '../textGeometry.js';
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
import {WizardChoices} from './WizardChoices.js';

const COMPACT_PASTE_MIN_LINES = 4;

// Enhanced-keyboard encodings of Enter with modifiers that some terminals emit
// verbatim (kitty/CSI-u `u` form and xterm modifyOtherKeys `~` form). Ink's
// keypress parser already resolves the CSI-u variants to `key.return` plus the
// modifier flags before TextInput sees them; these entries cover pipelines that
// deliver the raw sequence through `input`.
const NEWLINE_ESCAPE_INPUTS = new Set([
  '\u001B[13;2u', // shift+enter (kitty protocol / modifyOtherKeys=2)
  '\u001B[13;2~', // shift+enter (xterm modifyOtherKeys=1)
  '\u001B[13;5u', // ctrl+enter (kitty protocol / modifyOtherKeys=2)
  '\u001B[13;5~', // ctrl+enter (xterm modifyOtherKeys=1)
]);

type TextInputKey = {return?: boolean; shift?: boolean; ctrl?: boolean; meta?: boolean};

export function shouldInsertNewline(input: string, key: TextInputKey) {
  return (key.return === true && (key.shift === true || key.ctrl === true || key.meta === true))
    || input === '\n'
    || NEWLINE_ESCAPE_INPUTS.has(input);
}

/**
 * Ctrl+C terminate check. Legacy terminals deliver the raw \x03 byte (Ink
 * parses it to `c` + ctrl); with the kitty keyboard protocol enabled the
 * terminal reports `CSI 99;5u`, which parses to the same `c` + ctrl shape.
 * Ink 7.1.1's built-in exit-on-CtrlC only recognizes the raw \x03 event, so
 * haze owns the interrupt explicitly (render runs with exitOnCtrlC: false).
 */
export function isInterruptInput(input: string, key: TextInputKey) {
  return (input === 'c' && key.ctrl === true) || input === '\x03';
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
  inputRows = 4,
  suggestionRows = 6,
  onRowsChange,
  getMentionSuggestions,
  onHistoryAdd,
  onCancel,
  onEscape,
  onToggleTasks,
  onResumeKey,
  onInterrupt,
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
  inputRows?: number;
  suggestionRows?: number;
  onRowsChange?: (demand: {input: number; suggestions: number}) => void;
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
  /**
   * Ctrl+C terminate: called for the parsed `c`+ctrl shape shared by the
   * legacy \x03 byte and the kitty-protocol `CSI 99;5u` report. Runs even
   * while the input is disabled (streaming), matching the terminal-wide
   * terminate convention Ink's global handler used to provide.
   */
  onInterrupt?: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [pasteBlocks, setPasteBlocks] = useState<PasteBlock[]>([]);
  // IME support (Ink 8): position the real terminal cursor at the editing
  // point so composing text (CJK input methods) appears where the user is
  // looking instead of at the frame bottom. Measured after layout commits.
  const cursorHostRef = useRef<DOMElement>(null);
  const {setCursorPosition} = useCursor();
  // The terminal cursor position for IME composition must use frame-origin
  // coordinates (Ink's cursor basis). `useBoxMetrics`' left/top are
  // parent-relative — (0,0) here, since this box sits inside DynamicFrame's
  // bordered, padded input box — which pinned the hardware cursor one row
  // above the input and cells behind the editing point. `measureElement()`
  // accumulates ancestor offsets into frame coordinates; it is read after
  // commit, when Yoga layout is final. The ref targets the input-line box (not
  // the whole host), so suggestion rows rendered above it are already included
  // in the measured origin.
  const [inputOrigin, setInputOrigin] = useState<{x: number; y: number}>();
  useEffect(() => {
    const node = cursorHostRef.current;
    if (!node) return;
    const {x, y} = measureElement(node);
    setInputOrigin(previous => previous && previous.x === x && previous.y === y ? previous : {x, y});
  });
  const screenReaderEnabled = useIsScreenReaderEnabled();
  const history = useRef<string[]>(historyItems);
  const historyIndex = useRef<number | null>(null);
  const draft = useRef('');
  const nextPasteId = useRef(1);
  const preferredColumn = useRef<number | null>(null);
  const inputRef = useRef({value, cursor, pasteBlocks});
  inputRef.current = {value, cursor, pasteBlocks};

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
    const clampedCursor = Math.max(0, Math.min(nextCursor, next.length));
    inputRef.current = {value: next, cursor: clampedCursor, pasteBlocks: nextPasteBlocks};
    setValue(next);
    setCursor(clampedCursor);
    setPasteBlocks(nextPasteBlocks);
    suggestionLayers.resetSelection();
  }

  function replaceInput(start: number, end: number, inserted: string) {
    const normalizedInserted = normalizeLineEndings(inserted);
    const current = inputRef.current;
    const next = current.value.slice(0, start) + normalizedInserted + current.value.slice(end);
    const insertedLineCount = lineCount(normalizedInserted);
    const updatedPasteBlocks = updatePasteBlocksForReplacement(current.pasteBlocks, start, end, normalizedInserted.length);
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

  const valueGraphemes = mask ? graphemes(value) : [];
  const displayValue = mask ? '•'.repeat(valueGraphemes.length) : safeInputDisplay(compactPasteBlocksForDisplay(value, pasteBlocks));
  const displayCursor = mask ? valueGraphemes.filter(part => part.end <= cursor).length : displayCursorForValueCursor(pasteBlocks, cursor);
  // Leave a cell for the end-of-line cursor, even on a completely full draft.
  const inputWidth = Math.max(1, width - (width > 2 ? 2 : 0) - 1);
  const wrappedLines = wrapDisplayValue(displayValue, inputWidth);
  const currentCursorPosition = cursorPosition(wrappedLines, displayCursor);

  function moveValueCursor(nextCursor: number) {
    inputRef.current.cursor = nextCursor;
    setCursor(nextCursor);
  }

  function moveCursorToDisplayPosition(nextDisplayCursor: number) {
    const clampedDisplayCursor = Math.max(0, Math.min(nextDisplayCursor, displayValue.length));
    moveValueCursor(mask ? (valueGraphemes[clampedDisplayCursor]?.start ?? value.length) : valueCursorForDisplayCursor(pasteBlocks, clampedDisplayCursor));
  }

  function moveCursorVertically(direction: -1 | 1) {
    const targetLine = wrappedLines[currentCursorPosition.lineIndex + direction];
    if (!targetLine) return false;
    const column = preferredColumn.current ?? currentCursorPosition.column;
    preferredColumn.current = column;
    moveCursorToDisplayPosition(targetLine.start + offsetAtColumn(targetLine.text, column));
    return true;
  }

  function submitValue(submitted: string, historyValue = submitted) {
    if (recordHistory && !mask && historyValue) {
      if (history.current[history.current.length - 1] !== historyValue) history.current = [...history.current, historyValue];
      onHistoryAdd?.(historyValue);
    }
    onSubmit(submitted);
  }

  // Always subscribe: disabled paste is discarded, never re-routed as shortcuts.
  usePaste(text => {
    if (disabled) return;
    const current = inputRef.current;
    replaceInput(current.cursor, current.cursor, text);
  });

  useInput((input, key) => {
    const {value, cursor} = inputRef.current;

    if (isInterruptInput(input, key)) {
      onInterrupt?.();
      return;
    }

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
      moveValueCursor(previousBoundary(value, cursor));
      return;
    }

    if (key.rightArrow) {
      preferredColumn.current = null;
      moveValueCursor(nextBoundary(value, cursor));
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
      replaceInput(previousBoundary(value, cursor), cursor, '');
      return;
    }

    if (key.delete) {
      if (cursor >= value.length) return;
      replaceInput(cursor, nextBoundary(value, cursor), '');
      return;
    }

    if (key.ctrl && input === 'a') {
      preferredColumn.current = null;
      moveValueCursor(0);
      return;
    }

    if (key.ctrl && input === 'e') {
      preferredColumn.current = null;
      moveValueCursor(value.length);
      return;
    }

    if (key.ctrl && input === 'o') {
      onToggleTasks?.();
      return;
    }

    if (key.ctrl) return; // Unsupported Ctrl combinations are controls, not text.
    if (input) {
      replaceInput(inputRef.current.cursor, inputRef.current.cursor, input);
    }
  });

  const maxVisibleLines = Math.max(1, inputRows);
  const firstVisibleLine = Math.max(0, Math.min(currentCursorPosition.lineIndex - maxVisibleLines + 1, wrappedLines.length - maxVisibleLines));
  const visibleLines = wrappedLines.slice(firstVisibleLine, firstVisibleLine + maxVisibleLines);

  // Terminal cursor coordinates at the editing point: the input-line box's
  // frame-origin position (measureElement) plus the `› ` prefix and the cell
  // width of the text before the cursor (grapheme-safe via textGeometry).
  let imeCursor: {x: number; y: number} | undefined;
  if (!disabled && !screenReaderEnabled && inputOrigin) {
    const visibleRow = currentCursorPosition.lineIndex - firstVisibleLine;
    const line = wrappedLines[currentCursorPosition.lineIndex];
    if (value.length === 0) {
      imeCursor = {x: inputOrigin.x + (width > 2 ? 2 : 0), y: inputOrigin.y};
    } else if (line && visibleRow >= 0 && visibleRow < visibleLines.length) {
      const lineCursorOffset = Math.max(0, Math.min(displayCursor - line.start, line.text.length));
      imeCursor = {
        x: inputOrigin.x + (width > 2 ? 2 : 0) + cellWidth(line.text.slice(0, lineCursorOffset)),
        y: inputOrigin.y + visibleRow,
      };
    }
  }
  setCursorPosition(imeCursor);
  const displayList = inMentionMode ? mentionList : filteredSuggestions;
  const displayActiveIndex = inMentionMode ? activeMentionIndex : activeSuggestionIndex;
  const suggestionStart = Math.max(0, displayActiveIndex - Math.max(0, suggestionRows - 1));
  const visibleSuggestions = displayList.slice(suggestionStart, suggestionStart + suggestionRows);
  const wantedInputRows = Math.min(4, wrappedLines.length);
  const wantedSuggestionRows = Math.min(5, displayList.length);
  useEffect(() => {
    onRowsChange?.({input: wantedInputRows, suggestions: wantedSuggestionRows});
  }, [onRowsChange, wantedInputRows, wantedSuggestionRows]);

  return <Box flexDirection="column" width="100%">
    {suggestionMode === 'always' ? <WizardChoices
      suggestions={displayList} activeIndex={displayActiveIndex} rows={suggestionRows} /> : visibleSuggestions.length > 0 && <Box flexDirection="column">
      {visibleSuggestions.map((suggestion, index) => <Text key={suggestion.value} color={index + suggestionStart === displayActiveIndex ? theme.success : theme.muted} wrap="truncate-end">
        {index + suggestionStart === displayActiveIndex ? '› ' : '  '}{suggestion.value}<Text color={theme.muted}> {suggestion.kind ?? 'command'}{suggestion.description ? ` — ${suggestion.description}` : ''}</Text>
      </Text>)}
    </Box>}
    <Box ref={cursorHostRef} flexDirection="column" width="100%">
    {value.length === 0 ? <Text wrap="truncate-end">
<Text color={theme.accent}>{width > 2 ? '› ' : ''}</Text>
      <Text inverse> </Text>
      <Text color={theme.muted}> {placeholder ?? 'Type a message...'}</Text>
    </Text> : visibleLines.map((line, index) => {
      const absoluteLineIndex = firstVisibleLine + index;
      const isCursorLine = absoluteLineIndex === currentCursorPosition.lineIndex;
      const lineCursor = isCursorLine ? Math.max(0, Math.min(displayCursor - line.start, line.text.length)) : -1;
      const beforeCursor = isCursorLine ? line.text.slice(0, lineCursor) : line.text;
      const cursorEnd = nextBoundary(line.text, lineCursor);
      const cursorChar = isCursorLine ? line.text.slice(lineCursor, cursorEnd) || ' ' : '';
      const afterCursor = isCursorLine ? line.text.slice(cursorEnd) : '';
      return <Text key={`${line.start}-${absoluteLineIndex}`} wrap="truncate-end">
<Text color={theme.accent}>{width > 2 ? (absoluteLineIndex === 0 ? '› ' : '  ') : ''}</Text>
        {isCursorLine ? <>
          {width > 2 ? beforeCursor : ''}
          <Text inverse>{cellWidth(cursorChar) > inputWidth ? '�' : cursorChar}</Text>
          {width > 2 ? afterCursor : ''}
        </> : cellWidth(line.text) > inputWidth ? '�' : line.text}
      </Text>;
    })}
    </Box>
  </Box>;
}
