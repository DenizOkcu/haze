import {describe, expect} from 'vitest';
import {evalIt, fileSha, runHazeEval, runWorkspaceCommand, writeWorkspaceFile} from './harness.js';

/**
 * Implementation scenario: a stubbed function must be implemented so the
 * suite passes. Exercises the implement-intent completion gate — the agent may
 * only claim completion after its own validation evidence turned green.
 */
describe('eval: implement a feature with validation', () => {
  evalIt('implements the stub and proves it with the test suite', {timeout: 10 * 60_000}, async () => {
    interface Setup {
      redExitCode: number;
    }
    const run = await runHazeEval<Setup>({
      name: 'implement-with-validation',
      request: 'Implement the `median` function in math.js so the existing test suite (`npm test`) passes. Do not modify the test file.',
      async setup(workspace): Promise<Setup> {
        writeWorkspaceFile(workspace, 'package.json', JSON.stringify({name: 'eval-fixture', private: true, type: 'module', scripts: {test: 'node --test'}}, null, 2) + '\n');
        writeWorkspaceFile(workspace, 'math.js', [
          '/** Statistics helpers. */',
          '',
          '/** Return the median of a list of numbers. Not implemented yet. */',
          'export function median(values) {',
          '  return 0; // TODO: implement',
          '}',
          '',
        ].join('\n'));
        writeWorkspaceFile(workspace, 'math.test.js', [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import {median} from './math.js';",
          '',
          "test('median of an odd-length list is the middle element', () => {",
          '  assert.equal(median([3, 1, 2]), 2);',
          '});',
          '',
          "test('median of an even-length list is the mean of the middle two', () => {",
          '  assert.equal(median([4, 1, 3, 2]), 2.5);',
          '});',
          '',
        ].join('\n'));
        return {redExitCode: runWorkspaceCommand(workspace, 'npm test').exitCode};
      },
    });

    expect(run.setup.redExitCode).not.toBe(0);
    const after = runWorkspaceCommand(run.workspace, 'npm test');
    expect(after.exitCode, `npm test output after run:\n${after.stdout}`).toBe(0);
    expect(run.result.status).toBe('complete');
    expect(run.result.evidence?.validationOutcome).toBe('passed');
    expect(run.result.evidence?.mutationCount).toBeGreaterThanOrEqual(1);
  });
});
