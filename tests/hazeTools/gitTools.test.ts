import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from '../fsExtra.js';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {hazeTools} from '../../src/llm/hazeTools.js';
import {GIT_LOG_DEFAULT_LIMIT, GIT_DIFF_DEFAULT_LINES, classifyPullFailure} from '../../src/llm/tools/gitTools.js';

// Git tools resolve the repo from process.cwd(); run each call inside a temp
// git repo (or a non-git dir for the refusal cases) and restore cwd after.
describe('git tools', () => {
  let tmp: string;
  let originalCwd: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-git-test-'));
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.remove(tmp);
  });

  function initRepo() {
    execFileSync('git', ['init', '-q'], {cwd: tmp});
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {cwd: tmp});
    execFileSync('git', ['config', 'user.name', 'Test'], {cwd: tmp});
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], {cwd: tmp});
  }

  async function call<K extends keyof typeof hazeTools>(name: K, input: Record<string, unknown>, state?: object) {
    const tool = hazeTools[name] as {execute: (input: unknown, context: {abortSignal?: AbortSignal; context?: object}) => Promise<Record<string, unknown>>};
    process.chdir(tmp);
    try {
      return await tool.execute(input, state ? {context: state} : {});
    } finally {
      process.chdir(originalCwd);
    }
  }

  async function withLocale<T>(locale: string, run: () => Promise<T>): Promise<T> {
    const previous = process.env.LC_ALL;
    process.env.LC_ALL = locale;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previous;
    }
  }

  it('registers the git tools in the built-in catalog', () => {
    for (const name of ['gitStatus', 'gitLog', 'gitDiff', 'gitBranch', 'gitFetch', 'gitPull', 'gitClone', 'gitStage', 'gitCommit', 'gitBranchManage', 'gitRebase', 'gitReset']) {
      expect(hazeTools).toHaveProperty(name);
    }
  });

  it('returns a terminal not_a_repository result outside a git repo', async () => {
    const result = await call('gitStatus', {});
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe('not_a_repository');
    expect(result.recoverable).toBe(false);
  });

  it('gitStatus summarizes branch, staged, unstaged, untracked compactly', async () => {
    initRepo();
    await fs.outputFile(path.join(tmp, 'committed.txt'), 'a');
    execFileSync('git', ['add', '.'], {cwd: tmp});
    execFileSync('git', ['commit', '-qm', 'init'], {cwd: tmp});
    await fs.outputFile(path.join(tmp, 'staged.txt'), 's');
    await fs.outputFile(path.join(tmp, 'modified.txt'), 'm');
    await fs.outputFile(path.join(tmp, 'committed.txt'), 'changed');
    await fs.outputFile(path.join(tmp, 'untracked.txt'), 'u');
    execFileSync('git', ['add', 'staged.txt'], {cwd: tmp});

    const result = await call('gitStatus', {});
    expect(result.ok).toBe(true);
    expect(result.branch).toBeTruthy();
    expect(result.staged).toEqual(['staged.txt']);
    expect(result.unstaged).toEqual(['committed.txt']);
    expect(result.untracked).toEqual(['untracked.txt', 'modified.txt'].sort() as never);
    expect(result.untracked).toContain('untracked.txt');
    expect(result.untracked).toContain('modified.txt');
  });

  it('gitLog returns bounded structured commits with a truncation indicator', async () => {
    initRepo();
    for (let i = 1; i <= 30; i++) {
      await fs.outputFile(path.join(tmp, `f${i}.txt`), `${i}`);
      execFileSync('git', ['add', '.'], {cwd: tmp});
      execFileSync('git', ['commit', '-qm', `commit ${i}`], {cwd: tmp});
    }
    const result = await call('gitLog', {});
    expect(result.ok).toBe(true);
    expect(result.commits.length).toBe(GIT_LOG_DEFAULT_LIMIT);
    expect(result.truncated).toBe(true);
    expect(result.commits[0]).toMatchObject({hash: expect.any(String), subject: 'commit 30', author: 'Test', relativeTime: expect.any(String)});
    const narrow = await call('gitLog', {limit: 3, range: 'HEAD~5..HEAD'});
    expect(narrow.ok).toBe(true);
    expect(narrow.commits.length).toBeLessThanOrEqual(3);
  });

  it('gitDiff returns per-file stats and a bounded patch', async () => {
    initRepo();
    await fs.outputFile(path.join(tmp, 'a.txt'), 'one\n');
    execFileSync('git', ['add', '.'], {cwd: tmp});
    execFileSync('git', ['commit', '-qm', 'init'], {cwd: tmp});
    await fs.outputFile(path.join(tmp, 'a.txt'), 'one\ntwo\n');
    const result = await call('gitDiff', {});
    expect(result.ok).toBe(true);
    expect(result.files).toEqual([{path: 'a.txt', stats: expect.any(String)}]);
    expect(result.patch).toContain('+two');
    expect(result.truncated).toBe(false);
    const limited = await call('gitDiff', {limit: 1});
    expect(limited.truncated).toBe(true);
    expect(limited.hint).toContain('truncated');
    expect(GIT_DIFF_DEFAULT_LINES).toBe(200);
  });

  it('gitBranch lists the current and local branches', async () => {
    initRepo();
    await fs.outputFile(path.join(tmp, 'a.txt'), 'a');
    execFileSync('git', ['add', '.'], {cwd: tmp});
    execFileSync('git', ['commit', '-qm', 'init'], {cwd: tmp});
    execFileSync('git', ['branch', 'feature'], {cwd: tmp});
    const result = await call('gitBranch', {});
    expect(result.ok).toBe(true);
    expect(result.current.length).toBe(1);
    expect(result.local).toContain('feature');
    expect(result.remotes).toBeUndefined();
  });

  it('refuses paths outside the workspace repo and .git internals', async () => {
    initRepo();
    const outside = await call('gitDiff', {path: '../outside.txt'});
    expect(outside.ok).toBe(false);
    expect(outside.reasonCode).toBe('outside_workspace');
    expect(outside.recoverable).toBe(false);
    const internals = await call('gitDiff', {path: '.git/config'});
    expect(internals.ok).toBe(false);
    expect(internals.reasonCode).toBe('git_internals_protected');
  });

  it('gitStage and gitCommit perform real mutations with compact summaries', async () => {
    initRepo();
    await fs.outputFile(path.join(tmp, 'a.txt'), 'a');
    execFileSync('git', ['add', '.'], {cwd: tmp}); execFileSync('git', ['commit', '-qm', 'init'], {cwd: tmp});
    await fs.outputFile(path.join(tmp, 'b.txt'), 'b');
    const stage = await call('gitStage', {paths: ['b.txt']});
    expect(stage.ok).toBe(true);
    const commit = await call('gitCommit', {message: 'add b'});
    expect(commit.ok).toBe(true);
    expect(commit.summary).toContain('add b');
    const log = await call('gitLog', {limit: 1});
    expect(log.commits[0].subject).toBe('add b');
  });

  it('gitBranchManage creates and checks out branches', async () => {
    initRepo();
    await fs.outputFile(path.join(tmp, 'a.txt'), 'a');
    execFileSync('git', ['add', '.'], {cwd: tmp});
    execFileSync('git', ['commit', '-qm', 'init'], {cwd: tmp});
    const create = await call('gitBranchManage', {action: 'create', name: 'topic'});
    expect(create.ok).toBe(true);
    const checkout = await call('gitBranchManage', {action: 'checkout', name: 'topic'});
    expect(checkout.ok).toBe(true);
    const status = await call('gitStatus', {});
    expect(status.branch).toBe('topic');
  });

  it('gitReset honors an explicit mode and target', async () => {
    initRepo();
    await fs.outputFile(path.join(tmp, 'a.txt'), 'a');
    execFileSync('git', ['add', '.'], {cwd: tmp});
    execFileSync('git', ['commit', '-qm', 'init'], {cwd: tmp});
    await fs.outputFile(path.join(tmp, 'a.txt'), 'changed');
    const reset = await call('gitReset', {mode: 'hard', target: 'HEAD'});
    expect(reset.ok).toBe(true);
    expect(await fs.readFile(path.join(tmp, 'a.txt'), 'utf8')).toBe('a');
  });

  it('fetches and fast-forward pulls a configured remote without caching stale status', async () => {
    initRepo();
    await fs.outputFile(path.join(tmp, 'a.txt'), 'initial');
    execFileSync('git', ['add', '.'], {cwd: tmp});
    execFileSync('git', ['commit', '-qm', 'initial'], {cwd: tmp});
    const remote = path.join(tmp, 'remote.git');
    execFileSync('git', ['clone', '-q', '--bare', tmp, remote]);
    const writer = path.join(tmp, 'writer');
    execFileSync('git', ['clone', '-q', remote, writer]);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {cwd: writer});
    execFileSync('git', ['config', 'user.name', 'Test'], {cwd: writer});
    await fs.outputFile(path.join(writer, 'a.txt'), 'updated');
    execFileSync('git', ['add', 'a.txt'], {cwd: writer});
    execFileSync('git', ['commit', '-qm', 'update'], {cwd: writer});
    execFileSync('git', ['push', '-q'], {cwd: writer});
    execFileSync('git', ['remote', 'add', 'origin', remote], {cwd: tmp});
    const branch = execFileSync('git', ['branch', '--show-current'], {cwd: tmp, encoding: 'utf8'}).trim();
    execFileSync('git', ['config', `branch.${branch}.remote`, 'origin'], {cwd: tmp});
    execFileSync('git', ['config', `branch.${branch}.merge`, `refs/heads/${branch}`], {cwd: tmp});
    const state = {};
    expect((await call('gitStatus', {}, state)).behind).toBeUndefined();
    expect((await call('gitFetch', {remote: 'origin'}, state)).ok).toBe(true);
    expect((await call('gitStatus', {}, state)).behind).toBe(1);
    expect((await call('gitPull', {}, state)).ok).toBe(true);
    expect((await call('gitStatus', {}, state)).behind).toBeUndefined();
    expect(await fs.readFile(path.join(tmp, 'a.txt'), 'utf8')).toBe('updated');
    await fs.outputFile(path.join(tmp, 'local.txt'), 'local');
    execFileSync('git', ['add', 'local.txt'], {cwd: tmp});
    execFileSync('git', ['commit', '-qm', 'local'], {cwd: tmp});
    await fs.outputFile(path.join(writer, 'remote.txt'), 'remote');
    execFileSync('git', ['add', 'remote.txt'], {cwd: writer});
    execFileSync('git', ['commit', '-qm', 'remote'], {cwd: writer});
    execFileSync('git', ['push', '-q'], {cwd: writer});
    // Git translates its diagnostics (de_DE: "Vorspulen nicht möglich"); the reported
    // reason must not depend on the user's language.
    const failed = await withLocale('de_DE.UTF-8', () => call('gitPull', {}, state));
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('cannot be fast-forwarded');
    expect(await fs.pathExists(path.join(tmp, 'remote.txt'))).toBe(false);
  });

  it('classifies git pull failures from old and new git diagnostics', () => {
    const fastForward = 'The branch cannot be fast-forwarded.';
    for (const output of [
      'fatal: Not possible to fast-forward, aborting.',
      "hint: Diverging branches can't be fast-forwarded, you need to either:\nhint:\nfatal: Not possible to fast-forward, aborting.",
      'hint: You have divergent branches and need to specify how to reconcile them.\nfatal: Need to specify how to reconcile divergent branches.',
      ' ! [rejected]      main -> main (fetch first)',
    ]) {
      expect(classifyPullFailure(output)).toBe(fastForward);
    }
    for (const output of [
      'Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.',
      'error: could not apply a1b2c3... subject\nhint: Resolve all conflicts manually, mark them as resolved with "git add/rm <conflicted_files>",\nCONFLICT (content): Merge conflict in a.txt',
    ]) {
      expect(classifyPullFailure(output)).toBe('Pull stopped with conflicts.');
    }
    expect(classifyPullFailure('fatal: unable to access \'https://example.invalid/\': Could not resolve host')).toBeUndefined();
    expect(classifyPullFailure('')).toBeUndefined();
  });

  it('clones into the workspace and refuses escaping or credential-bearing destinations', async () => {
    initRepo();
    await fs.outputFile(path.join(tmp, 'source.txt'), 'source');
    execFileSync('git', ['add', 'source.txt'], {cwd: tmp});
    execFileSync('git', ['commit', '-qm', 'initial'], {cwd: tmp});
    const previous = {...process.env};
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = `url.${tmp}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = 'https://example.invalid/source';
    try {
      const result = await call('gitClone', {url: 'https://example.invalid/source', path: 'checkout'});
      expect(result.ok).toBe(true);
      expect(await fs.readFile(path.join(tmp, 'checkout/source.txt'), 'utf8')).toBe('source');
      expect((await call('gitClone', {url: 'https://example.invalid/source', path: 'checkout'})).ok).toBe(false);
      expect((await call('gitClone', {url: 'https://example.invalid/source', path: '../outside'})).ok).toBe(false);
      expect((await call('gitClone', {url: 'https://user:secret@example.invalid/source', path: 'other'})).ok).toBe(false);
      await fs.symlink(os.tmpdir(), path.join(tmp, 'escape'));
      expect((await call('gitClone', {url: 'https://example.invalid/source', path: 'escape/other'})).ok).toBe(false);
    } finally { process.env = previous; }
  });

  it('reports git failures as recoverable structured git_error results', async () => {
    initRepo();
    await fs.outputFile(path.join(tmp, 'a.txt'), 'a');
    execFileSync('git', ['add', '.'], {cwd: tmp});
    execFileSync('git', ['commit', '-qm', 'init'], {cwd: tmp});
    const result = await call('gitCommit', {message: 'nothing staged'});
    expect(result.ok).toBe(false);
    expect(result.reasonCode).toBe('git_error');
    expect(result.recoverable).toBe(true);
    expect(result.suggestedNextStep).toBeTruthy();
  });
});
