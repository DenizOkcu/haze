import React from 'react';
import {describe, expect, it} from 'vitest';
import {render} from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import {MessageView} from '../../src/cli/chat/messages.js';

describe('tool diff messages', () => {
  it('renders an edit summary and numbered remove/add code rows', () => {
    const {lastFrame} = render(<MessageView width={70} message={{
      role: 'tool',
      text: '1 calls · 1 changes · 0s\n  ✓ editFile src/example.ts — Added 1 line, removed 1 line',
      toolDiffs: [{
        id: 'edit-1',
        path: 'src/example.ts',
        addedLines: 1,
        removedLines: 1,
        lines: [
          {type: 'context', oldLine: 3, newLine: 3, text: 'export function value() {'},
          {type: 'remove', oldLine: 4, text: "  return 'old';"},
          {type: 'add', newLine: 4, text: "  return 'new';"},
          {type: 'context', oldLine: 5, newLine: 5, text: '}'},
        ],
      }],
    }} />);

    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('⎿ src/example.ts · Added 1 line, removed 1 line');
    expect(frame).toContain("   4 -   return 'old';");
    expect(frame).toContain("   4 +   return 'new';");
    expect(frame).toContain('   3   export function value() {');
  });

  it('clips long changed rows to the available terminal width', () => {
    const {lastFrame} = render(<MessageView width={30} message={{
      role: 'tool',
      text: '1 calls · 1 changes · 0s',
      toolDiffs: [{
        id: 'edit-1',
        path: 'a.ts',
        addedLines: 1,
        removedLines: 0,
        lines: [{type: 'add', newLine: 12, text: `const value = '${'x'.repeat(80)}';`}],
      }],
    }} />);

    const frame = stripAnsi(lastFrame() ?? '');
    const changedLine = frame.split('\n').find(line => line.includes('12 +'));
    expect(changedLine).toContain('…');
    expect(changedLine?.length).toBeLessThanOrEqual(30);
  });
});
