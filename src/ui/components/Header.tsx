import React from 'react';
import {Box, Text} from 'ink';
import {theme} from '../theme.js';

export function Header({subtitle}: {subtitle?: string}) {
  return <Box flexDirection="column" marginBottom={1}>
    <Text color={theme.purple} bold>Haze</Text>
    {subtitle ? <Text color={theme.muted}>{subtitle}</Text> : <Text color={theme.muted}>A small agent, because apparently that is allowed.</Text>}
  </Box>;
}
