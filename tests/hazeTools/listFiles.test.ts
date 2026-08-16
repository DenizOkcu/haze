import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {hazeTools} from '../../src/llm/hazeTools.js';


describe('listFiles tool', () => {
  let tmp: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-listfiles-test-'));
    originalCwd = process.cwd();
    await fs.ensureDir(path.join(tmp, '.git'));
    process.chdir(tmp);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.remove(tmp);
  });

  async function listFiles(params: {path?: string; recursive?: boolean; maxEntries?: number; cursor?: string; includeIgnored?: boolean; includeSizes?: boolean}, context?: unknown) {
    return await hazeTools.listFiles.execute({
      path: params.path ?? '.',
      recursive: params.recursive ?? false,
      maxEntries: params.maxEntries ?? 100,
      ...(params.cursor === undefined ? {} : {cursor: params.cursor}),
      includeIgnored: params.includeIgnored ?? false,
      includeSizes: params.includeSizes ?? false,
    }, {abortSignal: undefined, context});
  }

  it('lists top-level entries with directories suffixed by /', async () => {
    await fs.ensureDir(path.join(tmp, 'src'));
    await fs.writeFile(path.join(tmp, 'a.txt'), 'a');
    const result = await listFiles({});
    expect(result.entries).toContain('src/');
    expect(result.entries).toContain('a.txt');
    expect(result.truncated).toBe(false);
  });

  it('paginates with nextCursor and resumes after the cursor', async () => {
    for (const name of ['a', 'b', 'c', 'd']) await fs.writeFile(path.join(tmp, `${name}.txt`), name);
    const first = await listFiles({maxEntries: 2});
    expect(first.entries).toEqual(['a.txt', 'b.txt']);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toBe('b.txt');

    const second = await listFiles({maxEntries: 2, cursor: first.nextCursor});
    expect(second.entries).toEqual(['c.txt', 'd.txt']);
    expect(second.truncated).toBe(false);
    expect(second.nextCursor).toBeUndefined();
  });

  it('skips ignored entries by default, counts them, and includes them on request', async () => {
    await fs.writeFile(path.join(tmp, '.gitignore'), 'secret.txt\n');
    await fs.writeFile(path.join(tmp, 'secret.txt'), 'hidden');
    await fs.writeFile(path.join(tmp, 'visible.txt'), 'shown');

    const hidden = await listFiles({recursive: true});
    expect(hidden.entries).toContain('visible.txt');
    expect(hidden.entries).not.toContain('secret.txt');
    expect(hidden.ignoredSkipped).toBeGreaterThanOrEqual(1);

    const included = await listFiles({recursive: true, includeIgnored: true});
    expect(included.entries).toContain('secret.txt');
  });

  it('appends byte sizes only when includeSizes is set', async () => {
    await fs.writeFile(path.join(tmp, 'data.txt'), '12345');
    const plain = await listFiles({});
    const sized = await listFiles({includeSizes: true});
    expect(plain.entries).toContain('data.txt');
    expect(sized.entries).toContain('data.txt (5 bytes)');
  });

  it('surfaces scoped nested instructions when listing a subtree', async () => {
    await fs.outputFile(path.join(tmp, 'pkg/AGENTS.md'), 'pkg rules');
    await fs.outputFile(path.join(tmp, 'pkg/src/a.ts'), 'x');
    const context = {loadedContextFilePaths: new Set<string>()};
    const result = await listFiles({path: 'pkg/src'}, context);
    expect(result.applicableProjectInstructions).toEqual([expect.objectContaining({path: 'pkg/AGENTS.md'})]);
  });

  it('returns a structured failure for a missing directory', async () => {
    const result = await listFiles({path: 'nope'});
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.suggestedNextStep).toBeTruthy();
  });

  it('paginates a nested repo without overlap and prunes ignored subtrees', async () => {
    for (const name of ['m0', 'm1', 'm2']) {
      await fs.ensureDir(path.join(tmp, name));
      for (let i = 0; i < 8; i++) await fs.writeFile(path.join(tmp, name, `f${i}.ts`), 'x');
    }
    await fs.writeFile(path.join(tmp, '.gitignore'), 'm2/' + String.fromCharCode(10));

    const seen = new Set<string>();
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await listFiles({recursive: true, maxEntries: 10, cursor});
      pages.push(page.entries);
      for (const entry of page.entries) expect(seen.has(entry)).toBe(false);
      for (const entry of page.entries) seen.add(entry);
      cursor = page.nextCursor;
      expect(page.entries.some(entry => entry.startsWith('m2/'))).toBe(false);
    } while (cursor);

    // All m0/m1 entries (dir + 8 files each) plus .gitignore are covered
    // exactly once across pages; m2 is fully pruned (dir + 8 files).
    expect(seen.size).toBe(1 + 2 * (1 + 8));
    expect(pages.length).toBeGreaterThan(1);
  });
});
