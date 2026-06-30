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

  it('extracts go test failures and diagnostics', () => {
    const stdout = [
      '--- FAIL: TestAdd (0.00s)',
      '    calc_test.go:10: expected 3, got 4',
      'FAIL',
      'exit status 1',
      'FAIL\texample.com/foo\t0.001s',
    ].join('\n');
    const stderr = 'calc.go:15:5: undefined: add\ncalc.go:20: undefined: sub\n';
    const summary = parseValidationOutput({command: 'go test ./...', code: 1, stdout, stderr});
    expect(summary.kind).toBe('test');
    expect(summary.status).toBe('failed');
    expect(summary.failedTests).toContain('TestAdd');
    expect(summary.diagnostics[0]).toMatchObject({file: 'calc.go', line: 15, column: 5, severity: 'error'});
    expect(summary.diagnostics[1]).toMatchObject({file: 'calc.go', line: 20, column: undefined, severity: 'error'});
  });

  it('extracts pytest failures in verbose and short form', () => {
    const stdout = [
      'tests/test_foo.py::test_bar FAILED',
      'tests/test_foo.py::test_baz PASSED',
      '',
      '=========================== short test summary info ============================',
      'FAILED tests/test_foo.py::test_qux - AssertionError: 1 != 2',
    ].join('\n');
    const summary = parseValidationOutput({command: 'pytest -v', code: 1, stdout, stderr: ''});
    expect(summary.kind).toBe('test');
    expect(summary.status).toBe('failed');
    expect(summary.failedTests).toContain('tests/test_foo.py::test_bar');
    expect(summary.failedTests).toContain('tests/test_foo.py::test_qux');
    expect(summary.failedFiles).toContain('tests/test_foo.py');
  });

  it('extracts mypy diagnostics', () => {
    const stdout = [
      'src/foo.py:10: error: Incompatible return value type (got "str", expected "int")',
      'src/bar.py:5: error: Name "x" is not defined',
      'src/bar.py:7: note: Perhaps you meant "y"',
      'Found 2 errors in 2 files (checked 5 source files)',
    ].join('\n');
    const summary = parseValidationOutput({command: 'mypy src', code: 1, stdout, stderr: ''});
    expect(summary.kind).toBe('typecheck');
    expect(summary.status).toBe('failed');
    expect(summary.diagnostics).toHaveLength(2);
    expect(summary.diagnostics[0]).toMatchObject({file: 'src/foo.py', line: 10, severity: 'error'});
  });

  it('extracts ruff diagnostics', () => {
    const stdout = 'src/foo.py:10:5: E501 Line too long (120 > 88)\n';
    const summary = parseValidationOutput({command: 'ruff check src', code: 1, stdout, stderr: ''});
    expect(summary.kind).toBe('lint');
    expect(summary.status).toBe('failed');
    expect(summary.diagnostics[0]).toMatchObject({
      file: 'src/foo.py',
      line: 10,
      column: 5,
      severity: 'error',
      message: expect.stringContaining('E501'),
    });
  });

  it('extracts python unittest failure names', () => {
    const stdout = [
      '======================================================================',
      'FAIL: test_bar (tests.test_foo.TestFoo)',
      '----------------------------------------------------------------------',
      'Traceback (most recent call last):',
      '  File "/path/tests/test_foo.py", line 10, in test_bar',
      '    self.assertEqual(1, 2)',
      'AssertionError: 1 != 2',
      '',
      '----------------------------------------------------------------------',
      'Ran 1 test in 0.000s',
      '',
      'FAILED (failures=1)',
    ].join('\n');
    const summary = parseValidationOutput({command: 'python -m unittest', code: 1, stdout, stderr: ''});
    expect(summary.kind).toBe('test');
    expect(summary.status).toBe('failed');
    expect(summary.failedTests).toContain('test_bar (tests.test_foo.TestFoo)');
  });

  it('reports passing cargo test runs', () => {
    const stdout = [
      'running 3 tests',
      'test tests::one ... ok',
      'test tests::two ... ok',
      'test tests::three ... ok',
      '',
      'test result: ok. 3 passed; 0 failed; 0 ignored',
    ].join('\n');
    const summary = parseValidationOutput({command: 'cargo test', code: 0, stdout, stderr: ''});
    expect(summary.kind).toBe('test');
    expect(summary.status).toBe('passed');
    expect(summary.summaryText).toBe('test passed');
  });

  it('reports passing go test runs', () => {
    const stdout = 'ok\texample.com/foo\t0.001s\n';
    const summary = parseValidationOutput({command: 'go test ./...', code: 0, stdout, stderr: ''});
    expect(summary.kind).toBe('test');
    expect(summary.status).toBe('passed');
  });

  it('reports passing pytest runs', () => {
    const stdout = 'tests/test_foo.py::test_bar PASSED\ntests/test_foo.py::test_baz PASSED\n\n2 passed\n';
    const summary = parseValidationOutput({command: 'pytest -v', code: 0, stdout, stderr: ''});
    expect(summary.kind).toBe('test');
    expect(summary.status).toBe('passed');
  });

  it('reports passing mypy runs', () => {
    const stdout = 'Success: no issues found in 5 source files\n';
    const summary = parseValidationOutput({command: 'mypy src', code: 0, stdout, stderr: ''});
    expect(summary.kind).toBe('typecheck');
    expect(summary.status).toBe('passed');
  });

  it('extracts cargo clippy warnings', () => {
    const stdout = [
      'warning: unused variable: `x`',
      ' --> src/lib.rs:10:5',
      '  |',
      '10 |     let x = 1;',
      '   |     ^^^^^^^^^',
      '',
      'error: aborting due to 1 previous error',
    ].join('\n');
    const summary = parseValidationOutput({command: 'cargo clippy', code: 101, stdout, stderr: ''});
    expect(summary.kind).toBe('lint');
    expect(summary.status).toBe('failed');
    expect(summary.diagnostics).toHaveLength(1);
    expect(summary.diagnostics[0]).toMatchObject({file: 'src/lib.rs', line: 10, column: 5, severity: 'warning'});
    expect(summary.failedFiles).toContain('src/lib.rs');
  });

  it('does not treat go-like stdout as diagnostics', () => {
    const stdout = 'debug: main.go:42: value\nPASS\n';
    const summary = parseValidationOutput({command: 'go test ./...', code: 0, stdout, stderr: ''});
    expect(summary.status).toBe('passed');
    expect(summary.diagnostics).toHaveLength(0);
  });
});
