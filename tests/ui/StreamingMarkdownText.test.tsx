import React from 'react';
import {describe, expect, it, vi} from 'vitest';
import {render} from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import {StreamingMarkdownText} from '../../src/ui/components/StreamingMarkdownText.js';

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
});
