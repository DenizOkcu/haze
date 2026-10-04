import React from 'react';
import {Box, Text} from 'ink';
import {ActivitySpinner} from '../../ui/components/NativeIndicators.js';
import {theme} from '../../ui/theme.js';

/** Spinner ticks stay within this subtree, not the transcript orchestrator. */
export function BusyBar({label, elapsed, tip}: {label: string; elapsed: string; tip?: string}) {
  return <Box flexDirection="column" flexShrink={0}>
    <Box overflow="hidden">
      <ActivitySpinner />
      <Box flexShrink={0} width={1} />
      <Text wrap="truncate-end"><Text color={theme.command} bold>{label}{elapsed ? <Text color={theme.muted}> · {elapsed}</Text> : null}</Text><Text color={theme.muted}> · type to queue follow-up · esc to interrupt</Text></Text>
    </Box>
    {tip && <Text color={theme.muted} wrap="truncate-end"><Text bold>Tip:</Text> {tip}</Text>}
  </Box>;
}
