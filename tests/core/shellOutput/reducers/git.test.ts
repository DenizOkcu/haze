import {describe, expect, it} from 'vitest';
import {reduceGitOutput} from '../../../../src/core/shellOutput/reducers/git.js';

describe('Git output ownership', () => {
  it.each(['pwd && git status --short && ls', 'git status & ls', 'git status\nls', 'cat <<EOF\ngit status\nEOF', 'echo git status', 'node -e "git status"'])('declines ambiguous command %s', command => {
    expect(reduceGitOutput(command, '/workspace\nREADME.md\n', '')).toBeUndefined();
  });
  it('keeps error output and unknown content out of clean-status summaries', () => {
    expect(reduceGitOutput('git status', '', 'fatal: not a git repository')).toBeUndefined();
    expect(reduceGitOutput('git status', 'unexpected output', '')).toBeUndefined();
  });
  it('supports a single Git command with directory flags', () => {
    expect(reduceGitOutput('git -C repo status --short', ' M a.ts\n', '')).toContain('1 changed');
    expect(reduceGitOutput('git status --short', '', '')).toBe('git status: clean');
  });
});
