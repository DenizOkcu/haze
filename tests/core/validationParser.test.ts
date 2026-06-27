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

  it('extracts cargo test failures', () => {
    const stdout = [
      'running 2 tests',
      'test tests::it_works ... ok',
      'test tests::it_fails ... FAILED',
      '',
      'failures:',
      '',
      '---- tests::it_fails stdout ----',
      'thread panicked',
      '',
      'failures:',
      '    tests::it_fails',
      '',
      'test result: FAILED. 1 passed; 1 failed; 0 ignored',
    ].join('\n');
    const summary = parseValidationOutput({command: 'cargo test', code: 101, stdout, stderr: ''});
    expect(summary.kind).toBe('test');
    expect(summary.status).toBe('failed');
    expect(summary.failedTests).toContain('tests::it_fails');
    expect(summary.summaryText).toContain('1 failed test');
  });

  it('extracts cargo clippy diagnostics', () => {
    const stdout = [
      'error[E0499]: cannot borrow `x` as mutable more than once at a time',
      ' --> src/lib.rs:10:5',
      '  |',
      '10 |     x.push(1);',
      '   |     ^^^^^^^^^',
      '',
      'error: could not compile `foo`',
    ].join('\n');
    const summary = parseValidationOutput({command: 'cargo clippy', code: 101, stdout, stderr: ''});
    expect(summary.kind).toBe('lint');
    expect(summary.status).toBe('failed');
    expect(summary.diagnostics[0]).toMatchObject({file: 'src/lib.rs', line: 10, column: 5, severity: 'error'});
    expect(summary.failedFiles).toContain('src/lib.rs');
  });
});
