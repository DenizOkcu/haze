import React from 'react';
import {describe, expect, it, vi} from 'vitest';
import {render} from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import {StreamingMarkdownText} from '../../src/ui/components/StreamingMarkdownText.js';

// Every offscreen render of the active root renders `<MarkdownText>` once; the
// pass-through wrapper counts those renders without touching the output.
const offscreen = vi.hoisted(() => ({renders: 0}));
vi.mock('../../src/ui/components/MarkdownText.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/ui/components/MarkdownText.js')>();
  const React = await import('react');
  return {...actual, MarkdownText: React.memo(function CountingMarkdownText(props: {content: string; width: number}) {
    offscreen.renders += 1;
    return React.createElement(actual.MarkdownText, props);
  })};
});

function frameOf(lastFrame: () => string | undefined) {
  return stripAnsi(lastFrame() ?? '');
}

describe('StreamingMarkdownText', () => {
  it('renders the streaming block as formatted Markdown rows', async () => {
    const {lastFrame} = render(<StreamingMarkdownText
      content={'## Shipped\n\n- item **one**\n- item two'}
      width={60}
    />);
    await vi.waitFor(() => expect(frameOf(lastFrame)).toContain('Shipped'));
    const frame = frameOf(lastFrame);
    expect(frame).toContain('• item one');
    expect(frame).not.toContain('**');
    expect(frame).not.toContain('##');
  });

  it('re-renders rows as deltas arrive without flickering away', async () => {
    const {lastFrame, rerender} = render(<StreamingMarkdownText content="First line" width={60} />);
    await vi.waitFor(() => expect(frameOf(lastFrame)).toContain('First line'));
    rerender(<StreamingMarkdownText content={'First line\n\n- bullet one'} width={60} />);
    await vi.waitFor(() => expect(frameOf(lastFrame)).toContain('• bullet one'));
    expect(frameOf(lastFrame)).toContain('First line');
  });

  it('never replays a committed root after the active block is promoted', async () => {
    const {lastFrame, rerender} = render(<StreamingMarkdownText content={'First line\n\nNext'} width={60} />);
    await vi.waitFor(() => expect(frameOf(lastFrame)).toContain('Next'));
    rerender(<StreamingMarkdownText content="Next" width={60} />);
    await vi.waitFor(() => expect(frameOf(lastFrame)).toContain('Next'));
    const frame = frameOf(lastFrame);
    expect(frame).not.toContain('First line');
  });

  it('clamps long streaming blocks to the visible row budget with an indicator', async () => {
    const content = Array.from({length: 10}, (_, index) => `line ${index + 1}`).join('\n');
    const {lastFrame} = render(<StreamingMarkdownText content={content} width={60} maxVisibleLines={3} />);
    await vi.waitFor(() => expect(frameOf(lastFrame)).toContain('line 10'));
    const frame = frameOf(lastFrame);
    expect(frame).toContain('⋯ +8 lines above');
    expect(frame).toContain('line 9');
    expect(frame).toContain('line 10');
    expect(frame.split('\n')).not.toContain('line 1');
    expect(frame.split('\n')).toHaveLength(3);
  });

  it('handles a stream that is cut mid table without throwing', async () => {
    const {lastFrame} = render(<StreamingMarkdownText
      content={'Name | Count\n--- | ---\nA | 12'}
      width={60}
    />);
    await vi.waitFor(() => expect(frameOf(lastFrame)).toContain('A'));
    expect(frameOf(lastFrame)).toContain('12');
  });

  it('strips terminal control sequences from streamed deltas before rendering (R2-HZ-4)', async () => {
    const osc52 = '\x1b]52;c;aGVsbG8=\x07';
    const {lastFrame} = render(<StreamingMarkdownText content={`quoting: ${osc52} harmless`} width={60} />);
    await vi.waitFor(() => expect(frameOf(lastFrame)).toContain('harmless'));
    const raw = lastFrame() ?? '';
    expect(raw).not.toContain('\x1b]52');
    expect(raw).not.toContain('aGVsbG8=');
    expect(raw).not.toContain('\u009b');
  });

  it('coalesces a burst of deltas into at most two offscreen renders (FE-05)', async () => {
    offscreen.renders = 0;
    try {
      const {lastFrame, rerender} = render(<StreamingMarkdownText content="delta 0" width={60} />);
      // 200 deltas inside one tick, each followed by a microtask checkpoint.
      for (let index = 1; index <= 200; index++) {
        rerender(<StreamingMarkdownText content={`delta ${index}`} width={60} />);
        await Promise.resolve();
      }
      await vi.waitFor(() => expect(frameOf(lastFrame)).toContain('delta 200'));
      expect(offscreen.renders).toBeGreaterThan(0);
      // The window's leading render plus one trailing render for the whole burst.
      expect(offscreen.renders).toBeLessThanOrEqual(2);
      // The settled text is rendered without waiting for the next window.
      rerender(<StreamingMarkdownText content="delta 200 done" width={60} streaming={false} />);
      await vi.waitFor(() => expect(frameOf(lastFrame)).toContain('delta 200 done'));
      expect(offscreen.renders).toBeLessThanOrEqual(3);
    } finally {
      offscreen.renders = 0;
    }
  });
});
