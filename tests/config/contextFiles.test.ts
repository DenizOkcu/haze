import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {contextFileDiagnostics, readScopedContextFilesForPath, summarizeContextDiagnostics} from '../../src/config/contextFiles.js';

let originalCwd: string;
let tmp: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-context-test-'));
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.remove(tmp);
});

describe('readScopedContextFilesForPath', () => {
  it('loads only nested instruction files that apply to the target path', async () => {
    await fs.outputFile(path.join(tmp, 'AGENTS.md'), 'root');
    await fs.outputFile(path.join(tmp, 'packages/api/CLAUDE.md'), 'api claude');
    await fs.outputFile(path.join(tmp, 'packages/api/AGENTS.md'), 'api agents');
    await fs.outputFile(path.join(tmp, 'packages/mobile/CLAUDE.md'), 'mobile claude');
    process.chdir(tmp);

    const files = await readScopedContextFilesForPath('packages/api/src/server.ts', {alreadyLoadedPaths: ['AGENTS.md']});

    expect(files.map(file => file.path)).toEqual(['packages/api/CLAUDE.md', 'packages/api/AGENTS.md']);
    expect(files.map(file => file.content)).toEqual(['api claude', 'api agents']);
  });

  it('does not load sibling scoped instructions', async () => {
    await fs.outputFile(path.join(tmp, 'packages/api/CLAUDE.md'), 'api claude');
    await fs.outputFile(path.join(tmp, 'packages/mobile/CLAUDE.md'), 'mobile claude');
    process.chdir(tmp);

    const files = await readScopedContextFilesForPath('packages/mobile/app.tsx');

    expect(files.map(file => file.path)).toEqual(['packages/mobile/CLAUDE.md']);
  });

  it('notifies when scoped context files are read', async () => {
    await fs.outputFile(path.join(tmp, 'packages/api/CLAUDE.md'), 'api claude');
    await fs.outputFile(path.join(tmp, 'packages/api/AGENTS.md'), 'api agents');
    process.chdir(tmp);
    const readPaths: string[] = [];

    await readScopedContextFilesForPath('packages/api/src/server.ts', {onContextFileRead: path => readPaths.push(path)});

    expect(readPaths).toEqual(['packages/api/CLAUDE.md', 'packages/api/AGENTS.md']);
  });

  it('skips already loaded scoped instructions until the file changes', async () => {
    const agentsPath = path.join(tmp, 'packages/api/AGENTS.md');
    await fs.outputFile(agentsPath, 'api agents');
    process.chdir(tmp);
    const first = await readScopedContextFilesForPath('packages/api/src/server.ts');
    const signatures = new Map(first.flatMap(file => file.signature ? [[file.path, file.signature] as const] : []));

    expect(await readScopedContextFilesForPath('packages/api/src/server.ts', {alreadyLoadedSignatures: signatures})).toEqual([]);

    await fs.outputFile(agentsPath, 'api agents changed');
    const changedTime = new Date(Date.now() + 2000);
    await fs.utimes(agentsPath, changedTime, changedTime);
    const changed = await readScopedContextFilesForPath('packages/api/src/server.ts', {alreadyLoadedSignatures: signatures});

    expect(changed.map(file => file.path)).toEqual(['packages/api/AGENTS.md']);
    expect(changed[0]?.content).toBe('api agents changed');
  });
});

describe('contextFileDiagnostics', () => {
  it('reports stable hashes and token estimates without returning file content', () => {
    const first = contextFileDiagnostics([{path: 'AGENTS.md', content: 'abcd'.repeat(10)}]);
    const second = contextFileDiagnostics([{path: 'AGENTS.md', content: 'abcd'.repeat(10)}]);
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({path: 'AGENTS.md', characters: 40, estimatedTokens: 10});
    expect(first[0].contentHash).toHaveLength(12);
    expect(first[0]).not.toHaveProperty('content');
  });
});

describe('summarizeContextDiagnostics', () => {
  it('aggregates totals across files', () => {
    const summary = summarizeContextDiagnostics([
      {path: 'AGENTS.md', content: 'abcd'.repeat(10)},
      {path: 'CLAUDE.md', content: 'efgh'.repeat(20)},
    ]);
    expect(summary.fileCount).toBe(2);
    expect(summary.totalCharacters).toBe(120);
    expect(summary.totalTokens).toBe(30);
    expect(summary.duplicateGroups).toEqual([]);
    expect(summary.duplicateFileCount).toBe(0);
  });

  it('returns zero totals for empty input', () => {
    const summary = summarizeContextDiagnostics([]);
    expect(summary.fileCount).toBe(0);
    expect(summary.totalTokens).toBe(0);
    expect(summary.duplicateGroups).toEqual([]);
  });

  it('flags duplicate groups when two files share content', () => {
    const shared = 'identical body\n';
    const summary = summarizeContextDiagnostics([
      {path: '~/.haze/AGENTS.md', content: shared},
      {path: 'AGENTS.md', content: shared},
      {path: 'CLAUDE.md', content: 'different'},
    ]);
    expect(summary.duplicateGroups).toHaveLength(1);
    expect(summary.duplicateGroups[0]?.paths).toEqual(['~/.haze/AGENTS.md', 'AGENTS.md']);
    expect(summary.duplicateFileCount).toBe(2);
  });

  it('reports duplicate groups sorted by size then hash', () => {
    const a = 'content-a';
    const b = 'content-b';
    const summary = summarizeContextDiagnostics([
      {path: 'a1', content: a},
      {path: 'a2', content: a},
      {path: 'b1', content: b},
      {path: 'b2', content: b},
      {path: 'b3', content: b},
    ]);
    expect(summary.duplicateGroups[0]?.paths).toHaveLength(3);
    expect(summary.duplicateGroups[1]?.paths).toHaveLength(2);
  });

  it('leaves budget fields undefined when no windowSize is provided', () => {
    const summary = summarizeContextDiagnostics([{path: 'AGENTS.md', content: 'x'.repeat(4)}]);
    expect(summary.windowSize).toBeUndefined();
    expect(summary.budgetShare).toBeUndefined();
    expect(summary.exceedsBudget).toBeUndefined();
  });

  it('reports budget share and threshold when windowSize is provided', () => {
    const summary = summarizeContextDiagnostics(
      [{path: 'AGENTS.md', content: 'x'.repeat(4000)}],
      {windowSize: 20_000, budgetThreshold: 0.2},
    );
    expect(summary.windowSize).toBe(20_000);
    expect(summary.budgetShare).toBeCloseTo(0.05, 5);
    expect(summary.exceedsBudget).toBe(false);
    expect(summary.budgetThreshold).toBe(0.2);
  });

  it('flags exceedsBudget just past the threshold', () => {
    const under = summarizeContextDiagnostics(
      [{path: 'AGENTS.md', content: 'x'.repeat(4 * 1999)}],
      {windowSize: 10_000, budgetThreshold: 0.2},
    );
    expect(under.exceedsBudget).toBe(false);
    const over = summarizeContextDiagnostics(
      [{path: 'AGENTS.md', content: 'x'.repeat(4 * 2001)}],
      {windowSize: 10_000, budgetThreshold: 0.2},
    );
    expect(over.exceedsBudget).toBe(true);
  });

  it('clamps explicit budgetThreshold into [0, 1]', () => {
    const high = summarizeContextDiagnostics([{path: 'a', content: 'x'}], {budgetThreshold: 5});
    const low = summarizeContextDiagnostics([{path: 'a', content: 'x'}], {budgetThreshold: -1});
    expect(high.budgetThreshold).toBe(1);
    expect(low.budgetThreshold).toBe(0);
  });
});
