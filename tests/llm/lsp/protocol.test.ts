import {describe, expect, it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {asRange, flattenSymbols, fromUri, languageId, locationToResult, locationToWorkspaceResult, toDiagnostic, toUri} from '../../../src/llm/lsp/protocol.js';

describe('lsp pure helpers', () => {
  it('maps file extensions to language ids', () => {
    expect(languageId('a.ts')).toBe('typescript');
    expect(languageId('a.tsx')).toBe('typescriptreact');
    expect(languageId('a.js')).toBe('javascript');
    expect(languageId('a.jsx')).toBe('javascriptreact');
    expect(languageId('a.rs')).toBe('rust');
    expect(languageId('a.py')).toBe('python');
    expect(languageId('a.go')).toBe('go');
    expect(languageId('a.unknownext')).toBe('unknownext');
    expect(languageId('Makefile')).toBe('plaintext');
  });

  it('round-trips paths through file:// URIs', () => {
    const uri = toUri('/tmp/foo/bar.ts');
    expect(uri.startsWith('file://')).toBe(true);
    expect(fromUri(uri)).toBe(path.relative(process.cwd(), '/tmp/foo/bar.ts'));
    expect(fromUri('https://example.com/x')).toBe('https://example.com/x');
  });

  it('normalizes LSP ranges to 1-indexed positions', () => {
    // Inputs are LSP-native (0-indexed); expected outputs are 1-indexed for haze's display.
    expect(asRange({start: {line: 0, character: 2}, end: {line: 3, character: 5}})).toEqual({
      start: {line: 1, character: 3},
      end: {line: 4, character: 6},
    });
  });

  it('returns undefined when the value or its endpoints are not objects', () => {
    expect(asRange(null)).toBeUndefined();
    expect(asRange({start: null, end: null})).toBeUndefined();
    expect(asRange({start: {line: 0, character: 0}, end: 'bad'})).toBeUndefined();
  });

  it('defaults missing numeric range fields to 1', () => {
    const range = asRange({start: {}, end: {}});
    expect(range).toEqual({start: {line: 1, character: 1}, end: {line: 1, character: 1}});
  });

  it('converts location objects to relative paths', () => {
    const loc = locationToResult({uri: toUri('/tmp/foo/bar.ts'), range: {start: {line: 0, character: 0}, end: {line: 0, character: 3}}});
    expect(loc).toBeDefined();
    expect(loc?.range.start.line).toBe(1);
  });

  it('flattens hierarchical document symbols up to the limit', () => {
    const symbols = [
      {name: 'Top', kind: 12, range: {start: {line: 0, character: 0}, end: {line: 10, character: 0}}, selectionRange: {start: {line: 0, character: 0}, end: {line: 0, character: 3}}, children: [
        {name: 'Inner', kind: 6, range: {start: {line: 1, character: 0}, end: {line: 2, character: 0}}, selectionRange: {start: {line: 1, character: 0}, end: {line: 1, character: 5}}},
      ]},
    ];
    expect(flattenSymbols(symbols, 'a.ts', 10).map(s => s.name)).toEqual(['Top', 'Inner']);
    expect(flattenSymbols(symbols, 'a.ts', 1).map(s => s.name)).toEqual(['Top']);
    expect(flattenSymbols(symbols, 'a.ts', 10)[0]?.path).toBe('a.ts');
  });

  it('skips symbol entries without a name', () => {
    expect(flattenSymbols([{kind: 1}, {name: 'Real'}], 'a.ts', 10).map(s => s.name)).toEqual(['Real']);
  });

  it('converts definition-style locations using targetUri', () => {
    const loc = locationToResult({targetUri: toUri('/tmp/foo/bar.ts'), targetSelectionRange: {start: {line: 2, character: 4}, end: {line: 2, character: 8}}});
    expect(loc).toBeDefined();
    expect(loc?.range.start.line).toBe(3);
  });

  it.runIf(process.platform !== 'win32')('labels a returned symlink escape as external', async () => {
    const workspace = await fs.mkdtemp(path.join(process.cwd(), '.haze-lsp-location-'));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-lsp-outside-'));
    const outside = path.join(outsideDir, 'outside.ts');
    await fs.writeFile(outside, 'secret');
    await fs.symlink(outside, path.join(workspace, 'linked.ts'));
    try {
      const result = await locationToWorkspaceResult({uri: toUri(path.join(workspace, 'linked.ts')), range: {start: {line: 0, character: 0}, end: {line: 0, character: 1}}});
      expect(result).toMatchObject({external: true, path: expect.stringMatching(/^file:/)});
    } finally {
      await fs.rm(workspace, {recursive: true, force: true});
      await fs.rm(outsideDir, {recursive: true, force: true});
    }
  });
});


describe('toDiagnostic', () => {
  it('maps severity numbers to labels and keeps code/source when present', () => {
    const range = {start: {line: 0, character: 2}, end: {line: 0, character: 5}};
    expect(toDiagnostic({range, severity: 1, message: 'e', code: 2322, source: 'ts'})).toEqual({severity: 'error', range: {start: {line: 1, character: 3}, end: {line: 1, character: 6}}, message: 'e', code: '2322', source: 'ts'});
    expect(toDiagnostic({range, severity: 2, message: 'w'})?.severity).toBe('warning');
    expect(toDiagnostic({range, severity: 3, message: 'i'})?.severity).toBe('information');
    expect(toDiagnostic({range, severity: 4, message: 'h'})?.severity).toBe('hint');
  });

  it('defaults unknown severities to information and skips entries without a range', () => {
    const range = {start: {line: 0, character: 0}, end: {line: 0, character: 1}};
    expect(toDiagnostic({range, severity: 99, message: 'x'})?.severity).toBe('information');
    expect(toDiagnostic({severity: 1, message: 'no range'})).toBeUndefined();
    expect(toDiagnostic('nope')).toBeUndefined();
  });
});
