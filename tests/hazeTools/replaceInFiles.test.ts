import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import nativeFs from 'node:fs/promises';
import * as walker from '../../src/utils/fs.js';
import * as boundedRead from '../../src/core/io/boundedRead.js';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {hazeTools} from '../../src/llm/hazeTools.js';

const context = {abortSignal: undefined};

describe('replaceInFiles tool', () => {
  let tmp: string;
  let cwd: string;

  beforeEach(async () => {
    cwd = process.cwd();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-replace-many-'));
    process.chdir(tmp);
    await fs.mkdir('src');
    await fs.writeFile('src/a.ts', 'const oldName = 1;\noldName++;\n');
    await fs.writeFile('src/b.ts', 'export const value = oldName;\n');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(cwd);
    await fs.remove(tmp);
  });

  it.each([true, false])('never opens protected scan descendants (dryRun=%s)', async dryRun => {
    // Only synthetic directory metadata: no protected file is created or read.
    vi.spyOn(walker, 'walkDir').mockResolvedValue([{path: '.env', absolutePath: path.join(tmp, '.env'), name: '.env', isFile: true, isDirectory: false}]);
    const read = vi.spyOn(boundedRead, 'readUtf8Prefix');
    const result = await hazeTools.replaceInFiles.execute({path: '.', needle: 'marker', replacement: 'new', mode: 'literal', dryRun, expectedCount: 1}, context);
    expect(read).not.toHaveBeenCalled();
    expect(result).toMatchObject({skippedFiles: 1, occurrences: []});
  });

  it.each([
    ['(?<=prefix )foo', 'bar'], ['foo(?= suffix)', 'bar'],
    ['(?<word>foo)', '$<word>-$&-$$'], ['(foo)', "$`-$1-$'"], ['^prefix', 'start'],
  ])('matches native regex replacement semantics for %s', async (needle, replacement) => {
    const content = 'prefix foo suffix\nprefix foo suffix';
    await fs.writeFile('src/a.ts', content);
    const result = await hazeTools.replaceInFiles.execute({path: 'src/a.ts', needle, replacement, mode: 'regex', dryRun: false}, context);
    expect(result).toMatchObject({ok: true});
    expect(await fs.readFile('src/a.ts', 'utf8')).toBe(content.replace(new RegExp(needle, 'gm'), replacement));
  });

  it('reports completed and uncertain paths when a later write fails', async () => {
    const write = nativeFs.writeFile.bind(nativeFs);
    vi.spyOn(nativeFs, 'writeFile').mockImplementation(async (file, data, options) => {
      if (String(file).endsWith('b.ts')) throw new Error('disk full');
      return write(file, data, options);
    });
    const result = await hazeTools.replaceInFiles.execute({path: 'src', needle: 'oldName', replacement: 'newName', mode: 'literal', dryRun: false}, context);
    expect(result).toMatchObject({ok: false, changedPaths: ['src/a.ts'], uncertainPaths: ['src/b.ts'], recoverable: true});
    expect(await fs.readFile('src/a.ts', 'utf8')).toContain('newName');
    expect(await fs.readFile('src/b.ts', 'utf8')).toContain('oldName');
  });

  it('previews stable occurrence IDs without mutating files', async () => {
    const result = await hazeTools.replaceInFiles.execute({path: 'src', needle: 'oldName', replacement: 'newName', mode: 'literal', dryRun: true}, context);
    expect(result).toMatchObject({ok: true, dryRun: true, occurrenceCount: 3, fileCount: 2});
    expect((result as {occurrences: Array<{id: string}>}).occurrences[0]?.id).toMatch(/^src\/a\.ts:0@[a-f0-9]{12}$/);
    expect(await fs.readFile('src/a.ts', 'utf8')).toContain('oldName');
  });

  it('applies only selected current occurrence IDs', async () => {
    const preview = await hazeTools.replaceInFiles.execute({path: 'src', needle: 'oldName', replacement: 'newName', mode: 'literal', dryRun: true}, context) as {occurrences: Array<{id: string}>};
    const selected = preview.occurrences.find(item => item.id.startsWith('src/b.ts:'))!;
    const result = await hazeTools.replaceInFiles.execute({path: 'src', needle: 'oldName', replacement: 'newName', mode: 'literal', dryRun: false, occurrenceIds: [selected.id]}, context);
    expect(result).toMatchObject({ok: true, occurrenceCount: 1, fileCount: 1});
    expect(await fs.readFile('src/a.ts', 'utf8')).toContain('oldName');
    expect(await fs.readFile('src/b.ts', 'utf8')).toContain('newName');
  });

  it('aborts all writes on stale IDs or an expected-count mismatch', async () => {
    const stale = await hazeTools.replaceInFiles.execute({path: 'src', needle: 'oldName', replacement: 'newName', mode: 'literal', dryRun: false, occurrenceIds: ['src/a.ts:0@stale']}, context);
    expect(stale).toMatchObject({ok: false, recoverable: true});
    const mismatch = await hazeTools.replaceInFiles.execute({path: 'src', needle: 'oldName', replacement: 'newName', mode: 'literal', dryRun: false, expectedCount: 2}, context);
    expect(mismatch).toMatchObject({ok: false, recoverable: true});
    expect(await fs.readFile('src/a.ts', 'utf8')).toContain('oldName');
    expect(await fs.readFile('src/b.ts', 'utf8')).toContain('oldName');
  });

  it('supports regex capture replacements and include globs', async () => {
    const result = await hazeTools.replaceInFiles.execute({path: '.', needle: 'old(Name)', replacement: 'new$1', mode: 'regex', includeGlob: 'src/a.ts', dryRun: false, expectedCount: 2}, context);
    expect(result).toMatchObject({ok: true, occurrenceCount: 2, fileCount: 1});
    expect(await fs.readFile('src/a.ts', 'utf8')).toContain('newName');
    expect(await fs.readFile('src/b.ts', 'utf8')).toContain('oldName');
  });
});
