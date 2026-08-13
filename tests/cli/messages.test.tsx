import React from 'react';
import {describe, expect, it, vi} from 'vitest';
import {render} from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import {marked} from 'marked';
import {AssistantMarkdownChunkView, MessageView, partitionDisplayMessages} from '../../src/cli/chat/messages.js';
import {clearMarkdownRootChunksCacheForTests} from '../../src/ui/components/MarkdownText.js';

describe('streaming assistant Markdown messages', () => {
  it('moves only completed root blocks into the append-only transcript', () => {
    const first = partitionDisplayMessages([{
      id: 'assistant-1',
      role: 'assistant',
      text: 'First paragraph.\n\nSecond paragraph is active',
      streaming: true,
    }]);
    expect(first.staticItems).toHaveLength(1);
    expect(first.staticItems[0]).toMatchObject({kind: 'assistant-markdown', key: 'assistant-1-markdown-0', content: 'First paragraph.\n\n', first: true, final: false});
    expect(first.streamingItems[0]).toMatchObject({key: 'assistant-1', showHeader: false, message: {text: 'Second paragraph is active'}});

    const next = partitionDisplayMessages([{
      id: 'assistant-1',
      role: 'assistant',
      text: 'First paragraph.\n\nSecond paragraph is complete.\n\nThird is active',
      streaming: true,
    }]);
    expect(next.staticItems.map(item => item.key)).toEqual(['assistant-1-markdown-0', 'assistant-1-markdown-1']);
    expect(next.staticItems[0]).toMatchObject({content: 'First paragraph.\n\n'});
    expect(next.streamingItems[0]).toMatchObject({showHeader: false, message: {text: 'Third is active'}});
  });

  it('keeps settled messages after the active tail dynamic to preserve terminal order', () => {
    const result = partitionDisplayMessages([
      {id: 'assistant-1', role: 'assistant', text: 'Completed root.\n\nActive root', streaming: true, displayOrder: 1},
      {id: 'notice-1', role: 'system', text: 'Queued follow-up', streaming: false, displayOrder: 2},
    ]);

    expect(result.staticItems.map(item => item.key)).toEqual(['assistant-1-markdown-0']);
    expect(result.streamingItems.map(item => item.key)).toEqual(['assistant-1', 'notice-1']);
  });

  it('commits the final active block with completion metadata when streaming ends', () => {
    const result = partitionDisplayMessages([{
      id: 'assistant-1',
      role: 'assistant',
      text: '# Result\n\nDone.',
      streaming: false,
      startedAt: 100,
      finishedAt: 1_100,
    }]);

    expect(result.streamingItems).toEqual([]);
    expect(result.staticItems).toHaveLength(2);
    expect(result.staticItems[1]).toMatchObject({kind: 'assistant-markdown', content: 'Done.', first: false, final: true});
  });

  it('renders completed chunks as Markdown and places the completion below the final chunk', () => {
    const {lastFrame} = render(<AssistantMarkdownChunkView
      message={{role: 'assistant', text: '# Result\n\nThe result is complete.', streaming: false, startedAt: 100, finishedAt: 1_100}}
      content="# Result"
      width={50}
      first
      final
    />);

    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('haze');
    expect(frame).toContain('RESULT');
    expect(frame).toContain('1.0s');
  });
});

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

  it('renders omitted-line and full-diff retrieval details for bounded previews', () => {
    const {lastFrame} = render(<MessageView width={70} message={{
      role: 'tool',
      text: '1 calls · 1 changes · 0s',
      toolDiffs: [{
        id: 'write-1',
        path: 'large.ts',
        addedLines: 100,
        removedLines: 0,
        truncated: true,
        omittedLines: 98,
        handle: 'output-full-diff',
        complete: true,
        lines: [
          {type: 'add', newLine: 1, text: 'first'},
          {type: 'gap', omittedLines: 98},
          {type: 'add', newLine: 100, text: 'last'},
        ],
      }],
    }} />);

    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('98 diff lines omitted');
    expect(frame).toContain('Full diff: readToolOutput with handle output-full-diff');
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

  it('does not re-lex settled assistant Markdown across repeated partitions (RH-007)', () => {
    clearMarkdownRootChunksCacheForTests();
    const messages = Array.from({length: 40}, (_, index) => ({
      id: `a-${index}`,
      role: 'assistant' as const,
      text: `# Heading ${index}\n\nParagraph ${index} with some detail.\n\n\`\`\`\ncode line ${index}\n\`\`\`\n`,
      streaming: false,
    }));
    const spy = vi.spyOn(marked, 'lexer');
    partitionDisplayMessages(messages);
    const firstRunCalls = spy.mock.calls.length;
    expect(firstRunCalls).toBeGreaterThan(0);
    // Re-partitioning the same settled transcript (every render) must be served
    // from the cache rather than re-lexing the whole history each time.
    partitionDisplayMessages(messages);
    partitionDisplayMessages(messages);
    expect(spy.mock.calls.length).toBe(firstRunCalls);
    spy.mockRestore();
  });
});
