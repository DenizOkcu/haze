import React from 'react';
import {Box, Text} from 'ink';
import {theme} from '../theme.js';

export function Header({subtitle, version}: {subtitle?: string; version?: string}) {
  return <Box flexDirection="column" marginBottom={1}>
    <Box>
      <Text color={theme.purple} bold>haze</Text>
      {version ? <Text color={theme.muted}> v{version}</Text> : null}
    </Box>
    <Text> </Text>
    <Text color={theme.muted}>{subtitle ?? 'A tiny terminal fog machine for building software.'}</Text>
  </Box>;
}
