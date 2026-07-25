import {afterEach, describe, expect, it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {iterateBoundedUtf8Lines, readUtf8LinesPage, readUtf8Prefix} from '../../../src/core/io/boundedRead.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, {recursive: true, force: true})));
});

async function tempFile(content: string | Buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-bounded-read-'));
  dirs.push(dir);
  const file = path.join(dir, 'input');
  await fs.writeFile(file, content);
  return file;
}

describe('bounded UTF-8 reads', () => {
  it('drops an incomplete multibyte suffix without replacement characters', async () => {
    const file = await tempFile('a🙂b');
    const result = await readUtf8Prefix(file, 3);
    expect(result).toMatchObject({content: 'a', truncated: true});
    expect(result.content).not.toContain('�');
  });

  it('bounds an unterminated line before yielding it', async () => {
    const file = await tempFile('x'.repeat(10_000));
    const lines = [];
    for await (const line of iterateBoundedUtf8Lines(file, 100)) lines.push(line);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({lineNumber: 1, oversized: true});
    expect(lines[0]?.line.length).toBe(100);
  });

  it('preserves empty-file and trailing-newline line counts', async () => {
    const empty = await tempFile('');
    await expect(readUtf8LinesPage(empty, 1, 10)).resolves.toEqual({lines: [''], totalLines: 1});
    const trailing = await tempFile('one\n');
    await expect(readUtf8LinesPage(trailing, 1, 10)).resolves.toEqual({lines: ['one', ''], totalLines: 2});
  });
});
