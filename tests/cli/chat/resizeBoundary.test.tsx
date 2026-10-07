import React, {createRef} from 'react';
import {Box, measureElement, render, Static, Text, useWindowSize, type DOMElement} from 'ink';
import {describe, expect, it} from 'vitest';
import {DynamicFrame} from '../../../src/cli/chat/DynamicFrame.js';
import {installViewportResizeGuard} from '../../../src/cli/chat/resizeGuard.js';
import {TextInput} from '../../../src/ui/components/TextInput.js';
import {MarkdownText} from '../../../src/ui/components/MarkdownText.js';
import {FixtureInput, FixtureOutput, inkHarness} from '../../inkHarness.js';

/** Mirrors ChatScreen's width wiring: useWindowSize state into DynamicFrame, plus the width-change Static remount. */
function Screen({probe, onSubmit = () => {}}: {probe?: React.RefObject<DOMElement | null>; onSubmit?: (value: string) => void}) {
  const {columns, rows} = useWindowSize();
  const horizontalPadding = columns >= 12 ? 1 : 0;
  const contentWidth = Math.max(1, columns - horizontalPadding * 2);
  return <Box ref={probe} flexDirection="column" paddingX={horizontalPadding}>
    <Static key={columns} items={[
      {key: 'h', text: 'header line one'},
      {key: 'markdown', text: '# Settled heading\n\n**Settled emphasis**\n\n```ts\nconst replayed = true;\n```'},
    ]}>
      {item => item.key === 'markdown'
        ? <MarkdownText key={item.key} content={item.text} width={contentWidth}/>
        : <Text key={item.key}>{item.text}</Text>}
    </Static>
    <DynamicFrame rows={rows} columns={contentWidth} sections={{}} input={limits => <TextInput width={limits.width} inputRows={limits.inputRows} suggestionRows={limits.suggestionRows} onRowsChange={limits.onRowsChange} onSubmit={onSubmit} />}/>
  </Box>;
}

/** Strip ANSI sequences so painted output can be measured in terminal cells. */
function visibleLines(chunk: string): string[] {
  return chunk
    .replace(/\x1b\[[0-9;?<=>]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .split(/\r?\n/);
}

describe('viewport resize guard', () => {
  function fakeStdout() {
    const written: string[] = [];
    const listeners = new Set<() => void>();
    return {
      written,
      stream: {
        isTTY: true,
        columns: 100,
        rows: 30,
        on: (_event: 'resize', listener: () => void) => listeners.add(listener),
        off: (_event: 'resize', listener: () => void) => listeners.delete(listener),
        write: (chunk: string) => void written.push(chunk),
        resize(columns: number, rows: number) {
          (this as {columns: number; rows: number}).columns = columns;
          (this as {columns: number; rows: number}).rows = rows;
          for (const listener of listeners) listener();
        },
      },
    };
  }

  it('clears the viewport once per width change without erasing scrollback', () => {
    const {written, stream} = fakeStdout();
    const remove = installViewportResizeGuard(stream);
    try {
      stream.resize(100, 10); // height-only: no clear
      expect(written).toEqual([]);
      stream.resize(40, 24); // shrink: one full-viewport clear
      expect(written).toEqual(['\u001B[H\u001B[J']);
      stream.resize(120, 30); // grow: also replay at the fresh width
      expect(written).toEqual(['\u001B[H\u001B[J', '\u001B[H\u001B[J']);
    } finally { remove(); }
  });

  it('never clears on height-only changes and detaches cleanly', () => {
    const {written, stream} = fakeStdout();
    const repaint = installViewportResizeGuard(stream);
    stream.resize(100, 10); // rows drop, width equal
    expect(written).toEqual([]);
    repaint();
    stream.resize(40, 24); // detached: no writes
    expect(written).toEqual([]);
  });

  it('is a no-op for non-TTY streams', () => {
    const {written, stream} = fakeStdout();
    stream.isTTY = false;
    const repaint = installViewportResizeGuard(stream);
    stream.resize(40, 24);
    repaint();
    expect(written).toEqual([]);
  });
});

describe('full-session repaint on width change', () => {
  it('replays header and formatted Markdown once per width change while preserving the draft', async () => {
    const stdin = new FixtureInput();
    const stdout = new FixtureOutput();
    const stderr = new FixtureOutput();
    const removeGuard = installViewportResizeGuard(stdout);
    let submitted: string | undefined;
    const app = render(<Screen onSubmit={value => { submitted = value; }}/>, {
      stdin, stdout, stderr, interactive: true, patchConsole: false,
      exitOnCtrlC: false, incrementalRendering: true, maxFps: 15,
    });
    const painted = () => visibleLines(stdout.writes.join('')).join('\n');
    try {
      await app.waitUntilRenderFlush();
      stdout.writes.length = 0;
      stdin.write('draft survives');
      await app.waitUntilRenderFlush();
      expect(painted()).not.toContain('header line one');

      for (const columns of [50, 100, 50]) {
        stdout.writes.length = 0;
        stdout.resize(columns, 24);
        await app.waitUntilRenderFlush();
        await expect.poll(painted, {timeout: 2000}).toContain('const replayed = true;');
        expect(stdout.writes[0]).toBe('\u001B[H\u001B[J');
        for (const marker of ['header line one', 'SETTLED HEADING', 'Settled emphasis', 'const replayed = true;']) {
          expect(painted().split(marker).length - 1, marker).toBe(1);
        }
        expect(painted()).not.toContain('**Settled emphasis**');
        expect(painted()).not.toContain('```');
      }
      stdin.write('\r');
      await app.waitUntilRenderFlush();
      await expect.poll(() => submitted).toBe('draft survives');
    } finally {
      removeGuard();
      app.unmount();
      await app.waitUntilExit();
      app.cleanup();
      stdin.destroy(); stdout.destroy(); stderr.destroy();
    }
  });
});

describe('resize boundary frame width', () => {
  it('paints no line wider than the real terminal when shrinking mid-draft', async () => {
    const probe = createRef<DOMElement>();
    const fixture = inkHarness(<Screen probe={probe}/>);
    try {
      await fixture.app.waitUntilRenderFlush();
      fixture.stdin.write('hello world draft that is fairly long and will wrap when narrow');
      await fixture.app.waitUntilRenderFlush();
      fixture.stdout.writes.length = 0;
      // Ink v8 re-lays-out the stale React tree synchronously on resize
      // before useWindowSize state commits. The frame must size itself from
      // the fresh Yoga root width, not the stale prop, or it soft-wraps and
      // desyncs Ink's row accounting.
      fixture.stdout.resize(40, 24);
      await fixture.app.waitUntilRenderFlush();
      for (const line of visibleLines(fixture.stdout.writes.join(''))) {
        expect([...line].length, JSON.stringify(line.slice(0, 60))).toBeLessThanOrEqual(40);
      }
      await expect.poll(() => measureElement(probe.current!).height, {timeout: 2000}).toBeGreaterThan(0);
      expect(fixture.stdout.writes.join('')).toContain('hello world draft');
    } finally { await fixture.close(); }
  });

  it('control: a standalone explicit-width frame paints stale-wide on resize', async () => {
    // Control proving the harness reproduces Ink's stale-tree boundary
    // render: an explicit numeric width cannot shrink until React commits,
    // so the frame paints wider than the real terminal.
    const fixture = inkHarness(<Box flexDirection="column" width={78}>
      <DynamicFrame rows={24} columns={78} sections={{}} input={() => <Text>fixed</Text>}/>
    </Box>);
    try {
      await fixture.app.waitUntilRenderFlush();
      fixture.stdout.writes.length = 0;
      fixture.stdout.resize(40, 24);
      await fixture.app.waitUntilRenderFlush();
      const widest = Math.max(...visibleLines(fixture.stdout.writes.join('')).map(line => [...line].length));
      expect(widest).toBeGreaterThan(40);
    } finally { await fixture.close(); }
  });
});
