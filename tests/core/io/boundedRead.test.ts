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

  it('reads later pages from indexed line checkpoints', async () => {
    const content = Array.from({length: 600}, (_, index) => `line-${index + 1}`).join('\n');
    const file = await tempFile(content);
    await expect(readUtf8LinesPage(file, 300, 3)).resolves.toEqual({lines: ['line-300', 'line-301', 'line-302'], totalLines: 600});
    await expect(readUtf8LinesPage(file, 598, 5)).resolves.toEqual({lines: ['line-598', 'line-599', 'line-600'], totalLines: 600});
  });

  it('invalidates a cached line index when the file changes', async () => {
    const file = await tempFile('one\ntwo');
    await expect(readUtf8LinesPage(file, 1, 10)).resolves.toMatchObject({totalLines: 2});
    await fs.writeFile(file, 'one\ntwo\nthree');
    await expect(readUtf8LinesPage(file, 3, 10)).resolves.toEqual({lines: ['three'], totalLines: 3});
  });
});
