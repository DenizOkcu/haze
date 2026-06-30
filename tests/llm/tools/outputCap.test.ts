import {describe, expect, it} from 'vitest';
import {compactGrepMatches, renderGrepMatches, capRawOutput, MAX_RAW_OUTPUT_CHARS} from '../../../src/llm/tools/outputCap.js';

type Match = {file: string; line: number; content: string; isContext: boolean};

function makeMatches(count: number): Match[] {
  return Array.from({length: count}, (_, i) => ({
    file: 'src/file.ts',
    line: i + 1,
    content: 'needle match content here',
    isContext: false,
  }));
}

describe('compactGrepMatches', () => {
  it('keeps all matches when under the budget', () => {
    const matches = makeMatches(3);
    const result = compactGrepMatches(matches, 10_000);
    expect(result.matches).toHaveLength(3);
    expect(result.omittedResultLines).toBe(0);
    expect(result.outputTruncated).toBe(false);
  });

  it('drops trailing matches once the budget is exceeded', () => {
    const matches = makeMatches(1000);
    const result = compactGrepMatches(matches, 500);
    expect(result.matches.length).toBeLessThan(matches.length);
    expect(result.omittedResultLines).toBeGreaterThan(0);
    expect(result.outputTruncated).toBe(true);
    expect(result.omittedResultLines + result.matches.length).toBe(matches.length);
  });

  it('flags line truncation when a line exceeds the per-line cap', () => {
    const matches: Match[] = [{file: 'a.ts', line: 1, content: 'x'.repeat(1000), isContext: false}];
    const result = compactGrepMatches(matches, 10_000);
    expect(result.lineTruncated).toBe(true);
    expect(result.outputTruncated).toBe(true);
    expect(result.matches[0].content.length).toBeLessThan(1000);
  });

  it('runs in linear time for large inputs', () => {
    // 5000 matches would be ~12.5M serializations under O(n²); this asserts it
    // completes quickly rather than scaling quadratically.
    const matches = makeMatches(5000);
    const start = Date.now();
    const result = compactGrepMatches(matches, 1_000_000);
    const elapsed = Date.now() - start;
    expect(result.matches.length).toBe(5000);
    // Generous bound: linear-time estimation finishes well under 1s.
    expect(elapsed).toBeLessThan(1000);
  });

  it('renders compacted matches via renderGrepMatches within the budget', () => {
    const matches = makeMatches(1000);
    const result = compactGrepMatches(matches, 2000);
    const rendered = renderGrepMatches(result.matches);
    expect(rendered.length).toBeLessThanOrEqual(2000);
  });
});

describe('capRawOutput', () => {
  it('passes output through unchanged when at or under the ceiling', () => {
    expect(capRawOutput('')).toBe('');
    expect(capRawOutput('x'.repeat(100))).toBe('x'.repeat(100));
    expect(capRawOutput('x'.repeat(MAX_RAW_OUTPUT_CHARS))).toBe('x'.repeat(MAX_RAW_OUTPUT_CHARS));
  });

  it('truncates over-long output to head + tail plus a marker, within the bound', () => {
    const text = 'A'.repeat(500);
    const capped = capRawOutput(text, 100);
    expect(capped.length).toBeLessThan(text.length);
    expect(capped).toContain('truncated');
    expect(capped.startsWith('A'.repeat(50))).toBe(true); // head
    expect(capped.endsWith('A'.repeat(50))).toBe(true); // tail
  });

  it('honours a custom maxChars split as half head / half tail', () => {
    // maxChars 5 -> head 2, tail 3
    const capped = capRawOutput('0123456789', 5);
    expect(capped.startsWith('01')).toBe(true);
    expect(capped.endsWith('789')).toBe(true);
    expect(capped).toContain('5 characters');
  });
});
