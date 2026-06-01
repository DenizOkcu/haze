import React from 'react';
import {Box, Text} from 'ink';
import {theme} from '../theme.js';

const logo = [
  '  _                   ',
  ' | |                  ',
  ' | |__   __ _ _______ ',
  " | '_ \\ / _` |_  / _ \\",
  ' | | | | (_| |/ /  __/',
  ' |_| |_|\\__,_/___\\___|',
];

export function Header({subtitle, version}: {subtitle?: string; version?: string}) {
  return <Box flexDirection="column" marginBottom={1}>
    {logo.map((line, index) => index === logo.length - 1
      ? <Box key={line}>
        <Text color={index % 2 === 0 ? theme.purple : theme.violet} bold>{line}</Text>
        {version ? <Text color={theme.muted}> v{version}</Text> : null}
      </Box>
      : <Text key={line} color={index % 2 === 0 ? theme.purple : theme.violet} bold>{line}</Text>)}
    <Text> </Text>
    <Text color={theme.muted}>{subtitle ?? 'A tiny terminal fog machine for building software.'}</Text>
  </Box>;
}
