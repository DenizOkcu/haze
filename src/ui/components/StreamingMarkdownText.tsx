import React, {useEffect, useState} from 'react';
import {Box, Text, renderToString} from 'ink';
import {MarkdownText} from './MarkdownText.js';
import {theme} from '../theme.js';

/** Parse the whole active block before splitting its formatted terminal output into rows. */
export function renderMarkdownRows(content: string, width: number): string[] {
  if (!content) return [];
  const output = renderToString(<MarkdownText content={content} width={width} />, {columns: Math.max(1, width)});
  // Block margins belong to the settled transcript, not the bottom of a live
  // preview. Keep internal blank rows, but do not let a trailing margin hide
  // the newest content in a small viewport.
  return output.replace(/\n[\s]*$/, '').split('\n');
}

/** The active block remains replaceable; only settled roots belong in Static. */
export const StreamingMarkdownText = React.memo(function StreamingMarkdownText({content, width, maxVisibleLines}: {
  content: string;
  width: number;
  maxVisibleLines?: number;
}) {
  const [rendered, setRendered] = useState<{content: string; width: number; rows: string[]}>({content: '', width, rows: []});
  // Ink's synchronous offscreen renderer must run outside React's render and
  // commit phases. The microtask also lets superseded deltas cancel their work.
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setRendered({content, width, rows: renderMarkdownRows(content, width)});
    });
    return () => { cancelled = true; };
  }, [content, width]);

  // Never replay a previous root after it enters Static, or show stale, wider
  // rows during a terminal resize. Append-only deltas can retain their preview.
  const rows = rendered.width === width && content.startsWith(rendered.content) ? rendered.rows : [];
  const budget = maxVisibleLines == null ? rows.length : Math.max(0, Math.floor(maxVisibleLines));
  if (budget === 0) return null;
  const hidden = rows.length > budget ? rows.length - Math.max(0, budget - 1) : 0;
  const visible = hidden ? rows.slice(hidden) : rows;
  return <Box flexDirection="column" flexShrink={0}>
    {hidden > 0 ? <Text color={theme.muted} wrap="truncate-end">{`⋯ +${hidden} line${hidden === 1 ? '' : 's'} above`}</Text> : null}
    {visible.map((row, index) => <Text key={hidden + index} wrap="truncate-end">{row || ' '}</Text>)}
  </Box>;
});
