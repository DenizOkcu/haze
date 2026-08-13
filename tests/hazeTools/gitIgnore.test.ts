import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {createIgnoreClassifier, classifyGitIgnored, GIT_IGNORE_BATCH, isGitIgnored} from '../../src/llm/tools/gitIgnore.js';

const execFile = promisify(execFileCallback);

describe('gitIgnore batch classifier', () => {
  let tmp: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-gitignore-test-'));
    // Resolve the macOS /var -> /private/var symlink so workspace-relative
    // helpers (which use process.cwd()) agree with the absolute test paths.
    tmp = await fs.realpath(tmp);
    originalCwd = process.cwd();
    await execFile('git', ['init', '-q', tmp]);
    process.chdir(tmp);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.remove(tmp);
  });

  it('classifies ignored and unignored paths in one subprocess', async () => {
    await fs.writeFile(path.join(tmp, '.gitignore'), 'secret.txt\nbuild/\n');
    await fs.writeFile(path.join(tmp, 'secret.txt'), 'hidden');
    await fs.writeFile(path.join(tmp, 'visible.txt'), 'shown');
    await fs.ensureDir(path.join(tmp, 'build'));
    await fs.writeFile(path.join(tmp, 'build', 'out.js'), 'x');

    const classifier = createIgnoreClassifier(tmp);
    const ignored = await classifier.classify(['secret.txt', 'visible.txt', 'build', 'build/out.js']);

    expect(ignored.has('secret.txt')).toBe(true);
    expect(ignored.has('build')).toBe(true);
    expect(ignored.has('build/out.js')).toBe(true);
    expect(ignored.has('visible.txt')).toBe(false);
    // Hundreds of candidates collapse to exactly one git process.
    expect(classifier.invocationCount).toBe(1);
  });

  it('handles paths with spaces and unusual names', async () => {
    await fs.writeFile(path.join(tmp, '.gitignore'), 'my file.txt\n');
    await fs.writeFile(path.join(tmp, 'my file.txt'), 'x');
    await fs.writeFile(path.join(tmp, 'normal.txt'), 'x');

    const ignored = await classifyGitIgnored(['my file.txt', 'normal.txt'], tmp);
    expect(ignored.has('my file.txt')).toBe(true);
    expect(ignored.has('normal.txt')).toBe(false);
  });

  it('batches more than GIT_IGNORE_BATCH candidates into O(batches) calls', async () => {
    const total = GIT_IGNORE_BATCH * 2 + 5;
    for (let i = 0; i < total; i++) await fs.writeFile(path.join(tmp, `f${i}.txt`), 'x');

    const classifier = createIgnoreClassifier(tmp);
    const paths = Array.from({length: total}, (_, i) => `f${i}.txt`);
    const ignored = await classifier.classify(paths);
    expect(ignored.size).toBe(0);
    // 2*256 + 5 -> 3 batches.
    expect(classifier.invocationCount).toBe(3);
  });

  it('fails open (reports nothing ignored) outside a git repository', async () => {
    const nonRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-nogit-'));
    try {
      await fs.writeFile(path.join(nonRepo, 'a.txt'), 'x');
      const ignored = await classifyGitIgnored(['a.txt'], nonRepo);
      expect(ignored.size).toBe(0);
    } finally {
      await fs.remove(nonRepo);
    }
  });

  it('isGitIgnored single-path helper matches the batch result', async () => {
    await fs.writeFile(path.join(tmp, '.gitignore'), 'skip.txt\n');
    await fs.writeFile(path.join(tmp, 'skip.txt'), 'x');
    await fs.writeFile(path.join(tmp, 'keep.txt'), 'x');
    expect(await isGitIgnored(path.join(tmp, 'skip.txt'))).toBe(true);
    expect(await isGitIgnored(path.join(tmp, 'keep.txt'))).toBe(false);
    expect(await isGitIgnored(tmp)).toBe(false); // workspace root is never ignored
  });
});
