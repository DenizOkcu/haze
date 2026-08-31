import {describe, expect} from 'vitest';
import {evalIt, fileSha, runHazeEval, writeWorkspaceFile} from './harness.js';

/**
 * Read-only scenario: a question about the codebase must complete *without*
 * mutations and without validation gating — the completion policy is
 * intent-sensitive, and answer-intent turns must never demand post-mutation
 * validation or be blocked by it.
 */
describe('eval: answer a question without touching files', () => {
  evalIt('answers from the code and makes no mutations', {timeout: 6 * 60_000}, async () => {
    interface Setup {
      calcHash: string;
    }
    const run = await runHazeEval<Setup>({
      name: 'answer-no-mutations',
      request: 'In two sentences: what does calc.js export and what do the functions do? Answer from the source code. Do not modify any files.',
      setup(workspace): Setup {
        writeWorkspaceFile(workspace, 'package.json', JSON.stringify({name: 'eval-fixture', private: true, type: 'module', scripts: {test: 'node --test'}}, null, 2) + '\n');
        writeWorkspaceFile(workspace, 'calc.js', '/** Arithmetic helpers used by the billing service. */\nexport function add(a, b) {\n  return a + b;\n}\n\nexport function subtract(a, b) {\n  return a - b;\n}\n');
        writeWorkspaceFile(workspace, 'calc.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {add} from './calc.js';\n\ntest('add sums', () => {\n  assert.equal(add(1, 2), 3);\n});\n");
        return {calcHash: fileSha(workspace, 'calc.js')};
      },
    });

    expect(run.result.status).toBe('complete');
    expect(run.result.evidence?.mutationCount).toBe(0);
    // Answer-intent turns carry no validation requirement.
    expect(run.result.evidence?.validationOutcome).toBe('not_applicable');
    expect(fileSha(run.workspace, 'calc.js')).toBe(run.setup.calcHash);
    expect(run.assistantText.trim().length).toBeGreaterThan(0);
  });
});
