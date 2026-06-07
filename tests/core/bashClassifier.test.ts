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
});
