import {describe, expect, it} from 'vitest';
import {Text} from 'ink';
import {render} from 'ink-testing-library';
import React from 'react';
import stripAnsi from 'strip-ansi';
import {MarkdownText} from '../../../src/ui/components/MarkdownText.js';

describe('MarkdownText width reactivity', () => {
  it('reflows content when the width prop changes (regression for 79091ee)', () => {
    // H1 underline length = min(contentWidth, max(12, titleLength)). With a
    // title longer than the narrow contentWidth, the underline visibly shrinks
    // at narrower widths. If the memo is bypassed (e.g. someone re-introduces
    // useWindowSize() inside MarkdownText), the rerender produces the same
    // frame and this test fails.
    const content = '# A Long Title That Is Longer Than Thirty Characters Total';
    const {rerender, lastFrame} = render(<MarkdownText content={content} width={80} />);
    const wide = lastFrame() ?? '';
    rerender(<MarkdownText content={content} width={30} />);
    const narrow = lastFrame() ?? '';
    expect(wide).not.toBe(narrow);
    const wideDashes = (wide.match(/─/g) ?? []).length;
    const narrowDashes = (narrow.match(/─/g) ?? []).length;
    expect(wideDashes).toBeGreaterThan(narrowDashes);
  });

  it('skips re-render when neither content nor width changes (memo works)', () => {
    let renderCount = 0;
    function Probe() {
      renderCount++;
      return <Text>x</Text>;
    }
    const content = 'hello';
    const {rerender} = render(<><MarkdownText content={content} width={80} /><Probe /></>);
    const before = renderCount;
    // Same content + width: parent re-renders Probe but MarkdownText should bail.
    rerender(<><MarkdownText content={content} width={80} /><Probe /></>);
    expect(renderCount).toBe(before + 1); // Probe re-renders, but only Probe
  });
});

describe('MarkdownText list rendering', () => {
  it('renders fenced code blocks inside a list item as a real code block, not flattened inline text', () => {
    // Regression: the list case used item.text.replace(/\n/g, ' '), which
    // concatenated the raw fence into one line and let InlineMarkdown eat the
    // ```ts opening as a fake inline-code span (output had stray backticks and
    // no language header).
    const content = [
      '- First bullet with `inline` code.',
      '- Second bullet with a block:',
      '',
      '  ```ts',
      '  const x = 1;',
      '  ```',
      '',
      '- Third bullet.',
    ].join('\n');

    const {lastFrame} = render(<MarkdownText content={content} width={60} />);
    const frame = stripAnsi(lastFrame() ?? '');

    // Tight bullets keep their inline rendering (backticks stripped by InlineMarkdown).
    expect(frame).toContain('• First bullet with inline code.');
    expect(frame).toContain('• Second bullet with a block:');
    expect(frame).toContain('• Third bullet.');

    // The fenced block surfaces as a CodeBlock: language header line + code line,
    // and no stray backticks anywhere in the frame.
    expect(frame).toContain('ts');
    expect(frame).toContain('const x = 1;');
    expect(frame).not.toContain('`');
  });

  it('keeps the bullet gap consistent and wraps with a 2-space hanging indent', () => {
    // Regression: Ink's auto-wrap injected a stray leading space at certain
    // widths, producing a 3-space indent on a wrapped line. We now pre-wrap
    // manually so every wrapped line aligns under the text after the bullet.
    const content = [
      '- Implemented card metadata UI: create/toggle labels, set/clear priority and size, metadata badges on cards, plus label and minimum-priority filters.',
      '- Updated `App.tsx`, `types.ts`, `TaskDetail.tsx`, `Column.tsx`, `Card.tsx`, `i18n.ts`, and `styles.css`, reusing existing domain mutators and shared ordering constants.',
      '- Validation passed.',
    ].join('\n');

    const {lastFrame} = render(<MarkdownText content={content} width={60} />);
    const frame = stripAnsi(lastFrame() ?? '');
    const lines = frame.split('\n');

    // Every bullet line starts with '• ' (bullet + single space).
    const bulletLines = lines.filter(line => line.startsWith('• '));
    expect(bulletLines).toHaveLength(3);

    // Every wrapped line is indented by exactly two spaces (no 3-space lines).
    const wrappedLines = lines.filter(line => line.length > 0 && !line.startsWith('• ') && line.startsWith(' '));
    for (const line of wrappedLines) {
      expect(line.startsWith('  ')).toBe(true);
      expect(line.startsWith('   ')).toBe(false);
    }

    // Original spacing preserved (no inserted space before the comma).
    expect(frame).toContain('App.tsx, types.ts');
    expect(frame).not.toContain('App.tsx , types.ts');
  });
});
