import {describe, expect, it} from 'vitest';
import {applyTextEdits, workspaceEditChanges} from '../../../src/llm/lsp/workspaceEdit.js';

describe('LSP workspace edit helpers', () => {
  it('parses changes and documentChanges into 1-based internal ranges', () => {
    const changes = workspaceEditChanges({changes: {'file:///tmp/a.ts': [{range: {start: {line: 0, character: 1}, end: {line: 0, character: 3}}, newText: 'x'}]}});
    expect(changes.get('file:///tmp/a.ts')?.[0]?.range).toEqual({start: {line: 1, character: 2}, end: {line: 1, character: 4}});
    const documents = workspaceEditChanges({documentChanges: [{textDocument: {uri: 'file:///tmp/b.ts'}, edits: [{range: {start: {line: 1, character: 0}, end: {line: 1, character: 1}}, newText: 'y'}]}]});
    expect(documents.has('file:///tmp/b.ts')).toBe(true);
  });

  it('applies multiple edits from the end and uses UTF-16 character offsets', () => {
    const updated = applyTextEdits('😀 foo\nbar', [
      {range: {start: {line: 1, character: 4}, end: {line: 1, character: 7}}, newText: 'baz'},
      {range: {start: {line: 2, character: 1}, end: {line: 2, character: 4}}, newText: 'qux'},
    ]);
    expect(updated).toBe('😀 baz\nqux');
  });

  it('rejects overlapping edits', () => {
    expect(() => applyTextEdits('abcdef', [
      {range: {start: {line: 1, character: 2}, end: {line: 1, character: 5}}, newText: ''},
      {range: {start: {line: 1, character: 4}, end: {line: 1, character: 6}}, newText: ''},
    ])).toThrow(/overlapping/);
  });
});
