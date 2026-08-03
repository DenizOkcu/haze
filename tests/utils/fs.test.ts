import {afterEach, beforeEach, describe, it, expect} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {walkDir} from '../../src/utils/fs.js';

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

  it('skips node_modules and .git', async () => {
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
});
