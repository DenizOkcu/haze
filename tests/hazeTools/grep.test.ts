import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {hazeTools} from '../../src/llm/hazeTools.js';

const execFile = promisify(execFileCallback);

describe('grep tool', () => {
  let tmp: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-grep-test-'));
    originalCwd = process.cwd();
    await execFile('git', ['init', '-q', tmp]);
    process.chdir(tmp);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.remove(tmp);
  });

  it('returns structured matches and enforces a global result cap', async () => {
    await fs.writeFile(path.join(tmp, 'a.ts'), 'needle one\nneedle two\n');
    await fs.writeFile(path.join(tmp, 'b.ts'), 'needle three\nneedle four\n');
    const result = await hazeTools.grep.execute({
      pattern: 'needle',
      path: '.',
      contextLines: 0,
      maxMatches: 2,
      caseInsensitive: false,
    }, {abortSignal: undefined});
    expect(result.returnedMatches).toBe(2);
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]).toMatchObject({file: expect.any(String), line: expect.any(Number), content: expect.stringContaining('needle'), isContext: false});
    expect(result.truncated).toBe(true);
    expect(result.omittedMatches).toBeGreaterThan(0);
  });

  it('keeps context after the final match without crossing file boundaries', async () => {
    await fs.writeFile(path.join(tmp, 'a.ts'), 'before\nneedle\nafter\n');
    await fs.writeFile(path.join(tmp, 'b.ts'), 'unrelated\n');
    const result = await hazeTools.grep.execute({
      pattern: 'needle',
      path: '.',
      contextLines: 1,
      maxMatches: 10,
      caseInsensitive: false,
    }, {abortSignal: undefined});
    expect(result.matches.map(match => match.content)).toEqual(['before', 'needle', 'after']);
    expect(result.matches.every(match => match.file.endsWith('a.ts'))).toBe(true);
  });

  it('rejects directly named ignored files and directories by default', async () => {
    await fs.writeFile(path.join(tmp, '.gitignore'), 'secret.txt\nprivate/\n');
    await fs.writeFile(path.join(tmp, 'secret.txt'), 'needle\n');
    await fs.ensureDir(path.join(tmp, 'private'));
    await fs.writeFile(path.join(tmp, 'private', 'value.txt'), 'needle\n');
    const input = {pattern: 'needle', contextLines: 0, maxMatches: 10, caseInsensitive: false};
    const fileResult = await hazeTools.grep.execute({...input, path: 'secret.txt'}, {abortSignal: undefined});
    const directoryResult = await hazeTools.grep.execute({...input, path: 'private'}, {abortSignal: undefined});
    expect(fileResult).toMatchObject({ok: false, reasonCode: 'ignored_path'});
    expect(directoryResult).toMatchObject({ok: false, reasonCode: 'ignored_path'});
  });

  it('searches a directly named ignored file only with explicit override', async () => {
    await fs.writeFile(path.join(tmp, '.gitignore'), 'secret.txt\n');
    await fs.writeFile(path.join(tmp, 'secret.txt'), 'needle\n');
    const result = await hazeTools.grep.execute({pattern: 'needle', path: 'secret.txt', contextLines: 0, maxMatches: 10, caseInsensitive: false, includeIgnored: true}, {abortSignal: undefined});
    expect(result).toMatchObject({returnedMatches: 1});
  });
});
