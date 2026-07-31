import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {discoverScopedContext, runDedupedTool, type HazeToolContext} from '../../src/llm/tools/toolContext.js';
import {WorkspaceMutationPolicy} from '../../src/core/subagent/workspaceMutationPolicy.js';

let originalCwd: string | undefined;
let tmp: string | undefined;

afterEach(async () => {
  if (originalCwd) process.chdir(originalCwd);
  originalCwd = undefined;
  if (tmp) await fs.remove(tmp);
  tmp = undefined;
});

describe('toolContext', () => {
  it('deduplicates read-only inputs regardless of object key insertion order', async () => {
    const context = {};
    let executions = 0;

    const first = await runDedupedTool('readFile', {path: 'a.ts', offset: 1}, {context: context}, async () => {
      executions += 1;
      return {ok: true};
    });
    const second = await runDedupedTool('readFile', {offset: 1, path: 'a.ts'}, {context: context}, async () => {
      executions += 1;
      return {ok: true};
    });

    expect(first).toEqual({ok: true});
    expect(second).toMatchObject({ok: true, duplicateSkipped: true});
    expect(executions).toBe(1);
  });

  it('serializes concurrent main-turn file mutation and bash under the workspace policy', async () => {
    const context: HazeToolContext = {mutationPolicy: new WorkspaceMutationPolicy()};
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const order: string[] = [];
    const first = runDedupedTool('editFile', {path: 'a.ts'}, {context}, async () => { order.push('edit-start'); await firstGate; order.push('edit-end'); return {ok: true}; });
    await Promise.resolve();
    const second = runDedupedTool('bash', {command: 'npm test'}, {context}, async () => { order.push('bash'); return {ok: true}; });
    await Promise.resolve();
    expect(order).toEqual(['edit-start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['edit-start', 'edit-end', 'bash']);
  });

  it('serializes concurrent scoped context discovery so an unchanged file is read once', async () => {
    originalCwd = process.cwd();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-tool-context-'));
    await fs.outputFile(path.join(tmp, 'src/AGENTS.md'), 'src guidance');
    await fs.outputFile(path.join(tmp, 'src/a.ts'), 'a');
    await fs.outputFile(path.join(tmp, 'src/b.ts'), 'b');
    process.chdir(tmp);
    const reads: string[] = [];
    const context: HazeToolContext = {
      loadedContextFilePaths: new Set(),
      loadedContextFileSignatures: new Map(),
      onContextFileRead: filePath => reads.push(filePath),
    };

    const [first, second] = await Promise.all([
      discoverScopedContext('src/a.ts', {context: context}),
      discoverScopedContext('src/b.ts', {context: context}),
    ]);

    expect([...first, ...second].map(file => file.path)).toEqual(['src/AGENTS.md']);
    expect(reads).toEqual(['src/AGENTS.md']);
    expect(context.pendingContextFiles?.map(file => file.path)).toEqual(['src/AGENTS.md']);
  });
});
