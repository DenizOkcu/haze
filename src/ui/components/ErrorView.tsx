import React from 'react';
import {Text} from 'ink';
import {theme} from '../theme.js';

export function ErrorView({error}: {error: unknown}) {
  const message = error instanceof Error ? error.message : String(error);
  return <Text color={theme.danger}>Error: {message}</Text>;
}
