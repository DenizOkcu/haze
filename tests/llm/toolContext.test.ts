import {describe, expect, it} from 'vitest';
import {runDedupedTool} from '../../src/llm/tools/toolContext.js';

describe('toolContext', () => {
  it('deduplicates read-only inputs regardless of object key insertion order', async () => {
    const context = {};
    let executions = 0;

    const first = await runDedupedTool('readFile', {path: 'a.ts', offset: 1}, {experimental_context: context}, async () => {
      executions += 1;
      return {ok: true};
    });
    const second = await runDedupedTool('readFile', {offset: 1, path: 'a.ts'}, {experimental_context: context}, async () => {
      executions += 1;
      return {ok: true};
    });

    expect(first).toEqual({ok: true});
    expect(second).toMatchObject({ok: true, duplicateSkipped: true});
    expect(executions).toBe(1);
  });
});
