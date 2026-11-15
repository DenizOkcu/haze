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

  it('includes first distinct failure lines in failed summaries (RT-04)', () => {
    // The live review session saw release:verify summarized as "10 failed
    // tests" while the handle held 32 distinct mismatches; the distinct
    // failure lines must ride the summary itself.
    const stdout = [
      '✗ package-lock.json: root version "1.2.0" does not match package.json "1.2.1".',
      '✗ README.md: does not reference version "1.2.1".',
      '✗ docs/index.html: does not reference version "1.2.1".',
      '✗ AGENTS.md: stamp does not target release 1.2.1.',
    ].join('\n');
    const summary = parseValidationOutput({command: 'npm run release:verify', code: 1, stdout, stderr: ''});
    expect(summary.status).toBe('failed');
    expect(summary.summaryText).toContain('package-lock.json');
    expect(summary.summaryText).toContain('README.md');
    expect(summary.summaryText).toContain('docs/index.html');
    // Bounded: at most three distinct lines inline.
    expect(summary.summaryText).not.toContain('AGENTS.md');
  });

  it('does not append failure lines to passing summaries (RT-04)', () => {
    const summary = parseValidationOutput({command: 'npm test', code: 0, stdout: 'Tests: 3 passed, 0 failed\n', stderr: ''});
    expect(summary.summaryText).toBe('test passed');
  });

  it('marks failed tests as failed even when a pipe swallows the exit code', () => {
    // Reproduces the regression seen in the 2026-06-13 session log: the
    // agent ran `npm test 2>&1 | tail -50`, jest exited non-zero, but the shell
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

  it('keeps a warnings-only lint run green (warnings are not failure evidence)', () => {
    // ESLint exits 0 when only warn-level rules fire; warning diagnostics
    // must not flip the status to failed nor populate failedFiles — that
    // would feed the completion gate a false red and force spurious work.
    const stdout = [
      'src/a.ts',
      '  3:9  warning  no-unused-vars  @typescript-eslint/no-unused-vars',
      '',
      '✖ 0 problems (0 errors, 1 warning)',
    ].join('\n');
    const summary = parseValidationOutput({command: 'npm run lint', code: 0, stdout, stderr: ''});
    expect(summary.kind).toBe('lint');
    expect(summary.status).toBe('passed');
    expect(summary.failedFiles).toEqual([]);
    expect(summary.diagnostics[0]).toMatchObject({severity: 'warning'});
  });

  it('does not list passing vitest files as failed files on a green run', () => {
    const stdout = [
      ' ✓ tests/core/sessionStore.test.ts (12 tests) 24ms',
      ' ✓ tests/cli/formatters.test.ts (8 tests) 10ms',
      '',
      ' Test Files  2 passed (2)',
      '      Tests  20 passed (20)',
    ].join('\n');
    const summary = parseValidationOutput({command: 'npm test', code: 0, stdout, stderr: ''});
    expect(summary.status).toBe('passed');
    expect(summary.failedFiles).toEqual([]);
    expect(summary.failedTests).toEqual([]);
  });

  it('does not false-positive on a passing test suite that prints bullet points', () => {
    const stdout = 'PASS tests/foo.test.ts\n  - helper output for debugging\nTests: 5 passed\n';
    const summary = parseValidationOutput({command: 'npm test', code: 0, stdout, stderr: ''});
    expect(summary.status).toBe('passed');
  });

  it('detects repeated eslint file headers', () => {
    const stdout = ['src/a.ts', 'not-a-diagnostic-line', 'src/a.ts', '  1:5  error  no-undef'].join('\n');
    const summary = parseValidationOutput({command: 'npm run lint', code: 1, stdout, stderr: ''});
    expect(summary.failedFiles).toContain('src/a.ts');
  });
});
