import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
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

  it('classifyChecked distinguishes checked from could-not-check (F-05)', async () => {
    await fs.writeFile(path.join(tmp, '.gitignore'), 'skip.txt\n');
    await fs.writeFile(path.join(tmp, 'skip.txt'), 'x');
    const {ignored, checked} = await createIgnoreClassifier(tmp).classifyChecked(['skip.txt', 'keep.txt']);
    expect(checked).toBe(true);
    expect(ignored.has('skip.txt')).toBe(true);
    expect(ignored.has('keep.txt')).toBe(false);
  });

  it('checkGitIgnored returns not-ignored outside a repository — semantics, not a failure (F-05)', async () => {
    const nonRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-nogit2-'));
    try {
      process.chdir(nonRepo);
      const {checkGitIgnored} = await import('../../src/llm/tools/gitIgnore.js');
      expect(await checkGitIgnored(path.join(nonRepo, 'a.txt'))).toBe('not-ignored');
    } finally {
      process.chdir(tmp);
      await fs.remove(nonRepo);
    }
  });
});

describe('gitIgnore tri-state under a broken Git (F-05)', () => {
  let tmp: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'haze-gitignore-broken-')));
    originalCwd = process.cwd();
    process.chdir(tmp);
    vi.resetModules();
    // Simulate a missing git binary: spawn fails at the transport level, which
    // is the one failure the fail-open contract cannot distinguish on its own.
    vi.doMock('node:child_process', async () => {
      const {EventEmitter} = await import('node:events');
      const spawn = () => {
        const child = new EventEmitter() as EventEmitter & {stdout: EventEmitter; stderr: EventEmitter; stdin: {on: () => void; end: () => void}};
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = {on: () => undefined, end: () => undefined};
        queueMicrotask(() => child.emit('error', new Error('spawn git ENOENT')));
        return child;
      };
      return {spawn};
    });
  });

  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
    process.chdir(originalCwd);
    void fs.remove(tmp);
  });

  it('reads still fail open while the tri-state reports unknown', async () => {
    const {classifyGitIgnored, checkGitIgnored} = await import('../../src/llm/tools/gitIgnore.js');
    await expect(classifyGitIgnored(['a.txt'])).resolves.toEqual(new Set());
    await expect(checkGitIgnored(path.join(tmp, 'a.txt'))).resolves.toBe('unknown');
  });

  it('mutation guards fail closed on unknown status unless allowIgnored is set', async () => {
    const {assertNotIgnored} = await import('../../src/llm/tools/fileToolShared.js');
    const target = path.join(tmp, 'mutate.txt');
    await expect(assertNotIgnored(target, 'mutate.txt')).rejects.toMatchObject({reasonCode: 'ignore_check_unavailable'});
    await expect(assertNotIgnored(target, 'mutate.txt', true)).resolves.toBeUndefined();
  });
});

describe('gitIgnore stalled child (bounded check-ignore)', () => {
  let tmp: string;
  let originalCwd: string;
  let killCalls: number;

  beforeEach(async () => {
    vi.useFakeTimers();
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'haze-gitignore-hung-')));
    originalCwd = process.cwd();
    process.chdir(tmp);
    vi.resetModules();
    killCalls = 0;
    // A `git` child that accepts stdin, never answers, and never exits — the
    // abort-ignoring stall case. kill() emits the close event like a real
    // SIGKILL would, proving the deadline (not the child) settles the batch.
    vi.doMock('node:child_process', async () => {
      const {EventEmitter} = await import('node:events');
      const spawn = () => {
        const child = new EventEmitter() as EventEmitter & {stdout: EventEmitter; stderr: EventEmitter; stdin: {on: () => void; end: () => void}; kill: (signal?: string) => void};
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = {on: () => undefined, end: () => undefined};
        child.kill = () => {
          killCalls++;
          queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
        };
        return child;
      };
      return {spawn};
    });
  });

  afterEach(async () => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
    vi.useRealTimers();
    process.chdir(originalCwd);
    await fs.remove(tmp);
  });

  it('kills a stalled child at the deadline: reads fail open, tri-state reports unknown (F-05)', async () => {
    const {createIgnoreClassifier, classifyGitIgnored, CHECK_IGNORE_DEADLINE_MS} = await import('../../src/llm/tools/gitIgnore.js');
    const readPromise = classifyGitIgnored(['a.txt'], tmp);
    const triStatePromise = createIgnoreClassifier(tmp).classifyChecked(['a.txt']);
    await vi.advanceTimersByTimeAsync(CHECK_IGNORE_DEADLINE_MS + 10);
    // Read path: bounded and fail-open (nothing reported ignored).
    await expect(readPromise).resolves.toEqual(new Set());
    // Tri-state path: the batch could not be checked, so mutations fail closed.
    await expect(triStatePromise).resolves.toMatchObject({ignored: new Set(), checked: false});
    expect(killCalls).toBe(2);
  });
});
