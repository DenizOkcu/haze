import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {detectMentionAtCursor, fileMentionSuggestions} from '../../../src/cli/chat/fileMentionSuggestions.js';

const execFile = promisify(execFileCallback);

describe('mention primitives (F04 AC1)', () => {
  describe('detectMentionAtCursor', () => {
    it('detects a token at the start of the input', () => {
      expect(detectMentionAtCursor('@src/foo', 8)).toEqual({token: '@src/foo', start: 0, end: 8});
    });

    it('detects a token mid-prompt with cursor inside it', () => {
      // 'see @src/f now' — indices: s=0,e=1,e=2,=3,@=4,s=5,r=6,c=7,/=8,f=9, =10...
      expect(detectMentionAtCursor('see @src/f now', 9)).toEqual({token: '@src/f', start: 4, end: 10});
    });

    it('detects a token with cursor right after the last char', () => {
      expect(detectMentionAtCursor('@foo', 4)).toEqual({token: '@foo', start: 0, end: 4});
    });

    it('returns undefined when cursor is before the @', () => {
      expect(detectMentionAtCursor('see @foo', 2)).toBeUndefined();
    });

    it('returns undefined when there is no @token at all', () => {
      expect(detectMentionAtCursor('plain text only', 5)).toBeUndefined();
    });

    it('matches an empty token (@ just typed) so root listings can show', () => {
      expect(detectMentionAtCursor('@', 1)).toEqual({token: '@', start: 0, end: 1});
    });

    it('does not match @ inside an email (cursor outside the host segment)', () => {
      // `user@host.com` — cursor at 0; no mention because cursor is before @
      expect(detectMentionAtCursor('user@host.com', 0)).toBeUndefined();
    });
  });

  describe('fileMentionSuggestions', () => {
    let workspace: string;
    let originalCwd: string;

    beforeEach(async () => {
      // Resolve through realpath so the workspace matches process.cwd() —
      // on macOS `/var` is a symlink to `/private/var`, and `git check-ignore`
      // needs the relative path to be consistent.
      workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'haze-mention-test-')));
      originalCwd = process.cwd();
      process.chdir(workspace);
      // `isGitIgnored` shells out to `git check-ignore`, which needs a repo.
      await execFile('git', ['init', '-q'], {cwd: workspace});
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await fs.remove(workspace);
    });

    it('lists children of the workspace root for the bare @ token', async () => {
      await fs.writeFile(path.join(workspace, 'alpha.ts'), '');
      await fs.writeFile(path.join(workspace, 'beta.md'), '');
      await fs.ensureDir(path.join(workspace, 'subdir'));
      const suggestions = await fileMentionSuggestions('@', {workspaceRoot: workspace});
      const values = suggestions.map(s => s.value).sort();
      expect(values).toEqual(['@alpha.ts', '@beta.md', '@subdir/']);
      const subdirSuggestion = suggestions.find(s => s.value === '@subdir/');
      expect(subdirSuggestion).toMatchObject({kind: 'file', description: 'directory'});
    });

    it('filters children by the prefix after the last /', async () => {
      await fs.writeFile(path.join(workspace, 'apple.txt'), '');
      await fs.writeFile(path.join(workspace, 'apricot.txt'), '');
      await fs.writeFile(path.join(workspace, 'banana.txt'), '');
      const suggestions = await fileMentionSuggestions('@ap', {workspaceRoot: workspace});
      expect(suggestions.map(s => s.value).sort()).toEqual(['@apple.txt', '@apricot.txt']);
    });

    it('descends into a subdirectory when the token names one', async () => {
      await fs.ensureDir(path.join(workspace, 'src'));
      await fs.writeFile(path.join(workspace, 'src', 'foo.ts'), '');
      await fs.writeFile(path.join(workspace, 'src', 'bar.ts'), '');
      const suggestions = await fileMentionSuggestions('@src/', {workspaceRoot: workspace});
      expect(suggestions.map(s => s.value).sort()).toEqual(['@src/bar.ts', '@src/foo.ts']);
    });

    it('returns no suggestions for a path outside the workspace', async () => {
      const outside = path.join(os.tmpdir(), 'haze-mention-outside-' + Date.now());
      await fs.ensureDir(outside);
      try {
        const suggestions = await fileMentionSuggestions(`@${outside}/`, {workspaceRoot: workspace});
        expect(suggestions).toEqual([]);
      } finally {
        await fs.remove(outside);
      }
    });

    it('returns no suggestions for a parent token that is not a directory', async () => {
      await fs.writeFile(path.join(workspace, 'file.txt'), 'not a dir');
      const suggestions = await fileMentionSuggestions('@file.txt/', {workspaceRoot: workspace});
      expect(suggestions).toEqual([]);
    });

    it('respects .gitignore', async () => {
      await fs.writeFile(path.join(workspace, '.gitignore'), 'ignored*\n');
      await fs.writeFile(path.join(workspace, 'ignored.log'), '');
      await fs.writeFile(path.join(workspace, 'visible.log'), '');
      const suggestions = await fileMentionSuggestions('@', {workspaceRoot: workspace});
      const values = suggestions.map(s => s.value);
      expect(values).toContain('@visible.log');
      expect(values).not.toContain('@ignored.log');
    });
  });
});
