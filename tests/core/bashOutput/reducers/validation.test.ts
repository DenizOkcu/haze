import {describe, expect, it} from 'vitest';
import {renderValidationReduction} from '../../../../src/core/bashOutput/reducers/validation.js';
import type {ValidationSummary} from '../../../../src/llm/toolResultTypes.js';

function summary(overrides: Partial<ValidationSummary> = {}): ValidationSummary {
  return {
    kind: 'test',
    status: 'failed',
    failedFiles: [],
    failedTests: [],
    diagnostics: [],
    summaryText: 'test failed',
    rawOutputTruncated: false,
    ...overrides,
  };
}

describe('renderValidationReduction', () => {
  it('always renders the summary text first', () => {
    expect(renderValidationReduction(summary({summaryText: 'all tests passed'}))).toContain('all tests passed');
  });

  it('caps the failed-tests list at 10 entries', () => {
    const failedTests = Array.from({length: 25}, (_, index) => `TestFailure${index}`);
    const out = renderValidationReduction(summary({failedTests}));
    expect(out).toContain('failed tests:');
    const listed = out.split('\n').filter(line => line.startsWith('  - TestFailure')).length;
    expect(listed).toBe(10);
    expect(out).not.toContain('TestFailure14');
  });

  it('groups diagnostics by file and shows location, severity, and message', () => {
    const out = renderValidationReduction(summary({
      diagnostics: [
        {file: 'src/a.ts', line: 12, column: 3, severity: 'error', message: 'undefined is not a function'},
        {file: 'src/a.ts', line: 40, severity: 'warning', message: 'unused variable'},
        {file: 'src/b.ts', line: 5, severity: 'error', message: 'cannot find module'},
      ],
    }));
    expect(out).toContain('diagnostics:');
    expect(out).toContain('src/a.ts');
    expect(out).toContain('12:3 error undefined is not a function');
    expect(out).toContain('40 warning unused variable');
    expect(out).toContain('src/b.ts');
  });

  it('uses ? for missing line numbers and omits column when undefined', () => {
    const out = renderValidationReduction(summary({
      diagnostics: [
        {file: 'src/a.ts', severity: 'error', message: 'parse failure'},
      ],
    }));
    expect(out).toContain('? error parse failure');
  });

  it('caps the total number of diagnostics emitted at 20', () => {
    const diagnostics = Array.from({length: 30}, (_, index) => ({
      file: index % 3 === 0 ? 'src/a.ts' : 'src/b.ts',
      line: index + 1,
      severity: 'error' as const,
      message: `error ${index}`,
    }));
    const out = renderValidationReduction(summary({diagnostics}));
    const counted = out.split('\n').filter(line => /^\s+\d+(:\d+)?\s+error\s+error\s\d+/.test(line)).length;
    expect(counted).toBe(20);
  });

  it('shows failed files when diagnostics are empty and failedFiles is non-empty', () => {
    const out = renderValidationReduction(summary({failedFiles: ['tests/x_test.go', 'tests/y_test.go']}));
    expect(out).toContain('failed files: tests/x_test.go, tests/y_test.go');
  });

  it('does not show failed files when diagnostics were emitted', () => {
    const out = renderValidationReduction(summary({
      failedFiles: ['tests/x_test.go'],
      diagnostics: [{file: 'src/a.ts', line: 1, severity: 'error', message: 'x'}],
    }));
    expect(out).not.toContain('failed files:');
  });

  it('appends the suggested next step when present', () => {
    const out = renderValidationReduction(summary({suggestedNextStep: 'Fix tests/x_test.go first.'}));
    expect(out).toContain('next: Fix tests/x_test.go first.');
  });

  it('appends a raw-output handle pointer when a handle is provided', () => {
    const out = renderValidationReduction(summary({}), 'h-123');
    expect(out).toContain('raw output: use readToolOutput with handle h-123');
  });

  it('omits the raw-output handle when not provided', () => {
    const out = renderValidationReduction(summary({}));
    expect(out).not.toContain('raw output');
  });
});
