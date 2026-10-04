import React, {createRef} from 'react';
import {Box, measureElement, type DOMElement} from 'ink';
import {render} from 'ink-testing-library';
import {expect, it, vi} from 'vitest';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import {indicatorTheme, StatusNotice} from '../../src/ui/components/NativeIndicators.js';
import {resolveTheme} from '../../src/ui/theme.js';
import {BusyBar} from '../../src/cli/chat/BusyBar.js';
import {MessageView} from '../../src/cli/chat/messages.js';
import {DynamicFrame} from '../../src/cli/chat/DynamicFrame.js';
import {TextInput} from '../../src/ui/components/TextInput.js';
import {inkHarness} from '../inkHarness.js';

it('maps spinner and every notice variant to each supplied live palette', () => {
  for (const name of ['purple', 'robbyrussell']) {
    const palette = resolveTheme(name);
    const components = indicatorTheme(palette).components;
    expect(components.Spinner!.styles!.frame!()).toEqual({color: palette.command});
    expect(indicatorTheme(palette, palette.muted).components.Spinner!.styles!.frame!()).toEqual({color: palette.muted});
    for (const [variant, color] of Object.entries({success: palette.success, error: palette.danger, warning: palette.warning, info: palette.info})) {
      expect(components.StatusMessage!.styles!.icon!({variant})).toEqual({color});
    }
  }
});

it('renders compact notices and busy labels without wrapping past their rows', async () => {
  const app = render(<Box width={24} flexDirection="column">
    <BusyBar label="Working" elapsed="12s" tip={'界'.repeat(40)} />
    <StatusNotice variant="warning">Press R to resume · unfinished goal paused</StatusNotice>
  </Box>);
  try {
    await expect.poll(() => app.lastFrame()).toContain('Press R');
    const lines = stripAnsi(app.lastFrame() ?? '').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Working');
    expect(lines[0]).toContain('12s');
    expect(lines[1]).toContain('Tip:');
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(24);
  } finally { app.unmount(); app.cleanup(); }
});

it('accounts for the native tool spinner when wrapping and clamping, then settles losslessly', async () => {
  const text = 'abcdefghijklmno';
  const view = (streaming: boolean, maxVisibleLines?: number) => <Box width={16}>
    <MessageView width={16} showHeader={false} maxVisibleLines={maxVisibleLines}
      message={{role: 'tool', text, streaming}} />
  </Box>;
  const app = render(view(true));
  try {
    await expect.poll(() => app.lastFrame()).toContain('abcdefghijklmn');
    const lines = stripAnsi(app.lastFrame() ?? '').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1].trim()).toBe('o');
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(16);
    app.rerender(view(true, 1));
    await expect.poll(() => app.lastFrame()).toContain('+2 lines');
    expect(app.lastFrame()).not.toContain('abcdefgh');
    app.rerender(view(false));
    await expect.poll(() => app.lastFrame()).toContain(text);
    expect(stripAnsi(app.lastFrame() ?? '').trim()).toBe(text);
  } finally { app.unmount(); app.cleanup(); }
});

it('preserves queue submission, cancellation and R resume across native indicator transitions and resize', async () => {
  const ref = createRef<DOMElement>();
  const submit = vi.fn();
  const cancel = vi.fn();
  const resume = vi.fn();
  function Fixture({paused = false, columns = 80, rows = 24}: {paused?: boolean; columns?: number; rows?: number}) {
    return <Box ref={ref} flexDirection="column" width={columns}>
      <DynamicFrame rows={rows} columns={columns} sections={{activity: paused
        ? <StatusNotice variant="warning">Press R to resume · unfinished goal paused</StatusNotice>
        : <BusyBar label="Working" elapsed="1s" tip="Keep changes focused" />}}
        input={limits => <TextInput {...limits} onSubmit={submit} onEscape={cancel}
          onResumeKey={paused ? resume : undefined} />} />
    </Box>;
  }
  const fixture = inkHarness(<Fixture />);
  try {
    await fixture.app.waitUntilRenderFlush();
    fixture.stdin.write('queued-request');
    await expect.poll(() => fixture.stdout.writes.join('')).toContain('queued-request');
    fixture.stdin.write('\r');
    await expect.poll(() => submit.mock.calls).toEqual([['queued-request']]);
    fixture.stdin.write('\x1b');
    await expect.poll(() => cancel.mock.calls.length).toBe(1);
    fixture.app.rerender(<Fixture paused />);
    await fixture.app.waitUntilRenderFlush();
    fixture.stdin.write('r');
    await expect.poll(() => resume.mock.calls.length).toBe(1);
    for (const paused of [false, true]) {
      for (const [columns, rows] of [[80, 24], [16, 8], [4, 3], [1, 1]]) {
        fixture.stdout.resize(columns!, rows!);
        fixture.app.rerender(<Fixture paused={paused} columns={columns!} rows={rows!} />);
        await fixture.app.waitUntilRenderFlush();
        expect(measureElement(ref.current!).height).toBeLessThanOrEqual(Math.max(1, rows! - 1));
        expect(measureElement(ref.current!).width).toBeLessThanOrEqual(columns!);
      }
    }
    expect(fixture.stdout.writes.join('')).not.toContain('\x1b[3J');
  } finally { await fixture.close(); }
  expect(fixture.stdin.isRaw).toBe(false);
  expect(fixture.stdin.listenerCount('readable')).toBe(0);
});
