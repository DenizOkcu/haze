import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import * as grepRunner from '../../src/llm/tools/grepRunner.js';
import {secretSearchExcludeGlobs} from '../../src/core/safety/secretPaths.js';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {hazeTools} from '../../src/llm/hazeTools.js';

describe('grep tool', () => {
  let tmp: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-grep-test-'));
    originalCwd = process.cwd();
    await fs.ensureDir(path.join(tmp, '.git'));
    process.chdir(tmp);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    await fs.remove(tmp);
  });

  it('appends case-insensitive secret policy exclusions after positive user globs', async () => {
    const run = vi.spyOn(grepRunner, 'runRipgrepBounded').mockRejectedValue(new Error('argument inspection only'));
    await hazeTools.grep.execute({pattern: 'marker', path: '.', glob: '*', contextLines: 0, maxMatches: 10, caseInsensitive: false, includeIgnored: true}, {});
    const args = run.mock.calls[0]![0].args;
    for (const glob of secretSearchExcludeGlobs()) {
      const index = args.indexOf(glob);
      expect(index).toBeGreaterThan(args.indexOf('*'));
      expect(args[index - 1]).toBe('--iglob');
    }
    expect(args).toEqual(expect.arrayContaining(['!**/.ssh/**', '!**/.aws/**', '!**/.docker/config.json', '!**/.netrc', '!secrets.json', '!*.key']));
  });

  it('searches ignored and hidden descendants only with override, excluding dependency metadata', async () => {
    await fs.writeFile(path.join(tmp, '.gitignore'), 'private/\n');
    for (const directory of ['private', '.hidden', 'node_modules', '.git']) {
      await fs.ensureDir(path.join(tmp, directory));
      await fs.writeFile(path.join(tmp, directory, 'value.txt'), 'needle\n');
    }
    const input = {pattern: 'needle', path: '.', contextLines: 0, maxMatches: 10, caseInsensitive: false};
    expect(await hazeTools.grep.execute(input, {})).toMatchObject({totalMatches: 0});
    const result = await hazeTools.grep.execute({...input, includeIgnored: true, glob: '*.txt'}, {});
    expect(result.matches.map(match => match.file).sort()).toEqual(['.hidden/value.txt', 'private/value.txt']);
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
