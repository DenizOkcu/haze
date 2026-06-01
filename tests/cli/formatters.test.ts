import {describe, it, expect} from 'vitest';
import {compact, toolCallSummary, toolResultSummary, formatSeconds} from '../../src/cli/commands/formatters.js';

describe('compact', () => {
  it('returns short strings unchanged', () => {
    expect(compact('hello')).toBe('hello');
  });

  it('truncates long strings with ellipsis', () => {
    const long = 'a'.repeat(200);
    expect(compact(long)).toBe(`${'a'.repeat(180)}…`);
  });

  it('respects custom maxLength', () => {
    expect(compact('hello world', 5)).toBe('hello…');
  });

  it('extracts message from Error objects', () => {
    expect(compact(new Error('oops'))).toBe('oops');
  });

  it('stringifies objects', () => {
    expect(compact({key: 'value'})).toBe('{"key":"value"}');
  });

  it('returns String(value) for empty stringify', () => {
    expect(compact(undefined)).toBe('undefined');
    expect(compact(null)).toBe('null');
  });

  it('replaces Error instances nested in objects', () => {
    const result = compact({err: new Error('nested')});
    expect(result).toContain('nested');
    expect(result).not.toContain('Error');
  });
});

describe('toolCallSummary', () => {
  it('formats bash commands', () => {
    expect(toolCallSummary('bash', {command: 'ls -la'})).toBe('bash $ ls -la');
  });

  it('includes timeout for bash commands', () => {
    expect(toolCallSummary('bash', {command: 'sleep', timeoutSeconds: 30})).toBe('bash $ sleep (timeout 30s)');
  });

  it('formats listFiles', () => {
    expect(toolCallSummary('listFiles', {path: 'src'})).toBe('listFiles src');
  });

  it('formats readFile', () => {
    expect(toolCallSummary('readFile', {path: 'foo.ts'})).toBe('readFile foo.ts');
  });

  it('formats writeFile', () => {
    expect(toolCallSummary('writeFile', {path: 'bar.ts'})).toBe('writeFile bar.ts');
  });

  it('formats editFile with edit count', () => {
    expect(toolCallSummary('editFile', {path: 'a.ts', edits: [{}]})).toBe('editFile a.ts (1 edit)');
    expect(toolCallSummary('editFile', {path: 'a.ts', edits: [{}, {}]})).toBe('editFile a.ts (2 edits)');
  });

  it('formats replaceLines with line range', () => {
    expect(toolCallSummary('replaceLines', {path: 'x.ts', startLine: 3, endLine: 5})).toBe('replaceLines x.ts:3-5');
  });

  it('falls back to generic format', () => {
    expect(toolCallSummary('custom', {data: 1})).toMatch(/^custom /);
  });
});

describe('toolResultSummary', () => {
  it('reports failure', () => {
    expect(toolResultSummary({success: false, error: 'bad'})).toBe('failed: bad');
  });

  it('reports exit code', () => {
    expect(toolResultSummary({success: true, output: {code: 1}})).toBe('exited with code 1');
  });

  it('reports completed for ok:true', () => {
    expect(toolResultSummary({success: true, output: {ok: true}})).toBe('completed');
  });

  it('reports failed for ok:false output', () => {
    expect(toolResultSummary({success: true, output: {ok: false}})).toMatch(/^failed:/);
  });

  it('reports completed for success with no output', () => {
    expect(toolResultSummary({success: true})).toBe('completed');
  });
});

describe('formatSeconds', () => {
  it('formats milliseconds to seconds with one decimal', () => {
    expect(formatSeconds(1500)).toBe('1.5s');
  });

  it('formats zero', () => {
    expect(formatSeconds(0)).toBe('0.0s');
  });

  it('formats whole seconds', () => {
    expect(formatSeconds(3000)).toBe('3.0s');
  });
});
