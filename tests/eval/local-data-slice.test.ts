import {describe, expect} from 'vitest';
import {evalIt, runHazeEval, runWorkspaceCommand, writeWorkspaceFile} from './harness.js';

/** A small local-model slice: two public operations, one data fixture, no network or framework setup. */
describe('eval: local data slice', () => {
  evalIt('implements both operations and closes its outcome list with passing contracts', {timeout: 10 * 60_000}, async () => {
    const run = await runHazeEval({
      name: 'local-data-slice',
      request: 'Build the first runnable slice of a local ingredient recommendation service. Implement both exported operations in src/ingredients.js: pairings(name) returns useful pairings and substitute(name) returns a close replacement. Use the local data in data/ingredients.json; do not fetch a remote model or change the contract tests. Declare the two user-visible outcomes with writeTasks, run npm test after the slice, and report any coverage gap honestly.',
      setup(workspace) {
        writeWorkspaceFile(workspace, 'package.json', JSON.stringify({name: 'local-data-slice', private: true, type: 'module', scripts: {test: 'node --test'}}, null, 2) + '\n');
        writeWorkspaceFile(workspace, 'data/ingredients.json', JSON.stringify({
          tomato: {pairings: ['basil', 'garlic'], substitute: 'red pepper'},
          basil: {pairings: ['tomato', 'garlic'], substitute: 'oregano'},
        }, null, 2) + '\n');
        writeWorkspaceFile(workspace, 'src/ingredients.js', 'export function pairings(name) { throw new Error("not implemented"); }\nexport function substitute(name) { throw new Error("not implemented"); }\n');
        writeWorkspaceFile(workspace, 'src/ingredients.test.js', [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import {pairings, substitute} from './ingredients.js';",
          "test('pairings covers a known ingredient', () => assert.deepEqual(pairings('Tomato'), ['basil', 'garlic']));",
          "test('substitute covers a known ingredient', () => assert.equal(substitute('BASIL'), 'oregano'));",
          "test('unknown ingredients are handled without fabricated results', () => { assert.deepEqual(pairings('unknown'), []); assert.equal(substitute('unknown'), null); });",
          '',
        ].join('\n'));
      },
    });

    expect(runWorkspaceCommand(run.workspace, 'npm test').exitCode).toBe(0);
    expect(run.result.status).toBe('complete');
    expect(run.result.evidence?.validationOutcome).toBe('passed');
    expect(run.goalLedger.at(-1)?.taskCounts).toMatchObject({pending: 0, inProgress: 0});
    expect(run.goalLedger.at(-1)?.gateDecision).toBe('ready');
  });
});
