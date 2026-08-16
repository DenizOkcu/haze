import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {assembleWorkerContext} from '../../src/llm/workerContext.js';
import {COMPATIBILITY_PROFILE} from '../../src/core/subagent/executionProfiles.js';
import type {SubagentTaskCapsule} from '../../src/core/subagent/contracts.js';

let previousCwd = '';
let root = '';

function task(mode: SubagentTaskCapsule['mode'], scope: string[] = []): SubagentTaskCapsule {
  return {id: 'worker-1', objective: 'Inspect the scoped code', deliverable: 'Findings with evidence', mode, scope, acceptanceCriteria: []};
}

describe('assembleWorkerContext', () => {
  beforeEach(async () => {
    previousCwd = process.cwd();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-worker-context-'));
    await fs.outputFile(path.join(root, 'AGENTS.md'), 'root instructions');
    await fs.outputFile(path.join(root, 'src', 'AGENTS.md'), 'src instructions');
    await fs.outputFile(path.join(root, 'other', 'AGENTS.md'), 'unrelated instructions');
    await fs.outputFile(path.join(root, 'src', 'file.ts'), 'export const x = 1;');
    process.chdir(root);
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    await fs.remove(root);
  });

  it('loads root and relevant scoped instructions afresh but excludes siblings', async () => {
    const bundle = await assembleWorkerContext(task('inspect', ['src/file.ts']), COMPATIBILITY_PROFILE, {cwd: root, start: new Date('2026-01-01')});
    expect(bundle.instructions.map(file => file.content)).toContain('root instructions');
    expect(bundle.instructions.map(file => file.content)).toContain('src instructions');
    expect(bundle.instructions.map(file => file.content)).not.toContain('unrelated instructions');
    const scoped = bundle.instructions.find(file => file.content === 'src instructions');
    expect(scoped?.signature).toBeTruthy();
    expect(bundle.loadedSignatures.get(scoped!.path)).toBe(scoped!.signature);
    expect(bundle.systemPrompt).not.toContain('/fleet');
  });

  it('uses a mode-specific tool diet', async () => {
    const inspect = await assembleWorkerContext(task('inspect'), COMPATIBILITY_PROFILE, {cwd: root});
    expect(Object.keys(inspect.tools)).toEqual(['listFiles', 'readFile', 'grep', 'readToolOutput']);
    const validate = await assembleWorkerContext(task('validate'), COMPATIBILITY_PROFILE, {cwd: root});
    expect(Object.keys(validate.tools)).toContain('shell');
    expect(Object.keys(validate.tools)).not.toContain('writeFile');
  });

  it('policy-blocks mandatory context that exceeds the explicit profile budget', async () => {
    const bundle = await assembleWorkerContext(task('inspect'), {...COMPATIBILITY_PROFILE, name: 'tiny', maxInputTokens: 1}, {cwd: root});
    expect(bundle.policyBlock).toMatch(/exceeds profile tiny/);
  });

  it('rejects scope paths outside the workspace', async () => {
    const bundle = await assembleWorkerContext(task('inspect', ['../outside']), COMPATIBILITY_PROFILE, {cwd: root});
    expect(bundle.policyBlock).toMatch(/outside the workspace/);
  });
});
