import React, {useEffect, useState} from 'react';
import {Text, useInput} from 'ink';
import {theme} from '../theme.js';

export function TextInput({
  placeholder,
  disabled,
  mask,
  onSubmit
}: {
  placeholder?: string;
  disabled?: boolean;
  mask?: boolean;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState('');

  useEffect(() => {
    if (!disabled) setValue('');
  }, [disabled]);

  useInput((input, key) => {
    if (disabled) return;
    if (key.return) {
      const submitted = value.trim();
      setValue('');
      if (submitted) onSubmit(submitted);
      return;
    }
    if (key.backspace || key.delete) {
      setValue(current => current.slice(0, -1));
      return;
    }
    if (key.ctrl && input === 'c') return;
    if (input) setValue(current => current + input);
  });

  const rendered = value ? (mask ? '•'.repeat(value.length) : value) : <Text color={theme.muted}>{placeholder ?? 'Type a message...'}</Text>;
  return <Text><Text color={theme.purple}>› </Text>{rendered}</Text>;
}
