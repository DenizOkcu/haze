import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from '../fsExtra.js';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {hazeTools} from '../../src/llm/hazeTools.js';
import {GIT_LOG_DEFAULT_LIMIT, GIT_DIFF_DEFAULT_LINES} from '../../src/llm/tools/gitTools.js';

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

  async function call<K extends keyof typeof hazeTools>(name: K, input: Record<string, unknown>) {
    const tool = hazeTools[name] as {execute: (input: unknown, context: {abortSignal?: AbortSignal}) => Promise<Record<string, unknown>>};
    process.chdir(tmp);
    try {
      return await tool.execute(input, {});
    } finally {
      process.chdir(originalCwd);
    }
  }

  it('registers the git tools in the built-in catalog', () => {
    for (const name of ['gitStatus', 'gitLog', 'gitDiff', 'gitBranch', 'gitStage', 'gitCommit', 'gitBranchManage', 'gitRebase', 'gitReset']) {
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
