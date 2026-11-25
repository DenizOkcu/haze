import {Box, Text} from 'ink';
import {MessageView} from './messages.js';
import type {TranscriptStreamingItem} from './transcriptPartition.js';
import {theme} from '../../ui/theme.js';

/**
 * The dynamic tail's streaming items, clamped to the live-region row budget.
 * Items beyond the budget are not dropped silently: one indicator row counts
 * them, so parallel work that is temporarily out of view stays visible (FE-06).
 */
export function LiveTail({items, width, rows}: {items: TranscriptStreamingItem[]; width: number; rows: number}) {
  if (rows <= 0 || items.length === 0) return null;
  // Allocate the sum, not a positive minimum for every pending item.
  let count = Math.min(items.length, Math.floor(rows / 2));
  const hidden = items.length - count;
  if (hidden > 0) {
    // The indicator takes one row; give up an item rather than squeeze the
    // remaining ones below a readable two rows (header or content plus one row).
    const available = rows - 1;
    while (count > 0 && Math.floor(available / count) < 2) count -= 1;
  }
  const itemRows = count > 0 ? Math.floor((rows - (hidden > 0 ? 1 : 0)) / count) : 0;
  // Keep the newest items: the last one is the active message being streamed.
  return <Box flexDirection="column">
    {hidden > 0 ? <Text color={theme.muted} wrap="truncate-end">{`+${items.length - count} more`}</Text> : null}
    {items.slice(items.length - count).map(item => <Box key={item.key} maxHeight={itemRows} flexShrink={0} overflow="hidden">
      <MessageView message={item.message} width={width} showHeader={item.showHeader} maxVisibleLines={itemRows - 1} />
    </Box>)}
  </Box>;
}
