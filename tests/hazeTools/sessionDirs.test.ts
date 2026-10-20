import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {hazeTools} from '../../src/llm/hazeTools.js';

/**
 * `/add-dir` session directories at the file-tool layer: reads and mutations
 * inside an explicitly added directory are allowed; without one, workspace
 * confinement is unchanged; symlinks inside a session directory that resolve
 * elsewhere fall back to ordinary confinement (real-path matching).
 */
describe('session dirs (add-dir) file-tool access', () => {
  let tmp: string;
  let originalCwd: string;
  let sessionDir: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-sessiondir-test-'));
    originalCwd = process.cwd();
    await fs.ensureDir(path.join(tmp, '.git'));
    process.chdir(tmp);
    sessionDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'haze-sessiondir-outside-')));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.remove(tmp);
    await fs.remove(sessionDir);
  });

  const sessionContext = () => ({sessionDirs: [{realPath: sessionDir, isDirectory: true}], blessedPaths: [{realPath: sessionDir, isDirectory: true}]});

  it('writeFile and readFile work inside a session dir', async () => {
    const target = path.join(sessionDir, 'note.md');
    const write = await hazeTools.writeFile.execute({path: target, content: 'hello', overwriteExisting: false, append: false}, {abortSignal: undefined, context: sessionContext()});
    expect(write.ok).toBe(true);
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('hello');
    const read = await hazeTools.readFile.execute({path: target, offset: 0, limit: 10}, {abortSignal: undefined, context: sessionContext()});
    expect(String((read as {content?: string}).content ?? '')).toContain('hello');
  });

  it('editFile mutates inside a session dir', async () => {
    const target = path.join(sessionDir, 'edit.txt');
    await fs.writeFile(target, 'alpha\n', 'utf8');
    const result = await hazeTools.editFile.execute({path: target, edits: [{oldText: 'alpha', newText: 'beta'}]}, {abortSignal: undefined, context: sessionContext()});
    expect(result.ok).toBe(true);
    await expect(fs.readFile(target, 'utf8')).resolves.toContain('beta');
  });

  it('without a session dir the same paths stay refused (workspace confinement unchanged)', async () => {
    const target = path.join(sessionDir, 'denied.txt');
    const result = await hazeTools.writeFile.execute({path: target, content: 'x', overwriteExisting: false, append: false}, {abortSignal: undefined});
    expect(result.ok).toBe(false);
  });

  it('a symlink inside a session dir resolving outside falls back to confinement', async () => {
    const victimDir = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-sessiondir-victim-'));
    try {
      await fs.writeFile(path.join(victimDir, 'secret-ish.txt'), 'payload', 'utf8');
      await fs.symlink(victimDir, path.join(sessionDir, 'escape-link'));
      const viaLink = await hazeTools.readFile.execute({path: path.join(sessionDir, 'escape-link', 'secret-ish.txt'), offset: 0, limit: 10}, {abortSignal: undefined, context: sessionContext()});
      expect(viaLink.ok).toBe(false);
    } finally {
      await fs.remove(victimDir);
    }
  });
});
