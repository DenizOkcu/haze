import {describe, expect, it} from 'vitest';
import {classifyBashCommand} from '../../src/core/safety/bashClassifier.js';

describe('bash classifier', () => {
  it('classifies validation commands as read-only', () => {
    const result = classifyBashCommand('npm run typecheck');
    expect(result.riskLevel).toBe('read_only');
    expect(result.traits).toContain('runs_build');
  });

  it('classifies destructive commands without requiring confirmation', () => {
    const result = classifyBashCommand('rm -rf dist');
    expect(result.riskLevel).toBe('destructive');
  });

  it('classifies mutating shell commands without requiring confirmation', () => {
    const result = classifyBashCommand('echo hi > file.txt');
    expect(result.riskLevel).toBe('mutating');
    expect(result.traits).toContain('writes_files');
  });

  it('classifies find -delete as destructive', () => {
    const result = classifyBashCommand('find . -name "*.tmp" -delete');
    expect(result.riskLevel).toBe('destructive');
    expect(result.traits).toContain('deletes_files');
  });

  it('classifies find -exec rm as destructive, not read-only', () => {
    const result = classifyBashCommand('find . -type f -name "*.log" -exec rm {} +');
    expect(result.riskLevel).toBe('destructive');
    expect(result.traits).toContain('deletes_files');
  });

  it('classifies xargs rm as destructive, not read-only', () => {
    const result = classifyBashCommand('find . -type f | xargs rm');
    expect(result.riskLevel).toBe('destructive');
    expect(result.traits).toContain('deletes_files');
  });

  it('classifies find -exec chmod as mutating, not read-only', () => {
    const result = classifyBashCommand('find . -name x -exec chmod 644 {} +');
    expect(result.riskLevel).toBe('mutating');
    expect(result.traits).toContain('changes_permissions');
  });

  it('does not treat plain find as destructive', () => {
    const result = classifyBashCommand('find . -name foo');
    expect(result.riskLevel).toBe('read_only');
  });

  it('does not promise read-only for find -exec with a benign payload', () => {
    const result = classifyBashCommand('find . -name "*.ts" | xargs eslint');
    expect(result.riskLevel).not.toBe('read_only');
  });

  it('classifies find -exec git clean as destructive with git-state trait', () => {
    const result = classifyBashCommand('find . -type d -name node_modules -exec git clean -fdx {} +');
    expect(result.riskLevel).toBe('destructive');
    expect(result.traits).toContain('changes_git_state');
  });

  it('does not flag a -delete token when find is absent', () => {
    // A single-dash -delete elsewhere should not be misread as find -delete.
    const result = classifyBashCommand('mytool -delete --force ./out');
    expect(result.traits).not.toContain('deletes_files');
  });

  describe('gh subcommands', () => {
    it.each([
      ['gh pr view 123', 'read_only'],
      ['gh issue list --json assignees,title', 'read_only'],
      ['gh run view 1234 --log-failed', 'read_only'],
      ['gh repo view owner/repo', 'read_only'],
      ['gh gist list', 'read_only'],
      ['gh api repos/owner/repo/pulls', 'read_only'],
      ['gh pr diff', 'read_only'],
      ['gh pr status', 'read_only'],
      ['gh pr checks', 'read_only'],
      ['gh issue comment 123', 'read_only'],
      ['gh run list', 'read_only'],
      ['gh repo list', 'read_only'],
      ['gh api --method GET repos/owner/repo/issues', 'read_only'],
    ])('classifies %s as read_only', (cmd, expected) => {
      const result = classifyBashCommand(cmd);
      expect(result.riskLevel).toBe(expected);
      expect(result.traits).toContain('reads_files');
    });

    it.each([
      'gh pr merge 123',
      'gh pr create --fill',
      'gh pr edit 123 --title new',
      'gh pr close 123',
      'gh pr reopen 123',
      'gh pr review --approve',
      'gh issue create --title new',
      'gh issue edit 123 --title new',
      'gh issue close 123',
      'gh issue reopen 123',
      'gh run rerun 1234',
      'gh run watch 1234',
      'gh run cancel 1234',
      'gh release create v1.0.0',
      'gh release edit v1.0.0',
      'gh release delete v1.0.0',
      'gh repo create owner/repo',
      'gh repo fork owner/repo',
      'gh repo delete owner/repo --yes',
      'gh gist create file.txt',
      'gh gist edit abc123',
      'gh gist delete abc123',
      'gh api --method PATCH repos/owner/repo/issues/1',
      'gh api --method POST repos/owner/repo/issues',
      'gh api --method PUT repos/owner/repo/pulls/1',
      'gh api --method DELETE repos/owner/repo/issues/1',
      'gh api -X POST repos/owner/repo/issues',
    ])('does not classify %s as read_only', (cmd) => {
      expect(classifyBashCommand(cmd).riskLevel).not.toBe('read_only');
    });
  });
});
