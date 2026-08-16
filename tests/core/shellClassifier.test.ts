import {describe, expect, it} from 'vitest';
import {classifyShellCommand} from '../../src/core/safety/shellClassifier.js';

describe('shell classifier', () => {
  it('classifies validation commands as read-only', () => {
    const result = classifyShellCommand('npm run typecheck');
    expect(result.riskLevel).toBe('read_only');
    expect(result.traits).toContain('runs_build');
  });

  it('recognizes non-JS test runners as validation commands', () => {
    // Regression: the validation recognizer was JS-toolchain-only, so a correct
    // completion gated on validation evidence could never be credited in
    // Python/Go/Rust/make/Maven/.NET/Deno/Bun workspaces.
    for (const command of [
      'pytest -q',
      'python -m pytest tests/',
      'python3 -m unittest discover',
      'go test ./...',
      'cargo test',
      'make check',
      'mvn verify',
      'gradle test',
      'rspec spec/',
      'dotnet test',
      'deno test',
      'bun test',
      'node --test',
      'uv run pytest',
      'poetry run pytest',
      './mvnw verify',
      './gradlew test',
      'bundle exec rspec',
      'phpunit',
      'composer test',
      'mix test',
      'swift test',
      'ctest',
    ]) {
      const result = classifyShellCommand(command);
      expect(result.traits, command).toContain('runs_tests');
      expect(result.riskLevel, command).toBe('read_only');
    }
  });

  it('classifies destructive commands without requiring confirmation', () => {
    const result = classifyShellCommand('rm -rf dist');
    expect(result.riskLevel).toBe('destructive');
  });

  it('classifies mutating shell commands without requiring confirmation', () => {
    const result = classifyShellCommand('echo hi > file.txt');
    expect(result.riskLevel).toBe('mutating');
    expect(result.traits).toContain('writes_files');
  });

  it('classifies find -delete as destructive', () => {
    const result = classifyShellCommand('find . -name "*.tmp" -delete');
    expect(result.riskLevel).toBe('destructive');
    expect(result.traits).toContain('deletes_files');
  });

  it('classifies find -exec rm as destructive, not read-only', () => {
    const result = classifyShellCommand('find . -type f -name "*.log" -exec rm {} +');
    expect(result.riskLevel).toBe('destructive');
    expect(result.traits).toContain('deletes_files');
  });

  it('classifies xargs rm as destructive, not read-only', () => {
    const result = classifyShellCommand('find . -type f | xargs rm');
    expect(result.riskLevel).toBe('destructive');
    expect(result.traits).toContain('deletes_files');
  });

  it('classifies find -exec chmod as mutating, not read-only', () => {
    const result = classifyShellCommand('find . -name x -exec chmod 644 {} +');
    expect(result.riskLevel).toBe('mutating');
    expect(result.traits).toContain('changes_permissions');
  });

  it('does not treat plain find as destructive', () => {
    const result = classifyShellCommand('find . -name foo');
    expect(result.riskLevel).toBe('read_only');
  });

  it('does not promise read-only for find -exec with a benign payload', () => {
    const result = classifyShellCommand('find . -name "*.ts" | xargs eslint');
    expect(result.riskLevel).not.toBe('read_only');
  });

  it('classifies find -exec git clean as destructive with git-state trait', () => {
    const result = classifyShellCommand('find . -type d -name node_modules -exec git clean -fdx {} +');
    expect(result.riskLevel).toBe('destructive');
    expect(result.traits).toContain('changes_git_state');
  });

  it('does not flag a -delete token when find is absent', () => {
    // A single-dash -delete elsewhere should not be misread as find -delete.
    const result = classifyShellCommand('mytool -delete --force ./out');
    expect(result.traits).not.toContain('deletes_files');
  });
});
