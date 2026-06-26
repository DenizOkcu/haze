import {describe, expect, it} from 'vitest';
import {reduceGenericLogOutput, reduceJsonOutput, reduceUnifiedDiffOutput} from '../../../../src/core/bashOutput/reducers/content.js';

describe('reduceJsonOutput', () => {
  it('returns undefined when stdout is not JSON', () => {
    expect(reduceJsonOutput('hello world', '')).toBeUndefined();
    expect(reduceJsonOutput('', 'plain stderr')).toBeUndefined();
  });

  it('returns undefined for small JSON arrays below the threshold', () => {
    const small = JSON.stringify([{id: 1}, {id: 2}, {id: 3}]);
    expect(reduceJsonOutput(small, '')).toBeUndefined();
  });

  it('returns undefined for small JSON objects below the length threshold', () => {
    const obj = JSON.stringify({a: 1, b: 2});
    expect(reduceJsonOutput(obj, '')).toBeUndefined();
  });

  it('summarizes large JSON arrays with common keys and sampled records', () => {
    const items = Array.from({length: 20}, (_, index) => ({id: index, status: index === 7 ? 'error' : 'ok', repeated: 'same'}));
    const stdout = JSON.stringify(items);
    const result = reduceJsonOutput(stdout, '');
    expect(result).toBeDefined();
    const summary = JSON.parse(result!);
    expect(summary.jsonSummary.type).toBe('array');
    expect(summary.jsonSummary.items).toBe(20);
    expect(summary.jsonSummary.commonKeys).toContain('id');
    expect(summary.jsonSummary.commonKeys).toContain('status');
    expect(summary.jsonSummary.commonKeys).toContain('repeated');
    expect(summary.jsonSummary.omittedItems).toBeGreaterThan(0);
    expect(Array.isArray(summary.jsonSummary.sample)).toBe(true);
    const sampleValues = summary.jsonSummary.sample.map((entry: {value: {id?: number}}) => entry.value);
    expect(sampleValues.some((entry: {id?: number}) => entry.id === 7)).toBe(true);
  });

  it('flags anomaly indexes for items containing error/warn/fail signals', () => {
    const items = Array.from({length: 15}, (_, index) => ({
      id: index,
      status: index === 5 ? 'denied' : 'ok',
    }));
    const summary = JSON.parse(reduceJsonOutput(JSON.stringify(items), '')!);
    const indexes = summary.jsonSummary.sample.map((entry: {index: number}) => entry.index);
    expect(indexes).toContain(5);
  });

  it('reads JSON from stderr when stdout is empty', () => {
    const result = reduceJsonOutput('', JSON.stringify([{k: 'v'}, {k: 'w'}]));
    expect(result).toBeUndefined();
  });

  it('summarizes large JSON objects by keys and nested samples', () => {
    const big = JSON.stringify({first: 'a'.repeat(4000), nested: {deep: 'value'}});
    const summary = JSON.parse(reduceJsonOutput(big, '')!);
    expect(summary.jsonSummary).toBeDefined();
    expect(Array.isArray(summary.jsonSummary.keys)).toBe(true);
  });

  it('respects the 70% commonKeys threshold and caps at 30 keys', () => {
    const items = Array.from({length: 20}, (_, index) => ({
      shared: 's',
      occasionallyDifferent: index % 7 === 0 ? 'special' : 'normal',
      extra: `e${index}`,
      rare: index === 0 ? 'r' : 'x',
    }));
    const summary = JSON.parse(reduceJsonOutput(JSON.stringify(items), '')!);
    expect(summary.jsonSummary.commonKeys).toContain('shared');
    expect(summary.jsonSummary.commonKeys.length).toBeLessThanOrEqual(30);
  });

  it('truncates object keys beyond 20 and reports omittedKeys', () => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < 50; i++) obj[`key-${i}-${'x'.repeat(80)}`] = `value-${'y'.repeat(80)}`;
    const big = JSON.stringify(obj);
    expect(big.length).toBeGreaterThan(4000);
    const summary = JSON.parse(reduceJsonOutput(big, '')!);
    expect(summary.jsonSummary.keys).toHaveLength(50);
    const expanded = Object.keys(summary.jsonSummary).filter(name => name !== 'keys' && name !== 'omittedKeys');
    expect(expanded.length).toBeLessThanOrEqual(20);
    expect(summary.jsonSummary.omittedKeys).toBe(30);
  });
});

describe('reduceUnifiedDiffOutput', () => {
  it('returns undefined for non-diff text', () => {
    expect(reduceUnifiedDiffOutput('hello world', '')).toBeUndefined();
  });

  it('returns undefined for short diffs that do not need summarization', () => {
    const tiny = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n';
    expect(reduceUnifiedDiffOutput(tiny, '')).toBeUndefined();
  });

  it('summarizes multi-file diffs with totals and per-file hunks', () => {
    const lines = [
      'diff --git a/src/a.txt b/src/a.txt',
      'index 111..222 100644',
      '--- a/src/a.txt',
      '+++ b/src/a.txt',
      '@@ -1,3 +1,4 @@',
      ' context',
      '-old',
      '+new',
      '+another',
      'diff --git a/src/b.txt b/src/b.txt',
      '@@ -10,2 +10,2 @@',
      '-x',
      '+y',
    ];
    for (let i = 0; i < 80; i++) lines.push(` context filler ${i}`);
    const stdout = lines.join('\n');
    const result = reduceUnifiedDiffOutput(stdout, '');
    expect(result).toBeDefined();
    expect(result).toContain('diff: 2 files changed, +3/-2');
    expect(result).toContain('src/a.txt +2/-1');
    expect(result).toContain('@@ -1,3 +1,4 @@');
  });

  it('caps body excerpts at 8 lines per file and hunk lines at 4', () => {
    const lines = ['diff --git a/big.txt b/big.txt', '@@ -1,20 +1,20 @@'];
    for (let i = 0; i < 15; i++) lines.push(`+added line ${i}`);
    for (let i = 0; i < 15; i++) lines.push(`-removed line ${i}`);
    for (let i = 0; i < 50; i++) lines.push(` context ${i}`);
    const stdout = lines.join('\n');
    const result = reduceUnifiedDiffOutput(stdout, '');
    const addedMatches = (result!.match(/\+added line/g) ?? []).length;
    expect(addedMatches).toBeLessThanOrEqual(8);
  });

  it('falls back to stderr when stdout is empty', () => {
    const lines = ['diff --git a/a.txt b/a.txt', '@@ -1 +1 @@', '-old', '+new'];
    for (let i = 0; i < 80; i++) lines.push(`context ${i}`);
    const stderr = lines.join('\n');
    expect(reduceUnifiedDiffOutput('', stderr)).toBeDefined();
  });

  it('handles +++ and --- lines without inflating counts', () => {
    const lines = [
      'diff --git a/src/foo.txt b/src/foo.txt',
      '--- a/src/foo.txt',
      '+++ b/src/foo.txt',
      '@@ -1,1 +1,2 @@',
      ' unchanged',
      '+new',
    ];
    for (let i = 0; i < 80; i++) lines.push(`context filler ${i}`);
    const result = reduceUnifiedDiffOutput(lines.join('\n'), '');
    expect(result).toContain('+1/-0');
  });
});

describe('reduceGenericLogOutput', () => {
  it('returns undefined for short logs', () => {
    const small = Array.from({length: 50}, (_, index) => `info ${index}`).join('\n');
    expect(reduceGenericLogOutput(small, '')).toBeUndefined();
  });

  it('summarizes large logs around signal lines (error/warn/fail/timeout/...)', () => {
    const lines = [
      ...Array.from({length: 80}, (_, index) => `info noise ${index}`),
      'ERROR failed to connect',
      '  at connect (src/client.ts:10:2)',
      ...Array.from({length: 80}, (_, index) => `info tail ${index}`),
      '1 failed, 120 passed',
    ];
    const result = reduceGenericLogOutput(lines.join('\n'), '');
    expect(result).toBeDefined();
    expect(result).toContain('log summary:');
    expect(result).toContain('ERROR failed to connect');
    expect(result).toContain('1 failed, 120 passed');
  });

  it('captures signal context within a window around the match', () => {
    const lines = [
      'before 1',
      'before 2',
      'before 3',
      'context-A',
      'context-B',
      'ERROR boom',
      'after 1',
      'after 2',
      'after 3',
      'after 4',
      'after 5',
    ];
    const filler = Array.from({length: 130}, (_, index) => `noise ${index}`).join('\n');
    const text = [...lines, filler].join('\n');
    const result = reduceGenericLogOutput(text, '');
    expect(result).toContain('context-A');
    expect(result).toContain('context-B');
    expect(result).toContain('ERROR boom');
    expect(result).toContain('after 1');
  });

  it('reports omitted line count when not every line is captured', () => {
    const lines = ['noise 1', 'noise 2', 'ERROR problem', 'noise 3', 'noise 4'];
    const filler = Array.from({length: 200}, (_, index) => `noise ${index}`).join('\n');
    const result = reduceGenericLogOutput([...lines, filler].join('\n'), '');
    expect(result).toContain('non-signal lines omitted');
  });

  it('matches additional signal words: warning, fatal, exception, panic, denied, traceback', () => {
    const filler = Array.from({length: 130}, (_, index) => `noise ${index}`).join('\n');
    for (const signal of ['WARN something', 'FATAL crash', 'exception thrown', 'traceback (most recent call last)', 'permission denied', 'panic: runtime error', 'assert failed', 'timed out']) {
      const result = reduceGenericLogOutput([filler, signal, filler].join('\n'), '');
      expect(result, `expected ${signal} to be picked up`).toContain(signal);
    }
  });

  it('returns undefined when no signal lines are present in a large log', () => {
    const lines = Array.from({length: 200}, (_, index) => `boring log entry ${index}`);
    expect(reduceGenericLogOutput(lines.join('\n'), '')).toBeUndefined();
  });

  it('combines stdout and stderr when both contribute signal lines', () => {
    const stdout = Array.from({length: 130}, (_, index) => `noise ${index}`).join('\n');
    const stderr = 'WARN from stderr';
    const result = reduceGenericLogOutput(stdout, stderr);
    expect(result).toContain('WARN from stderr');
  });
});
