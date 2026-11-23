import React, {useEffect, useRef, useState} from 'react';
import {Box, Text, renderToString} from 'ink';
import {MarkdownText} from './MarkdownText.js';
import {stripTerminalControlSequences} from '../terminalSanitize.js';
import {theme} from '../theme.js';

/** Parse the whole active block before splitting its formatted terminal output into rows. */
function renderMarkdownRows(content: string, width: number): string[] {
  if (!content) return [];
  // The streaming root's text-preparation point: sanitize here, outside
  // React's render/commit phases, so a delta quoting OSC 52/CSI/C1 bytes never
  // reaches the terminal through the live preview rows (R2-HZ-4). Idempotent
  // with the per-root pass inside MarkdownText itself.
  const output = renderToString(<MarkdownText content={stripTerminalControlSequences(content)} width={width} />, {columns: Math.max(1, width)});
  // Block margins belong to the settled transcript, not the bottom of a live
  // preview. Keep internal blank rows, but do not let a trailing margin hide
  // the newest content in a small viewport.
  return output.replace(/\n[\s]*$/, '').split('\n');
}

/**
 * Streaming deltas are throttled to one offscreen render per window: the first
 * delta of a window renders promptly, later ones are folded into its trailing
 * render (FE-05).
 */
const COALESCE_MS = 16;

/** The active block remains replaceable; only settled roots belong in Static. */
export const StreamingMarkdownText = React.memo(function StreamingMarkdownText({content, width, maxVisibleLines, streaming = true}: {
  content: string;
  width: number;
  maxVisibleLines?: number;
  /** While streaming, deltas are coalesced; settled text renders without delay. */
  streaming?: boolean;
}) {
  const [rendered, setRendered] = useState<{content: string; width: number; rows: string[]}>({content: '', width, rows: []});
  const latest = useRef({content, width});
  latest.current = {content, width};
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastRenderAt = useRef(0);
  useEffect(() => {
    // Ink's synchronous offscreen renderer must run outside React's render and
    // commit phases, which this effect body is. A burst of deltas inside one
    // window costs at most two renders: the window's leading render and one
    // trailing render that reads the latest text when the timer fires (FE-05).
    const renderLatest = () => {
      pendingTimer.current = undefined;
      lastRenderAt.current = Date.now();
      const {content, width} = latest.current;
      setRendered({content, width, rows: renderMarkdownRows(content, width)});
    };
    if (!streaming) {
      // Settled text never waits for the window.
      clearTimeout(pendingTimer.current);
      pendingTimer.current = undefined;
    }
    if (pendingTimer.current === undefined) {
      const remaining = streaming ? COALESCE_MS - (Date.now() - lastRenderAt.current) : 0;
      if (remaining <= 0) {
        let cancelled = false;
        queueMicrotask(() => { if (!cancelled) renderLatest(); });
        return () => { cancelled = true; };
      }
      pendingTimer.current = setTimeout(renderLatest, remaining);
    }
  }, [content, width, streaming]);
  useEffect(() => () => clearTimeout(pendingTimer.current), []);

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
