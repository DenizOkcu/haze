import {classifyBashCommand} from '../../src/core/safety/bashClassifier';

describe('bash classifier', () => {
  describe('destructive commands', () => {
    it('classifies rm as destructive', () => {
      const result = classifyBashCommand('rm -rf /tmp/foo');
      expect(result.riskLevel).toBe('destructive');
      expect(result.traits).toContain('deletes_files');
    });

    it('classifies git reset --hard as destructive', () => {
      const result = classifyBashCommand('git reset --hard origin/main');
      expect(result.riskLevel).toBe('destructive');
      expect(result.traits).toContain('changes_git_state');
    });

    it('classifies git clean as destructive', () => {
      const result = classifyBashCommand('git clean -fdx');
      expect(result.riskLevel).toBe('destructive');
      expect(result.traits).toContain('changes_git_state');
      expect(result.traits).toContain('deletes_files');
    });

    it('classifies git restore . as destructive', () => {
      const result = classifyBashCommand('git restore .');
      expect(result.riskLevel).toBe('destructive');
      expect(result.traits).toContain('deletes_files');
    });

    it('classifies git checkout -- as destructive', () => {
      const result = classifyBashCommand('git checkout -- .');
      expect(result.riskLevel).toBe('destructive');
      expect(result.traits).toContain('deletes_files');
    });
  });

  describe('find -delete and find -exec / xargs', () => {
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

  describe('network / install commands', () => {
    it('classifies npm install as mutating with network trait', () => {
      const result = classifyBashCommand('npm install');
      expect(result.riskLevel).toBe('mutating');
      expect(result.traits).toContain('uses_network');
      expect(result.traits).toContain('installs_dependencies');
      expect(result.traits).toContain('writes_files');
    });

    it('classifies curl as network risk', () => {
      const result = classifyBashCommand('curl https://example.com');
      expect(result.riskLevel).toBe('network');
      expect(result.traits).toContain('uses_network');
    });

    it('classifies pip install as mutating', () => {
      const result = classifyBashCommand('pip install requests');
      expect(result.riskLevel).toBe('mutating');
      expect(result.traits).toContain('installs_dependencies');
    });
  });

  describe('write commands', () => {
    it('classifies echo redirect as mutating', () => {
      const result = classifyBashCommand('echo hi > file.txt');
      expect(result.riskLevel).toBe('mutating');
      expect(result.traits).toContain('writes_files');
    });

    it('classifies git commit as mutating with git-state trait', () => {
      const result = classifyBashCommand('git commit -m "test"');
      expect(result.riskLevel).toBe('mutating');
      expect(result.traits).toContain('writes_files');
      expect(result.traits).toContain('changes_git_state');
    });

    it('classifies chmod as mutating with permissions trait', () => {
      const result = classifyBashCommand('chmod 755 file.sh');
      expect(result.riskLevel).toBe('mutating');
      expect(result.traits).toContain('changes_permissions');
    });
  });

  describe('validation commands', () => {
    it('classifies npm test as read_only with runs_tests trait', () => {
      const result = classifyBashCommand('npm test');
      expect(result.riskLevel).toBe('read_only');
      expect(result.traits).toContain('runs_tests');
    });

    it('classifies tsc as read_only with runs_build trait', () => {
      const result = classifyBashCommand('npx tsc --noEmit');
      expect(result.riskLevel).not.toBe('destructive');
    });
  });

  describe('read-only commands', () => {
    it('classifies inspection commands as read_only', () => {
      for (const cmd of ['git status', 'git diff', 'git log', 'git show', 'git branch', 'rg foo', 'grep foo f', 'find .', 'ls', 'pwd', 'cat f', 'head f', 'tail f', 'node --version', 'npm --version', 'which node']) {
        const result = classifyBashCommand(cmd);
        expect(result.riskLevel).toBe('read_only');
        expect(result.traits).toContain('reads_files');
      }
    });
  });

  describe('unknown fallback', () => {
    it('falls back to unknown for unrecognized commands', () => {
      const result = classifyBashCommand('echo hi');
      expect(result.riskLevel).toBe('unknown');
      expect(result.traits).toEqual([]);
      expect(result.confidence).toBe('low');
    });

    it('leaves eval and command substitution wrappers as unknown (no boundary-prefixed verb)', () => {
      expect(classifyBashCommand('eval "rm -rf /"').riskLevel).toBe('unknown');
      expect(classifyBashCommand('`rm -rf`').riskLevel).toBe('unknown');
      expect(classifyBashCommand('echo $(whoami)').riskLevel).toBe('unknown');
    });
  });
});
