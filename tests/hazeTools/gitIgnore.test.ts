import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {createIgnoreClassifier, classifyGitIgnored, isGitIgnored} from '../../src/llm/tools/gitIgnore.js';

async function makeTmp(prefix: string) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  return dir;
}

describe('in-process ignore classifier', () => {
  let tmp: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmp = await makeTmp('haze-gitignore-test-');
    originalCwd = process.cwd();
    process.chdir(tmp);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.remove(tmp);
  });

  it('classifies ignored and unignored paths without a git binary or repository', async () => {
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
  });

  it('handles paths with spaces and unusual names', async () => {
    const backslashName = `back${String.fromCharCode(92)}slash`;
    await fs.writeFile(path.join(tmp, '.gitignore'), `my file.txt\nback${String.fromCharCode(92)}${String.fromCharCode(92)}slash\n`);
    await fs.writeFile(path.join(tmp, 'my file.txt'), 'x');
    await fs.writeFile(path.join(tmp, 'normal.txt'), 'x');
    if (path.sep !== String.fromCharCode(92)) await fs.writeFile(path.join(tmp, backslashName), 'x');

    const candidates = path.sep === String.fromCharCode(92) ? ['my file.txt', 'normal.txt'] : ['my file.txt', backslashName, 'normal.txt'];
    const ignored = await classifyGitIgnored(candidates, tmp);
    expect(ignored.has('my file.txt')).toBe(true);
    if (path.sep !== String.fromCharCode(92)) expect(ignored.has(backslashName)).toBe(true);
    expect(ignored.has('normal.txt')).toBe(false);
  });

  it('reports nothing ignored when no ignore file exists anywhere', async () => {
    await fs.writeFile(path.join(tmp, 'a.txt'), 'x');
    expect((await classifyGitIgnored(['a.txt'], tmp)).size).toBe(0);
  });

  it('applies repository rules when the workspace is below the repository root', async () => {
    const repository = await makeTmp('haze-parent-repo-');
    const workspace = path.join(repository, 'packages', 'app');
    try {
      await fs.ensureDir(path.join(repository, '.git', 'info'));
      await fs.ensureDir(workspace);
      await fs.writeFile(path.join(repository, '.gitignore'), 'packages/app/root-secret.txt\n');
      await fs.writeFile(path.join(repository, '.git', 'info', 'exclude'), 'packages/app/local-secret.txt\n');
      await fs.writeFile(path.join(workspace, 'root-secret.txt'), 'x');
      await fs.writeFile(path.join(workspace, 'local-secret.txt'), 'x');

      const ignored = await classifyGitIgnored(['root-secret.txt', 'local-secret.txt'], workspace);
      expect(ignored).toEqual(new Set(['root-secret.txt', 'local-secret.txt']));
    } finally {
      await fs.remove(repository);
    }
  });

  it('resolves info/exclude through a linked-worktree git pointer', async () => {
    const repository = await makeTmp('haze-worktree-repo-');
    const workspace = path.join(repository, 'worktree');
    const gitDir = path.join(repository, 'metadata', 'worktrees', 'app');
    const commonDir = path.join(repository, 'metadata');
    try {
      await fs.ensureDir(workspace);
      await fs.ensureDir(path.join(commonDir, 'info'));
      await fs.ensureDir(gitDir);
      await fs.writeFile(path.join(workspace, '.git'), `gitdir: ${gitDir}\n`);
      await fs.writeFile(path.join(gitDir, 'commondir'), '../..\n');
      await fs.writeFile(path.join(commonDir, 'info', 'exclude'), 'secret.txt\n');
      await fs.writeFile(path.join(workspace, 'secret.txt'), 'x');

      expect(await classifyGitIgnored(['secret.txt'], workspace)).toEqual(new Set(['secret.txt']));
    } finally {
      await fs.remove(repository);
    }
  });

  it('a deeper .gitignore overrides a shallower one, including negations', async () => {
    await fs.writeFile(path.join(tmp, '.gitignore'), '*.log\nsecret/\n');
    await fs.ensureDir(path.join(tmp, 'nested'));
    await fs.writeFile(path.join(tmp, 'nested', '.gitignore'), '!app.log\n');
    await fs.writeFile(path.join(tmp, 'nested', 'app.log'), 'x');

    // Nested !app.log wins over root *.log; root secret/ stays ignored.
    const ignored = await classifyGitIgnored(['nested/app.log', 'app.log', 'secret/x.txt'], tmp);
    expect(ignored.has('nested/app.log')).toBe(false);
    expect(ignored.has('app.log')).toBe(true);
    expect(ignored.has('secret/x.txt')).toBe(true);
  });

  it('cannot re-include a path below an ignored directory', async () => {
    await fs.writeFile(path.join(tmp, '.gitignore'), 'secret/\n');
    await fs.ensureDir(path.join(tmp, 'secret', 'inner'));
    await fs.writeFile(path.join(tmp, 'secret', 'inner', '.gitignore'), '!x.txt\n');
    await fs.writeFile(path.join(tmp, 'secret', 'inner', 'x.txt'), 'x');

    const ignored = await classifyGitIgnored(['secret/inner/x.txt', 'secret/inner'], tmp);
    expect(ignored.has('secret/inner/x.txt')).toBe(true);
    expect(ignored.has('secret/inner')).toBe(true);
  });

  it('dir-only patterns ignore the directory and its children but not a same-named file', async () => {
    await fs.writeFile(path.join(tmp, '.gitignore'), 'build/\n');
    await fs.ensureDir(path.join(tmp, 'build'));
    await fs.writeFile(path.join(tmp, 'build', 'out.js'), 'x');
    // Same-named FILE in a sibling directory must stay visible.
    await fs.ensureDir(path.join(tmp, 'other'));
    await fs.writeFile(path.join(tmp, 'other', 'build'), 'file named build');

    const ignored = await classifyGitIgnored(['build', 'build/out.js', 'other/build'], tmp);
    expect(ignored.has('build')).toBe(true);
    expect(ignored.has('build/out.js')).toBe(true);
    expect(ignored.has('other/build')).toBe(false);
  });

  it('respects explicit directory hints from walkers (dir-only patterns need no stat)', async () => {
    await fs.writeFile(path.join(tmp, '.gitignore'), 'vendor/\n');
    const ignored = await createIgnoreClassifier(tmp).classify([{path: 'vendor', isDirectory: true}, {path: 'dist', isDirectory: false}]);
    expect(ignored.has('vendor')).toBe(true);
    expect(ignored.has('dist')).toBe(false);
  });

  it('respects .git/info/exclude below in-tree rules', async () => {
    await fs.writeFile(path.join(tmp, '.gitignore'), 'keep-me.txt\n!local-only.txt\n');
    await fs.ensureDir(path.join(tmp, '.git', 'info'));
    await fs.writeFile(path.join(tmp, '.git', 'info', 'exclude'), 'local-only.txt\n');
    await fs.writeFile(path.join(tmp, 'keep-me.txt'), 'x');
    await fs.writeFile(path.join(tmp, 'local-only.txt'), 'x');

    const ignored = await classifyGitIgnored(['keep-me.txt', 'local-only.txt'], tmp);
    // In-tree negation outranks the exclude file; exclude still catches alone.
    expect(ignored.has('local-only.txt')).toBe(false);
    expect(ignored.has('keep-me.txt')).toBe(true);
  });

  it('picks up rule-file edits within one classifier instance (mtime cache)', async () => {
    await fs.writeFile(path.join(tmp, '.gitignore'), 'old.txt\n');
    const classifier = createIgnoreClassifier(tmp);
    expect((await classifier.classify(['old.txt'])).has('old.txt')).toBe(true);

    await fs.writeFile(path.join(tmp, '.gitignore'), 'new.txt\n');
    // mtime changed: the same instance must re-read and apply the new rules.
    const second = await classifier.classify(['old.txt', 'new.txt']);
    expect(second.has('old.txt')).toBe(false);
    expect(second.has('new.txt')).toBe(true);
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
    const nonRepo = await makeTmp('haze-nogit2-');
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

describe('tri-state under unreadable ignore files (F-05)', () => {
  let tmp: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmp = await makeTmp('haze-gitignore-unreadable-');
    originalCwd = process.cwd();
    process.chdir(tmp);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.remove(tmp);
  });

  it('reads still fail open while the tri-state reports unknown', async () => {
    await fs.writeFile(path.join(tmp, '.gitignore'), '*.log\n');
    await fs.chmod(path.join(tmp, '.gitignore'), 0o000);

    // Batch: fail open (nothing reported), tri-state distinguishes.
    await expect(classifyGitIgnored(['a.txt'])).resolves.toEqual(new Set());
    const {checkGitIgnored} = await import('../../src/llm/tools/gitIgnore.js');
    await expect(checkGitIgnored(path.join(tmp, 'a.txt'))).resolves.toBe('unknown');
  });

  it('mutation guards fail closed on unknown status unless allowIgnored is set', async () => {
    await fs.writeFile(path.join(tmp, '.gitignore'), '*.log\n');
    await fs.chmod(path.join(tmp, '.gitignore'), 0o000);
    const {assertNotIgnored} = await import('../../src/llm/tools/fileToolShared.js');
    const target = path.join(tmp, 'mutate.txt');
    await expect(assertNotIgnored(target, 'mutate.txt')).rejects.toMatchObject({reasonCode: 'ignore_check_unavailable'});
    await expect(assertNotIgnored(target, 'mutate.txt', true)).resolves.toBeUndefined();
  });

  it('single-file reads fail open on unknown status (unreadable ignore files never block reads)', async () => {
    await fs.writeFile(path.join(tmp, '.gitignore'), '*.log\n');
    await fs.chmod(path.join(tmp, '.gitignore'), 0o000);
    const {assertNotIgnored} = await import('../../src/llm/tools/fileToolShared.js');
    const target = path.join(tmp, 'read.txt');
    await expect(assertNotIgnored(target, 'read.txt', undefined, {operation: 'read'})).resolves.toBeUndefined();
    // Mutations keep failing closed in the same environment.
    await expect(assertNotIgnored(target, 'read.txt')).rejects.toMatchObject({reasonCode: 'ignore_check_unavailable'});
  });
});
