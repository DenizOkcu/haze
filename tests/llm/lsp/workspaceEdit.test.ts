import {describe, expect, it, vi} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {applyWorkspaceEdit, applyTextEdits, workspaceEditChanges} from '../../../src/llm/lsp/workspaceEdit.js';

describe('LSP workspace edit helpers', () => {
  it.each([{}, {line: -1, character: 0}, {line: 0.5, character: 0}, {line: 0, character: NaN}, {line: '0', character: 0}])('rejects malformed position %j', start => {
    expect(() => workspaceEditChanges({changes: {'file:///tmp/a.ts': [{range: {start, end: {line: 1, character: 1}}, newText: 'x'}]}})).toThrow();
  });

  it('rejects reversed and out-of-document ranges, while clamping CRLF character offsets', () => {
    const edit = (start: {line: number; character: number}, end: {line: number; character: number}) => ({range: {start, end}, newText: 'X'});
    expect(() => applyTextEdits('abc', [edit({line: 1, character: 3}, {line: 1, character: 1})])).toThrow(/Reversed/);
    expect(() => applyTextEdits('abc', [edit({line: 2, character: 1}, {line: 2, character: 1})])).toThrow(/outside/);
    expect(applyTextEdits('😀\r\nnext', [edit({line: 1, character: 3}, {line: 1, character: 100})])).toBe('😀X\r\nnext');
  });

  it('preflights all files and reports partial write failures truthfully', async () => {
    const cwd = process.cwd();
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'haze-lsp-edit-')));
    process.chdir(root);
    try {
      await fs.writeFile('a.ts', 'abc');
      await fs.writeFile('b.ts', 'abc');
      const uri = (name: string) => pathToFileURL(path.join(root, name)).href;
      const edit = {range: {start: {line: 0, character: 0}, end: {line: 0, character: 1}}, newText: 'X'};
      await expect(applyWorkspaceEdit('lspRenameSymbol', {changes: {
        [uri('a.ts')]: [edit], [uri('b.ts')]: [{...edit, range: {start: {}, end: {}}}],
      }}, {})).rejects.toThrow();
      expect(await fs.readFile('a.ts', 'utf8')).toBe('abc');
      const write = fs.writeFile.bind(fs);
      vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
        if (String(file).endsWith('b.ts')) throw new Error('disk full');
        return write(file, data, options);
      });
      const result = await applyWorkspaceEdit('lspRenameSymbol', {changes: {[uri('a.ts')]: [edit], [uri('b.ts')]: [edit]}}, {});
      expect(result).toMatchObject({ok: false, changedPaths: ['a.ts'], uncertainPaths: ['b.ts']});
      expect(await fs.readFile('a.ts', 'utf8')).toBe('Xbc');
      expect(await fs.readFile('b.ts', 'utf8')).toBe('abc');
    } finally {
      vi.restoreAllMocks();
      process.chdir(cwd);
      await fs.rm(root, {recursive: true, force: true});
    }
  });

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
