import {describe, expect, it} from 'vitest';
import {classifyBashCommand} from '../../src/core/safety/bashClassifier.js';

describe('bash classifier', () => {
  it('classifies validation commands as read-only', () => {
    const result = classifyBashCommand('npm run typecheck');
    expect(result.riskLevel).toBe('read_only');
    expect(result.requiresConfirmation).toBe(false);
    expect(result.traits).toContain('runs_build');
  });

  it('blocks destructive commands', () => {
    const result = classifyBashCommand('rm -rf dist');
    expect(result.riskLevel).toBe('destructive');
    expect(result.requiresConfirmation).toBe(true);
  });

  it('requires confirmation for mutating shell commands', () => {
    const result = classifyBashCommand('echo hi > file.txt');
    expect(result.riskLevel).toBe('mutating');
    expect(result.traits).toContain('writes_files');
  });
});
