import {afterEach, beforeEach, describe, it, expect} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {hazeTools} from '../../src/llm/hazeTools.js';

describe('readFile tool', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  async function readFile(params: {path: string; offset?: number; limit?: number}) {
    const originalCwd = process.cwd();
    process.chdir(tmp);
    try {
      return await hazeTools.readFile.execute(params, {abortSignal: undefined});
    } finally {
      process.chdir(originalCwd);
    }
  }

  it('reads an entire file', async () => {
    await fs.writeFile(path.join(tmp, 'test.txt'), 'line1\nline2\nline3\n');
    const result = await readFile({path: 'test.txt'});
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(4);
    expect(result.totalLines).toBe(4); // trailing newline adds empty line
    expect(result.lineNumberedText).toContain('line1');
    expect(result.lineNumberedText).toContain('line3');
  });

  it('reads from offset', async () => {
    await fs.writeFile(path.join(tmp, 'test.txt'), 'a\nb\nc\nd\ne\n');
    const result = await readFile({path: 'test.txt', offset: 3});
    expect(result.startLine).toBe(3);
    expect(result.lineNumberedText).toContain('c');
    expect(result.lineNumberedText).not.toContain('a');
  });

  it('reads with limit', async () => {
    await fs.writeFile(path.join(tmp, 'test.txt'), 'a\nb\nc\nd\ne\n');
    const result = await readFile({path: 'test.txt', offset: 2, limit: 2});
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(3);
    expect(result.lineNumberedText).toContain('b');
    expect(result.lineNumberedText).toContain('c');
    expect(result.lineNumberedText).not.toContain('a');
    expect(result.lineNumberedText).not.toContain('d');
  });

  it('includes line numbers in output', async () => {
    await fs.writeFile(path.join(tmp, 'test.txt'), 'hello\nworld\n');
    const result = await readFile({path: 'test.txt'});
    expect(result.lineNumberedText).toMatch(/1.*hello/);
    expect(result.lineNumberedText).toMatch(/2.*world/);
  });

  it('throws for nonexistent file', async () => {
    await expect(readFile({path: 'nope.txt'})).rejects.toThrow();
  });
});

describe('writeFile tool', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  async function writeFile(params: {path: string; content: string; overwriteExisting?: boolean}) {
    const originalCwd = process.cwd();
    process.chdir(tmp);
    try {
      return await hazeTools.writeFile.execute(params, {abortSignal: undefined});
    } finally {
      process.chdir(originalCwd);
    }
  }

  it('creates a new file', async () => {
    const result = await writeFile({path: 'new.txt', content: 'hello'});
    expect(result.ok).toBe(true);
    expect(result.path).toBe('new.txt');
    const content = await fs.readFile(path.join(tmp, 'new.txt'), 'utf8');
    expect(content).toBe('hello');
  });

  it('refuses to overwrite an existing file without explicit approval', async () => {
    await fs.writeFile(path.join(tmp, 'existing.txt'), 'old');
    await expect(writeFile({path: 'existing.txt', content: 'new'})).rejects.toThrow('Refusing to overwrite existing file');
    const content = await fs.readFile(path.join(tmp, 'existing.txt'), 'utf8');
    expect(content).toBe('old');
  });

  it('overwrites an existing file with explicit approval', async () => {
    await fs.writeFile(path.join(tmp, 'existing.txt'), 'old');
    await writeFile({path: 'existing.txt', content: 'new', overwriteExisting: true});
    const content = await fs.readFile(path.join(tmp, 'existing.txt'), 'utf8');
    expect(content).toBe('new');
  });

  it('creates parent directories', async () => {
    const result = await writeFile({path: 'deep/nested/dir/file.txt', content: 'deep'});
    expect(result.ok).toBe(true);
    const content = await fs.readFile(path.join(tmp, 'deep', 'nested', 'dir', 'file.txt'), 'utf8');
    expect(content).toBe('deep');
  });

  it('reports byte count', async () => {
    const result = await writeFile({path: 'bytes.txt', content: 'hello'});
    expect(result.bytes).toBe(5);
  });

  it('reports correct bytes for UTF-8 multibyte', async () => {
    const result = await writeFile({path: 'utf8.txt', content: 'ü'});
    expect(result.bytes).toBe(Buffer.byteLength('ü', 'utf8'));
  });
});
