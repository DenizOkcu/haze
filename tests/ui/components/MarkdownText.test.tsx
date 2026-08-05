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

describe('MarkdownText code rendering', () => {
  it('renders single-backtick paths as inline code without showing the delimiters', () => {
    const content = [
      'New untracked documentation/configuration',
      '',
      '• `AGENTS.md` — repository guidance.',
      '• `src/AGENTS.md` — state-update guidance.',
    ].join('\n');

    const {lastFrame} = render(<MarkdownText content={content} width={80} />);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('• AGENTS.md — repository guidance.');
    expect(frame).toContain('• src/AGENTS.md — state-update guidance.');
    expect(frame).not.toContain('`');
  });

  it('numbers multiline fenced code while keeping syntax content intact', () => {
    const content = [
      '```ts',
      'export function add(a: number, b: number) {',
      '  return a + b;',
      '}',
      '```',
    ].join('\n');

    const {lastFrame} = render(<MarkdownText content={content} width={60} />);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('1 │ export function add(a: number, b: number) {');
    expect(frame).toContain('2 │   return a + b;');
    expect(frame).toContain('3 │ }');
  });

  it('keeps a referenced filename with its code and preserves original file line numbers', () => {
    const content = [
      '**Centralized board mutations and activity events** — `src/App.tsx:105`',
      '',
      '```tsx',
      'const applyMutation = (updater: (prev: Board) => MutatorResult) => {',
      '  setBoard((prev) => {',
      '    const [next, events] = updater(prev);',
      '    if (events.length === 0) return next;',
      '    return { ...next, activity: [...next.activity, ...events] };',
      '  });',
      '};',
      '```',
    ].join('\n');

    const {lastFrame} = render(<MarkdownText content={content} width={80} />);
    const frame = stripAnsi(lastFrame() ?? '');
    const lines = frame.split('\n');
    const sourceIndex = lines.findIndex(line => line.startsWith('src/App.tsx:105 · tsx'));
    expect(sourceIndex).toBeGreaterThan(-1);
    expect(lines[sourceIndex - 1]).toBe('Centralized board mutations and activity events');
    expect(lines[sourceIndex + 1]).toContain('105 │ const applyMutation');
    expect(frame).toContain('111 │ };');
    expect(frame).not.toContain('1 │ const applyMutation');
  });

  it('leaves inline and single-line fenced code unnumbered', () => {
    const content = ['Use `npm test`.', '', '```sh', 'npm test', '```'].join('\n');
    const {lastFrame} = render(<MarkdownText content={content} width={40} />);
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Use npm test.');
    expect(frame).toContain('npm test');
    expect(frame).not.toContain('1 │');
  });

  it('clips long source rows instead of wrapping beneath the number gutter', () => {
    const content = ['```ts', `const value = '${'x'.repeat(80)}';`, 'return value;', '```'].join('\n');
    const {lastFrame} = render(<MarkdownText content={content} width={30} />);
    const frame = stripAnsi(lastFrame() ?? '');
    const firstSourceLine = frame.split('\n').find(line => line.includes('1 │'));
    expect(firstSourceLine).toContain('…');
    expect(firstSourceLine?.length).toBeLessThanOrEqual(28);
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
