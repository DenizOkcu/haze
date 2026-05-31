import {afterEach, beforeEach, describe, it, expect} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {walkDir} from '../../src/utils/fs.js';

describe('walkDir', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-test-'));
    await fs.ensureDir(path.join(tmp, 'src', 'deep'));
    await fs.ensureDir(path.join(tmp, 'lib'));
    await fs.writeFile(path.join(tmp, 'root.txt'), 'root');
    await fs.writeFile(path.join(tmp, 'src', 'a.ts'), 'a');
    await fs.writeFile(path.join(tmp, 'src', 'deep', 'b.ts'), 'b');
    await fs.writeFile(path.join(tmp, 'lib', 'c.js'), 'c');
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  it('returns entries for immediate children only when not recursive', async () => {
    const entries = await walkDir(tmp);
    const names = entries.map(e => e.name);
    expect(names).toContain('root.txt');
    expect(names).toContain('src');
    expect(names).toContain('lib');
    expect(names).not.toContain('a.ts');
    expect(names).not.toContain('deep');
  });

  it('returns all entries recursively', async () => {
    const entries = await walkDir(tmp, {recursive: true});
    const paths = entries.map(e => e.path);
    expect(paths).toContain('root.txt');
    expect(paths).toContain(path.join('src', 'a.ts'));
    expect(paths).toContain(path.join('src', 'deep', 'b.ts'));
    expect(paths).toContain(path.join('lib', 'c.js'));
  });

  it('skips node_modules and .git', async () => {
    await fs.ensureDir(path.join(tmp, 'node_modules', 'pkg'));
    await fs.ensureDir(path.join(tmp, '.git', 'objects'));
    const entries = await walkDir(tmp, {recursive: true});
    const names = entries.map(e => e.name);
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('.git');
  });

  it('respects maxEntries', async () => {
    const entries = await walkDir(tmp, {recursive: true, maxEntries: 3});
    expect(entries.length).toBeLessThanOrEqual(3);
  });

  it('applies filter', async () => {
    const entries = await walkDir(tmp, {
      recursive: true,
      filter: entry => entry.isFile,
    });
    expect(entries.every(e => e.isFile)).toBe(true);
    expect(entries.some(e => e.isDirectory)).toBe(false);
  });

  it('returns correct isDirectory and isFile flags', async () => {
    const entries = await walkDir(tmp);
    const rootEntry = entries.find(e => e.name === 'root.txt');
    const srcEntry = entries.find(e => e.name === 'src');
    expect(rootEntry?.isFile).toBe(true);
    expect(rootEntry?.isDirectory).toBe(false);
    expect(srcEntry?.isFile).toBe(false);
    expect(srcEntry?.isDirectory).toBe(true);
  });

  it('returns relative paths', async () => {
    const entries = await walkDir(tmp, {recursive: true});
    for (const entry of entries) {
      expect(path.isAbsolute(entry.path)).toBe(false);
    }
  });

  it('returns absolute paths', async () => {
    const entries = await walkDir(tmp, {recursive: true});
    for (const entry of entries) {
      expect(path.isAbsolute(entry.absolutePath)).toBe(true);
    }
  });

  it('returns empty for nonexistent directory', async () => {
    const entries = await walkDir(path.join(tmp, 'nope'));
    expect(entries).toEqual([]);
  });
});
