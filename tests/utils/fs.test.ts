import {afterEach, beforeEach, describe, it, expect} from 'vitest';
import fs from '../fsExtra.js';
import os from 'node:os';
import path from 'node:path';
import {ensureDir, move, pathExists, readJson, remove, walkDir} from '../../src/utils/fs.js';

describe('walkDir', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  function filePaths(entries: Awaited<ReturnType<typeof walkDir>>): string[] {
    return entries.filter(entry => entry.isFile).map(entry => entry.path);
  }

  it('lists files recursively', async () => {
    await fs.ensureDir(path.join(tmp, 'src'));
    await fs.writeFile(path.join(tmp, 'a.txt'), 'a');
    await fs.writeFile(path.join(tmp, 'src', 'b.txt'), 'b');
    const entries = await walkDir(tmp, {recursive: true});
    expect(filePaths(entries)).toContain('a.txt');
    expect(filePaths(entries)).toContain(path.join('src', 'b.txt'));
  });

  it('skips .git and node_modules unconditionally', async () => {
    await fs.ensureDir(path.join(tmp, 'node_modules', 'pkg'));
    await fs.ensureDir(path.join(tmp, '.git', 'objects'));
    await fs.writeFile(path.join(tmp, 'node_modules', 'pkg', 'index.js'), '');
    await fs.writeFile(path.join(tmp, '.git', 'objects', 'abc'), '');
    await fs.writeFile(path.join(tmp, 'real.txt'), 'content');
    const entries = await walkDir(tmp, {recursive: true});
    expect(filePaths(entries)).toEqual(['real.txt']);
  });

  it('returns empty for nonexistent directory', async () => {
    const entries = await walkDir(path.join(tmp, 'nope'), {recursive: true});
    expect(entries).toEqual([]);
  });

  it('returns relative paths', async () => {
    await fs.writeFile(path.join(tmp, 'top.txt'), '');
    await fs.ensureDir(path.join(tmp, 'sub'));
    await fs.writeFile(path.join(tmp, 'sub', 'deep.txt'), '');
    const entries = await walkDir(tmp, {recursive: true});
    for (const entry of entries) {
      expect(path.isAbsolute(entry.path)).toBe(false);
    }
  });

  it('supports cursor pagination in traversal order', async () => {
    await fs.writeFile(path.join(tmp, 'a.txt'), '');
    await fs.writeFile(path.join(tmp, 'b.txt'), '');
    await fs.writeFile(path.join(tmp, 'c.txt'), '');
    const first = await walkDir(tmp, {maxEntries: 2});
    expect(first.map(entry => entry.path)).toEqual(['a.txt', 'b.txt']);
    const second = await walkDir(tmp, {maxEntries: 2, cursor: 'b.txt'});
    expect(second.map(entry => entry.path)).toEqual(['c.txt']);
  });

  it('prunes ignored directories and never descends into them via ignoreBatch', async () => {
    await fs.ensureDir(path.join(tmp, 'ignored-dir'));
    await fs.writeFile(path.join(tmp, 'ignored-dir', 'child.txt'), '');
    await fs.ensureDir(path.join(tmp, 'kept-dir'));
    await fs.writeFile(path.join(tmp, 'kept-dir', 'child.txt'), '');
    await fs.writeFile(path.join(tmp, 'top.txt'), '');

    const walked = await walkDir(tmp, {
      recursive: true,
      ignoreBatch: async entries => new Set(entries.filter(entry => entry.path === 'ignored-dir' || entry.path.startsWith('ignored-dir/')).map(entry => entry.path)),
    });
    const paths = walked.map(entry => entry.path);
    expect(paths).not.toContain('ignored-dir');
    expect(paths).not.toContain('ignored-dir/child.txt');
    expect(paths).toContain('kept-dir');
    expect(paths).toContain('kept-dir/child.txt');
    expect(paths).toContain('top.txt');
  });

  it('invokes ignoreBatch at most once per directory level', async () => {
    await fs.ensureDir(path.join(tmp, 'a'));
    await fs.ensureDir(path.join(tmp, 'b'));
    await fs.writeFile(path.join(tmp, 'a', '1.txt'), '');
    await fs.writeFile(path.join(tmp, 'b', '2.txt'), '');
    await fs.writeFile(path.join(tmp, 'top.txt'), '');

    let calls = 0;
    await walkDir(tmp, {recursive: true, ignoreBatch: async paths => { calls++; return new Set(); }});
    // Root + two child directories = three batched calls, not one per entry.
    expect(calls).toBe(3);
  });

  it('page two does not classify entries preceding a deep cursor', async () => {
    // Deep chain d/d/.../d so the cursor lives many levels down; an early
    // sibling that sorts before 'd' is strictly pre-cursor in DFS order.
    let dir = tmp;
    for (let i = 0; i < 5; i++) {
      dir = path.join(dir, 'd');
      await fs.ensureDir(dir);
    }
    await fs.writeFile(path.join(tmp, 'a-early.txt'), '');
    await fs.writeFile(path.join(dir, 'late.txt'), '');

    let calls = 0;
    const walkedEarly = await walkDir(tmp, {recursive: true, ignoreBatch: async paths => { calls++; return new Set(); }});
    const deepCursor = walkedEarly.find(entry => entry.path.endsWith('late.txt'))!.path;
    const earlyCallCount = calls;
    calls = 0;

    // Resuming after the deep cursor must not classify the early sibling subtree.
    const pageTwo = await walkDir(tmp, {recursive: true, cursor: deepCursor, ignoreBatch: async paths => { calls++; return new Set(); }});
    expect(pageTwo.map(entry => entry.path)).toEqual([]);
    expect(calls).toBeLessThan(earlyCallCount);
  });

  it('descends into a cursor directory so its children appear on the next page', async () => {
    await fs.ensureDir(path.join(tmp, 'src'));
    await fs.writeFile(path.join(tmp, 'src', 'a.ts'), '');
    await fs.writeFile(path.join(tmp, 'src', 'b.ts'), '');
    await fs.writeFile(path.join(tmp, 'z.txt'), '');

    // DFS order: src, src/a.ts, src/b.ts, z.txt. Cursor 'src' excludes the dir
    // entry itself but includes its children plus later top-level siblings.
    const pageTwo = await walkDir(tmp, {recursive: true, cursor: 'src'});
    expect(pageTwo.map(entry => entry.path)).toEqual([path.join('src', 'a.ts'), path.join('src', 'b.ts'), 'z.txt']);
  });
});

describe('fs helpers', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-fs-helpers-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  it('pathExists is false for missing paths and true for existing ones', async () => {
    const file = path.join(tmp, 'settings.json');
    expect(await pathExists(file)).toBe(false);
    await fs.writeFile(file, '{}');
    expect(await pathExists(file)).toBe(true);
  });

  it('readJson parses content and tolerates a UTF-8 BOM', async () => {
    const file = path.join(tmp, 'data.json');
    await fs.writeFile(file, JSON.stringify({answer: 42}));
    expect(await readJson(file)).toEqual({answer: 42});
    await fs.writeFile(file, `\uFEFF${JSON.stringify({bom: true})}`);
    expect(await readJson(file)).toEqual({bom: true});
  });

  it('readJson throws loudly on malformed JSON', async () => {
    const file = path.join(tmp, 'broken.json');
    await fs.writeFile(file, '{not json');
    await expect(readJson(file)).rejects.toThrow();
  });

  it('ensureDir creates parents and tolerates existing directories', async () => {
    const dir = path.join(tmp, 'a', 'b');
    await ensureDir(dir);
    await ensureDir(dir);
    expect(await pathExists(dir)).toBe(true);
  });

  it('remove deletes trees and ignores missing paths', async () => {
    const tree = path.join(tmp, 'tree');
    await fs.ensureDir(tree);
    await fs.writeFile(path.join(tree, 'leaf.txt'), 'x');
    await remove(tree);
    await remove(tree);
    expect(await pathExists(tree)).toBe(false);
  });

  it('move renames into place', async () => {
    const src = path.join(tmp, 'src');
    const dest = path.join(tmp, 'dest');
    await fs.ensureDir(src);
    await fs.writeFile(path.join(src, 'SKILL.md'), 'x');
    await move(src, dest);
    expect(await pathExists(src)).toBe(false);
    expect(await pathExists(path.join(dest, 'SKILL.md'))).toBe(true);
  });
});
