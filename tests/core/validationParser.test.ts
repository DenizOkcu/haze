import {performance} from 'node:perf_hooks';
import {describe, expect, it} from 'vitest';
import {parseValidationOutput} from '../../src/core/validation/outputParser.js';

describe('validation output parser', () => {
  it('extracts TypeScript diagnostics', () => {
    const summary = parseValidationOutput({
      command: 'npm run typecheck',
      code: 2,
      stdout: 'src/foo.ts(10,5): error TS2322: Type string is not assignable to type number.\n',
      stderr: '',
    });
    expect(summary.kind).toBe('typecheck');
    expect(summary.status).toBe('failed');
    expect(summary.failedFiles).toContain('src/foo.ts');
    expect(summary.diagnostics[0]).toMatchObject({file: 'src/foo.ts', line: 10, column: 5, severity: 'error'});
    expect(summary.suggestedNextStep).toContain('src/foo.ts');
  });

  it('summarizes passing tests', () => {
    const summary = parseValidationOutput({command: 'npm test', code: 0, stdout: 'PASS tests/foo.test.ts\n', stderr: ''});
    expect(summary.kind).toBe('test');
    expect(summary.status).toBe('passed');
    expect(summary.summaryText).toBe('test passed');
  });

  it('marks failed tests as failed even when a pipe swallows the exit code', () => {
    // Reproduces the regression seen in the 2026-06-13 session log: the
    // agent ran `npm test 2>&1 | tail -50`, jest exited non-zero, but bash
    // returned tail's exit code (0). The parser still extracted the failed
    // tests, so that evidence must override the green exit code.
    const stdout = [
      'FAIL tests/evaluator.test.js',
      '  ● Evaluator - power and factorial › postfix factorial',
      '',
      '    CalcError: Unexpected character: "!"',
      '',
      'Test Suites: 1 failed, 1 passed, 2 total',
      'Tests:       2 failed, 42 passed, 44 total',
    ].join('\n');
    const summary = parseValidationOutput({command: 'npm test 2>&1 | tail -50', code: 0, stdout, stderr: ''});
    expect(summary.kind).toBe('test');
    expect(summary.status).toBe('failed');
    expect(summary.failedTests.length).toBeGreaterThan(0);
    expect(summary.summaryText).toContain('failed');
    expect(summary.suggestedNextStep).toBeDefined();
  });

  it('does not false-positive on a passing test suite that prints bullet points', () => {
    const stdout = 'PASS tests/foo.test.ts\n  - helper output for debugging\nTests: 5 passed\n';
    const summary = parseValidationOutput({command: 'npm test', code: 0, stdout, stderr: ''});
    expect(summary.status).toBe('passed');
  });

  it('detects eslint file headers even when a filename repeats (indexOf lookahead regression)', () => {
    // The parser used `lines[lines.indexOf(line) + 1]` to peek at the line after
    // an eslint file header. `indexOf` returns the *first* matching index, so a
    // repeated header peeked at the wrong neighbour and missed the real
    // diagnostic on the later occurrence. Index-based lookahead fixes both this
    // correctness bug and the O(n²) cost of the scan.
    const stdout = ['src/a.ts', 'not-a-diagnostic-line', 'src/a.ts', '  1:5  error  no-undef', ''].join('\n');
    const summary = parseValidationOutput({command: 'npm run lint', code: 1, stdout, stderr: ''});
    expect(summary.failedFiles).toContain('src/a.ts');
  });

  it('stays linear on large eslint output (O(n²) indexOf regression)', () => {
    // A *ratio* between two input sizes — not an absolute wall-clock budget —
    // makes the linearity guard machine-independent: runner load, virtualization,
    // and Node-version differences slow the small and large parse by the same
    // factor, so the ratio is invariant to them. Only an algorithmic regression
    // (O(n) → O(n²)) shifts it. We take the best of a few runs so a one-off
    // GC/scheduler spike on either measurement can't skew the ratio, and use
    // sub-millisecond `performance.now()` so the small sample isn't dominated by
    // `Date.now()`'s 1ms granularity.
    //
    // Headers are UNIQUE (so a reintroduced `lines.indexOf(line)` really scans to
    // the current position each time, not the first match) and the inputs stay
    // UNDER the parser's raw cap, so the measured cost is pure per-line parsing
    // rather than the cap — an earlier 50k-header variant got capped to ~200k
    // chars before parsing, which hid a reintroduced quadratic scan entirely.
    const build = (count: number) => {
      const out: string[] = [];
      for (let index = 0; index < count; index++) {
        out.push(`f${index}.ts`);
        out.push(`  ${index + 1}:1 error e${index}`);
      }
      return out.join('\n');
    };
    const parse = (stdout: string) => parseValidationOutput({command: 'npm run lint', code: 1, stdout, stderr: ''});
    const bestMs = (fn: () => unknown, runs = 4) => {
      let best = Infinity;
      for (let run = 0; run < runs; run++) {
        const start = performance.now();
        fn();
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };

    const smallCount = 500;
    const largeCount = 6_500; // 13x more headers; ~170k chars, under the raw cap
    const large = parse(build(largeCount)); // correctness (untimed)
    const tSmall = bestMs(() => parse(build(smallCount)));
    const tLarge = bestMs(() => parse(build(largeCount)));

    expect(large.failedFiles).toContain('f0.ts'); // correctness anchor
    // 13x input ⇒ linear ratio ≈ 13, quadratic ratio ≈ 169. A 50 threshold sits
    // ~3.8x above the linear baseline (immune to multiplicative CI slowdown) and
    // well below quadratic, so only a real complexity regression crosses it.
    expect(tLarge / tSmall).toBeLessThan(50);
  }, 15_000);
});
