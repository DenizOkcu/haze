import React from 'react';
import {describe, expect, it} from 'vitest';
import {render} from 'ink-testing-library';
import {Box} from 'ink';
import stripAnsi from 'strip-ansi';
import {LiveTail} from '../../../src/cli/chat/LiveTail.js';
import type {TranscriptStreamingItem} from '../../../src/cli/chat/transcriptPartition.js';

function liveItems(count: number): TranscriptStreamingItem[] {
  return Array.from({length: count}, (_, index) => ({
    key: `live-${index}`,
    showHeader: false,
    message: {id: `live-${index}`, role: 'system', text: `live item ${index + 1}`},
  }));
}

/** Mirrors DynamicFrame's Panel: the live region is hosted in a fixed-width column. */
function renderLive(items: TranscriptStreamingItem[], rows: number) {
  return render(<Box width={80} flexDirection="column"><LiveTail items={items} width={80} rows={rows} /></Box>);
}

function rowsOf(lastFrame: () => string | undefined): string[] {
  return stripAnsi(lastFrame() ?? '').split('\n').filter(line => line.trim().length > 0);
}

describe('LiveTail (FE-06)', () => {
  it('counts the live items that do not fit the row budget in one indicator row', () => {
    const {lastFrame} = renderLive(liveItems(10), 12);
    const rows = rowsOf(lastFrame);
    expect(rows).toContain('+5 more');
    // The newest five two-row items (6-10) plus the indicator stay inside the
    // twelve-row budget; the oldest are the ones counted, never the active tail.
    expect(rows).toContain('+5 more');
    expect(rows.join('\n')).toContain('live item 10');
    expect(rows.join('\n')).toContain('live item 6');
    expect(rows.join('\n')).not.toContain('live item 5 ');

    expect(rows.length).toBeLessThanOrEqual(12);
  });

  it('shows no indicator when every live item fits', () => {
    const {lastFrame} = renderLive(liveItems(10), 20);
    const rows = rowsOf(lastFrame);
    expect(rows.join('\n')).not.toContain('more');
    for (let index = 1; index <= 10; index++) expect(rows.join('\n')).toContain(`live item ${index}`);
  });

  it('reduces to the indicator alone when no item can keep a readable row', () => {
    const {lastFrame} = renderLive(liveItems(3), 1);
    expect(rowsOf(lastFrame)).toEqual(['+3 more']);
  });
});
