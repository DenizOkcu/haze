import {afterEach, beforeEach, describe, it, expect} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {hazeTools} from '../../src/llm/hazeTools.js';

describe('editFile tool', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  async function editFile(params: {path: string; edits: Array<{oldText: string; newText: string}>}) {
    const originalCwd = process.cwd();
    process.chdir(tmp);
    try {
      return await hazeTools.editFile.execute(params, {abortSignal: undefined});
    } finally {
      process.chdir(originalCwd);
    }
  }

  it('applies a single exact replacement', async () => {
    const file = path.join(tmp, 'test.txt');
    await fs.writeFile(file, 'hello world\n');
    const result = await editFile({
      path: 'test.txt',
      edits: [{oldText: 'world', newText: 'universe'}],
    });
    expect(result.ok).toBe(true);
    const content = await fs.readFile(file, 'utf8');
    expect(content).toBe('hello universe\n');
  });

  it('applies multiple non-overlapping replacements', async () => {
    const file = path.join(tmp, 'test.txt');
    await fs.writeFile(file, 'foo bar baz\n');
    const result = await editFile({
      path: 'test.txt',
      edits: [
        {oldText: 'foo', newText: 'one'},
        {oldText: 'baz', newText: 'three'},
      ],
    });
    expect(result.ok).toBe(true);
    const content = await fs.readFile(file, 'utf8');
    expect(content).toBe('one bar three\n');
  });

  it('rejects when oldText is not found', async () => {
    const file = path.join(tmp, 'test.txt');
    await fs.writeFile(file, 'hello world\n');
    await expect(editFile({
      path: 'test.txt',
      edits: [{oldText: 'missing', newText: 'replacement'}],
    })).rejects.toThrow('was not found');
  });

  it('rejects when oldText is not unique', async () => {
    const file = path.join(tmp, 'test.txt');
    await fs.writeFile(file, 'dup dup\n');
    await expect(editFile({
      path: 'test.txt',
      edits: [{oldText: 'dup', newText: 'one'}],
    })).rejects.toThrow('not unique');
  });

  it('rejects overlapping edits', async () => {
    const file = path.join(tmp, 'test.txt');
    await fs.writeFile(file, 'abcdefgh\n');
    await expect(editFile({
      path: 'test.txt',
      edits: [
        {oldText: 'abcd', newText: 'X'},
        {oldText: 'cdef', newText: 'Y'},
      ],
    })).rejects.toThrow('overlap');
  });

  it('preserves file that doesn\'t end with newline', async () => {
    const file = path.join(tmp, 'test.txt');
    await fs.writeFile(file, 'no newline');
    await editFile({
      path: 'test.txt',
      edits: [{oldText: 'newline', newText: 'ending'}],
    });
    const content = await fs.readFile(file, 'utf8');
    expect(content).toBe('no ending');
  });
});
