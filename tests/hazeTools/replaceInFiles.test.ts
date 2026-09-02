import {afterEach, beforeEach, describe, expect, it} from 'vitest';
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
    process.chdir(cwd);
    await fs.remove(tmp);
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
