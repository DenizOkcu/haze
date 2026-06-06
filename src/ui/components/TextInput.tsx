import React, {useEffect, useRef, useState} from 'react';
import {Box, Text, useInput} from 'ink';
import {theme} from '../theme.js';

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
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const history = useRef<string[]>(historyItems);
  const historyIndex = useRef<number | null>(null);
  const draft = useRef('');

  useEffect(() => {
    history.current = historyItems;
  }, [historyItems]);

  useEffect(() => {
    if (!disabled) {
      setValue('');
      setCursor(0);
      setSelectedSuggestionIndex(0);
      historyIndex.current = null;
      draft.current = '';
    }
  }, [disabled]);

  function setInput(next: string, nextCursor = next.length) {
    setValue(next);
    setCursor(Math.max(0, Math.min(nextCursor, next.length)));
    setSelectedSuggestionIndex(0);
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
      setInput(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      historyIndex.current = null;
      return;
    }

    if (key.delete) {
      if (cursor >= value.length) return;
      setInput(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
      historyIndex.current = null;
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
      setInput(value.slice(0, cursor) + input + value.slice(cursor), cursor + input.length);
      historyIndex.current = null;
    }
  });

  const displayValue = mask ? '•'.repeat(value.length) : value;
  const beforeCursor = displayValue.slice(0, cursor);
  const cursorChar = displayValue[cursor] ?? ' ';
  const afterCursor = displayValue.slice(cursor + 1);

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
