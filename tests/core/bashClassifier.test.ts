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
});
