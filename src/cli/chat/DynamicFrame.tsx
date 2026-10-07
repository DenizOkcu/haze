import React, {useRef, useState} from 'react';
import {Box, useBoxMetrics, type DOMElement} from 'ink';
import {theme} from '../../ui/theme.js';

export interface FrameSections {
  live?: React.ReactNode | ((rows: number) => React.ReactNode);
  tasks?: React.ReactNode;
  queue?: React.ReactNode;
  debug?: React.ReactNode;
  status?: React.ReactNode;
  activity?: React.ReactNode;
}

export interface InputDemand {input: number; suggestions: number}

/** Allocate the entire normal-screen dynamic frame, never Static history. */
export function allocateFrame(rows: number, columns: number, sections: FrameSections, demand: InputDemand = {input: 1, suggestions: 0}) {
  // Keep normal-screen output below Ink's fullscreen threshold, including long
  // live previews. One-cell terminals still get an editable input row.
  let remaining = Math.max(1, Math.floor(rows) - 1);
  const take = (wanted: number) => {
    const granted = Math.min(remaining, wanted);
    remaining -= granted;
    return granted;
  };
  const compact = columns < 12 || rows < 6;
  const input = take(compact ? 1 : Math.min(4, Math.max(1, demand.input), Math.max(1, rows - 5)));
  const border = compact ? 0 : take(2);
  const activity = sections.activity ? take(1) : 0;
  const status = sections.status ? take(compact ? 1 : 2) : 0;
  const suggestions = take(Math.min(5, demand.suggestions, Math.floor(remaining / 3)));
  const tasks = sections.tasks ? take(Math.min(6, Math.floor(remaining / 3))) : 0;
  const queue = sections.queue ? take(Math.min(3, Math.floor(remaining / 4))) : 0;
  const debug = sections.debug ? take(Math.min(4, Math.floor(remaining / 4))) : 0;
  const live = sections.live ? take(remaining) : 0;
  return {compact, input, border, activity, status, suggestions, tasks, queue, debug, live};
}

/** Cap panel geometry without stretching short output into a fullscreen frame. */
function Panel({rows, children}: {rows: number; children: React.ReactNode}) {
  if (rows === 0) return null;
  return <Box flexDirection="column" maxHeight={rows} flexShrink={0} overflow="hidden">
    <Box flexDirection="column" flexShrink={0} width="100%">{children}</Box>
  </Box>;
}

export function DynamicFrame({rows, columns, sections, input}: {
  rows: number;
  columns: number;
  sections: FrameSections;
  input: (limits: {width: number; inputRows: number; suggestionRows: number; onRowsChange: (demand: InputDemand) => void}) => React.ReactNode;
}) {
  const [demand, setDemand] = useState<InputDemand>({input: 1, suggestions: 0});
  const inputRef = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(inputRef);
  const budget = allocateFrame(rows, columns, sections, demand);
  const safeWidth = Math.max(1, columns - (budget.border ? 4 : 0));
  // Previous measurements may be wider on shrink: first-render arithmetic stays authoritative.
  const inputWidth = metrics.hasMeasured && metrics.clientWidth > 0 ? Math.min(safeWidth, metrics.clientWidth) : safeWidth;
  const onRowsChange = (next: InputDemand) => setDemand(previous =>
    previous.input === next.input && previous.suggestions === next.suggestions ? previous : next);
  // Percentage width resolves against the Yoga root at layout time, so the
  // frame follows the live terminal width even in Ink v8's synchronous
  // resize render of the stale React tree, where an explicit numeric width
  // stays stale-wide and soft-wraps (see tests/cli/chat/resizeBoundary.test.tsx).
  // maxWidth keeps the columns prop authoritative for standalone embeds.
  return <Box flexDirection="column" width="100%" maxWidth={Math.max(1, columns)} flexShrink={0}>
    <Panel rows={budget.live}>{typeof sections.live === 'function' ? sections.live(budget.live) : sections.live}</Panel>
    <Panel rows={budget.debug}>{sections.debug}</Panel>
    <Panel rows={budget.queue}>{sections.queue}</Panel>
    <Panel rows={budget.tasks}>{sections.tasks}</Panel>
    <Panel rows={budget.activity}>{sections.activity}</Panel>
    <Box flexDirection="column" height={budget.input + budget.suggestions + budget.border}
      flexShrink={0} overflow="hidden" borderStyle={budget.border ? 'round' : undefined}
      borderColor={theme.border} paddingX={budget.border ? 1 : 0}>
      <Box ref={inputRef} width="100%" flexDirection="column" minWidth={0}>
        {input({width: inputWidth, inputRows: budget.input, suggestionRows: budget.suggestions, onRowsChange})}
      </Box>
    </Box>
    <Panel rows={budget.status}>{sections.status}</Panel>
  </Box>;
}
