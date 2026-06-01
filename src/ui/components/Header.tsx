import React from 'react';
import {Box, Text} from 'ink';
import {theme} from '../theme.js';

const logo = [
  '  ██╗  ██╗ █████╗ ███████╗███████╗',
  '  ██║  ██║██╔══██╗╚══███╔╝██╔════╝',
  '  ███████║███████║  ███╔╝ █████╗  ',
  '  ██╔══██║██╔══██║ ███╔╝  ██╔══╝  ',
  '  ██║  ██║██║  ██║███████╗███████╗',
  '  ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝',
];

export function Header({subtitle}: {subtitle?: string}) {
  return <Box flexDirection="column" marginBottom={1}>
    {logo.map((line, index) => <Text key={line} color={index % 2 === 0 ? theme.purple : theme.violet} bold>{line}</Text>)}
    <Text color={theme.muted}>{subtitle ?? 'A tiny terminal fog machine for building software.'}</Text>
  </Box>;
}
