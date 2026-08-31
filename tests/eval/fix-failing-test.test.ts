import {describe, expect} from 'vitest';
import {evalIt, fileSha, runHazeEval, runWorkspaceCommand, writeWorkspaceFile} from './harness.js';

/**
 * Canonical autonomy scenario: diagnose a failing suite, fix the bug, prove it
 * with the project's own test command. Asserts deterministic ground truth
 * (the fixture's `npm test` actually passes afterwards and the test file is
 * untampered) plus the structured goal envelope (evidence-gated completion
 * must have observed a passing validation before allowing `complete`).
 */
describe('eval: fix a failing test (red→green)', () => {
  evalIt('diagnoses, fixes the bug, and proves it with npm test', {timeout: 10 * 60_000}, async () => {
    interface Setup {
      redExitCode: number;
      testFileHash: string;
    }
    const run = await runHazeEval<Setup>({
      name: 'fix-failing-test',
      request: 'The test suite in this repository fails. Find the bug, fix the source (not the test), and make `npm test` pass.',
      async setup(workspace): Promise<Setup> {
        writeWorkspaceFile(workspace, 'package.json', JSON.stringify({name: 'eval-fixture', private: true, type: 'module', scripts: {test: 'node --test'}}, null, 2) + '\n');
        writeWorkspaceFile(workspace, 'calc.js', [
          '/** Small arithmetic helpers. */',
          'export function add(a, b) {',
          '  return a - b; // BUG: subtraction instead of addition',
          '}',
          '',
          'export function multiply(a, b) {',
          '  return a * b;',
          '}',
          '',
        ].join('\n'));
        writeWorkspaceFile(workspace, 'calc.test.js', [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import {add, multiply} from './calc.js';",
          '',
          "test('add sums two numbers', () => {",
          '  assert.equal(add(2, 3), 5);',
          '});',
          '',
          "test('multiply multiplies two numbers', () => {",
          '  assert.equal(multiply(2, 3), 6);',
          '});',
          '',
        ].join('\n'));
        const red = runWorkspaceCommand(workspace, 'npm test');
        return {redExitCode: red.exitCode, testFileHash: fileSha(workspace, 'calc.test.js')};
      },
    });

    // Precondition: the fixture really was red before the agent ran.
    expect(run.setup.redExitCode).not.toBe(0);
    // Ground truth: green after the run, without touching the test file.
    expect(runWorkspaceCommand(run.workspace, 'npm test').exitCode, `npm test output after run:\n${runWorkspaceCommand(run.workspace, 'npm test').stdout}`).toBe(0);
    expect(fileSha(run.workspace, 'calc.test.js')).toBe(run.setup.testFileHash);
    // Structured envelope: completed only after a passing validation was observed.
    expect(run.result.status).toBe('complete');
    expect(run.result.evidence?.validationOutcome).toBe('passed');
    expect(run.result.evidence?.mutationCount).toBeGreaterThanOrEqual(1);
  });
});
