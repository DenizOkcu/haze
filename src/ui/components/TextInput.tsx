import React, {useEffect, useRef, useState} from 'react';
import {Text, useInput} from 'ink';
import {theme} from '../theme.js';

export function TextInput({
  placeholder,
  disabled,
  mask,
  historyItems = [],
  recordHistory = true,
  onHistoryAdd,
  onCancel,
  onSubmit
}: {
  placeholder?: string;
  disabled?: boolean;
  mask?: boolean;
  historyItems?: string[];
  recordHistory?: boolean;
  onHistoryAdd?: (value: string) => void;
  onCancel?: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
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
      historyIndex.current = null;
      draft.current = '';
    }
  }, [disabled]);

  function setInput(next: string, nextCursor = next.length) {
    setValue(next);
    setCursor(Math.max(0, Math.min(nextCursor, next.length)));
  }

  function showHistory(index: number) {
    historyIndex.current = index;
    setInput(history.current[index] ?? '');
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
      return;
    }

    if (key.return) {
      const submitted = value.trim();
      setInput('');
      historyIndex.current = null;
      draft.current = '';
      if (submitted) {
        if (recordHistory) {
          if (history.current[history.current.length - 1] !== submitted) history.current = [...history.current, submitted];
          onHistoryAdd?.(submitted);
        }
        onSubmit(submitted);
      }
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

  return <Text wrap="truncate-end">
    <Text color={theme.purple}>› </Text>
    {value.length === 0 ? <>
      <Text inverse> </Text>
      <Text color={theme.muted}> {placeholder ?? 'Type a message...'}</Text>
    </> : <>
      {beforeCursor}
      <Text inverse>{cursorChar}</Text>
      {afterCursor}
    </>}
  </Text>;
}
