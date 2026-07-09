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

  it('returns structured failure when oldText is not found', async () => {
    const file = path.join(tmp, 'test.txt');
    await fs.writeFile(file, 'hello world\n');
    const result = await editFile({
      path: 'test.txt',
      edits: [{oldText: 'missing', newText: 'replacement'}],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('was not found');
    expect(result.reasonCode).toBe('old_text_missing');
    expect(result.recoveryTool).toBe('readFile');
    expect(result.suggestedNextStep).toContain('Read the file again');
  });

  it('rejects symlinks that resolve outside the workspace', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-outside-'));
    try {
      const outsideFile = path.join(outsideDir, 'secret.txt');
      await fs.writeFile(outsideFile, 'hello world\n');
      await fs.symlink(outsideFile, path.join(tmp, 'link.txt'));

      const result = await editFile({
        path: 'link.txt',
        edits: [{oldText: 'world', newText: 'universe'}],
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('outside the workspace');
      await expect(fs.readFile(outsideFile, 'utf8')).resolves.toBe('hello world\n');
    } finally {
      await fs.remove(outsideDir);
    }
  });

  it('accepts line-numbered oldText copied from readFile output', async () => {
    const file = path.join(tmp, 'test.txt');
    await fs.writeFile(file, 'alpha\nbeta\ngamma\n');
    const result = await editFile({
      path: 'test.txt',
      edits: [{oldText: '   2 | beta\n', newText: 'BETA\n'}],
    });
    expect(result.ok).toBe(true);
    expect(result.approximateMatches).toBe(1);
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('alpha\nBETA\ngamma\n');
  });

  it('matches unique blocks when only trailing whitespace differs', async () => {
    const file = path.join(tmp, 'test.txt');
    await fs.writeFile(file, 'one  \ntwo\nthree\n');
    const result = await editFile({
      path: 'test.txt',
      edits: [{oldText: 'one\ntwo\n', newText: '1\n2\n'}],
    });
    expect(result.ok).toBe(true);
    expect(result.approximateMatches).toBe(1);
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('1\n2\nthree\n');
  });

  it('returns structured failure when oldText is not unique', async () => {
    const file = path.join(tmp, 'test.txt');
    await fs.writeFile(file, 'dup dup\n');
    const result = await editFile({
      path: 'test.txt',
      edits: [{oldText: 'dup', newText: 'one'}],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not unique');
    expect(result.reasonCode).toBe('old_text_not_unique');
  });

  it('returns structured failure for overlapping edits', async () => {
    const file = path.join(tmp, 'test.txt');
    await fs.writeFile(file, 'abcdefgh\n');
    const result = await editFile({
      path: 'test.txt',
      edits: [
        {oldText: 'abcd', newText: 'X'},
        {oldText: 'cdef', newText: 'Y'},
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('overlap');
    expect(result.reasonCode).toBe('overlapping_edits');
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

  it('skips concurrent mutations to the same file instead of racing stale edits', async () => {
    const file = path.join(tmp, 'test.txt');
    await fs.writeFile(file, 'a\nb\n');
    const originalCwd = process.cwd();
    process.chdir(tmp);
    try {
      const context = {context: {}};
      const first = hazeTools.editFile.execute({path: 'test.txt', edits: [{oldText: 'a', newText: 'A'}]}, context);
      const second = await hazeTools.editFile.execute({path: 'test.txt', edits: [{oldText: 'b', newText: 'B'}]}, context);
      await first;
      expect(second).toMatchObject({ok: true, duplicateSkipped: true});
      await expect(fs.readFile(file, 'utf8')).resolves.toBe('A\nb\n');
    } finally {
      process.chdir(originalCwd);
    }
  });
});
