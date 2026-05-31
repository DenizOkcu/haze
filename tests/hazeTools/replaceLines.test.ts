import {afterEach, beforeEach, describe, it, expect} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {hazeTools} from '../../src/llm/hazeTools.js';

describe('replaceLines tool', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  async function replaceLines(params: {path: string; startLine: number; endLine: number; content: string}) {
    const originalCwd = process.cwd();
    process.chdir(tmp);
    try {
      return await hazeTools.replaceLines.execute(params, {abortSignal: undefined});
    } finally {
      process.chdir(originalCwd);
    }
  }

  it('replaces a single line', async () => {
    const file = path.join(tmp, 'test.txt');
    await fs.writeFile(file, 'line1\nline2\nline3\n');
    await replaceLines({path: 'test.txt', startLine: 2, endLine: 2, content: 'replaced'});
    const content = await fs.readFile(file, 'utf8');
    expect(content).toBe('line1\nreplaced\nline3\n');
  });

  it('replaces a range of lines', async () => {
    const file = path.join(tmp, 'test.txt');
    await fs.writeFile(file, 'a\nb\nc\nd\ne\n');
    await replaceLines({path: 'test.txt', startLine: 2, endLine: 4, content: 'X\nY'});
    const content = await fs.readFile(file, 'utf8');
    expect(content).toBe('a\nX\nY\ne\n');
  });

  it('rejects endLine < startLine', async () => {
    const file = path.join(tmp, 'test.txt');
    await fs.writeFile(file, 'content\n');
    await expect(replaceLines({path: 'test.txt', startLine: 3, endLine: 1, content: 'x'}))
      .rejects.toThrow('endLine must be greater than or equal to startLine');
  });

  it('rejects startLine beyond file length', async () => {
    const file = path.join(tmp, 'test.txt');
    await fs.writeFile(file, 'only one\n');
    await expect(replaceLines({path: 'test.txt', startLine: 10, endLine: 10, content: 'x'}))
      .rejects.toThrow('beyond end of file');
  });

  it('rejects endLine beyond file length', async () => {
    const file = path.join(tmp, 'test.txt');
    await fs.writeFile(file, 'only one\n');
    await expect(replaceLines({path: 'test.txt', startLine: 1, endLine: 10, content: 'x'}))
      .rejects.toThrow('beyond end of file');
  });

  it('handles empty content (deletion)', async () => {
    const file = path.join(tmp, 'test.txt');
    await fs.writeFile(file, 'a\nb\nc\n');
    await replaceLines({path: 'test.txt', startLine: 2, endLine: 2, content: ''});
    const content = await fs.readFile(file, 'utf8');
    expect(content).toBe('a\nc\n');
  });

  it('preserves trailing newline', async () => {
    const file = path.join(tmp, 'test.txt');
    await fs.writeFile(file, 'a\nb\n');
    await replaceLines({path: 'test.txt', startLine: 1, endLine: 1, content: 'x'});
    const content = await fs.readFile(file, 'utf8');
    expect(content.endsWith('\n')).toBe(true);
  });
});
