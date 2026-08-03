import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {resolveReadBlessings, isPathBlessed, type BlessedPath} from '../../../src/core/attachments/readBlessings.js';

describe('read blessings', () => {
  let workspace: string;
  let originalCwd: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-bless-test-'));
    originalCwd = process.cwd();
    process.chdir(workspace);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.remove(workspace);
  });

  describe('resolveReadBlessings', () => {
    it('returns no blessings for a prompt without path mentions', async () => {
      await expect(resolveReadBlessings('plain prompt')).resolves.toEqual({blessedPaths: []});
    });

    it('blesses an explicit @mention of an existing non-image file', async () => {
      const abs = path.join(workspace, 'notes.txt');
      await fs.writeFile(abs, 'text');
      const result = await resolveReadBlessings('see @notes.txt please');
      expect(result.blessedPaths).toHaveLength(1);
      expect(result.blessedPaths[0]).toMatchObject({isDirectory: false});
      expect(result.blessedPaths[0]?.realPath).toBe(await fs.realpath(abs));
    });

    it('blesses a bare path with a separator', async () => {
      // The user types a host path without `@`; same trigger as bare-image attachment.
      const abs = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-bless-bare-'));
      try {
        const file = path.join(abs, 'config.json');
        await fs.writeFile(file, '{}');
        const result = await resolveReadBlessings(`look at ${file} please`);
        expect(result.blessedPaths).toHaveLength(1);
        expect(result.blessedPaths[0]?.realPath).toBe(await fs.realpath(file));
      } finally {
        await fs.remove(abs);
      }
    });

    it('blesses a directory and the whole tree underneath', async () => {
      const abs = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-bless-dir-'));
      try {
        const result = await resolveReadBlessings(`read everything under ${abs}`);
        expect(result.blessedPaths).toHaveLength(1);
        expect(result.blessedPaths[0]?.isDirectory).toBe(true);
        expect(result.blessedPaths[0]?.realPath).toBe(await fs.realpath(abs));
      } finally {
        await fs.remove(abs);
      }
    });

    it('skips image-extension paths (owned by the image attachment system)', async () => {
      await fs.writeFile(path.join(workspace, 'shot.png'), Buffer.from('png'));
      const result = await resolveReadBlessings('see @shot.png');
      expect(result.blessedPaths).toEqual([]);
    });

    it('skips mentions that do not resolve to an existing path', async () => {
      const result = await resolveReadBlessings('see @nope.txt and @/absolutely/missing.json');
      expect(result.blessedPaths).toEqual([]);
    });

    it('dedupes the same file mentioned via @ and a bare path', async () => {
      const abs = path.join(workspace, 'doc.md');
      await fs.writeFile(abs, 'doc');
      const result = await resolveReadBlessings(`see @doc.md and ${abs} too`);
      expect(result.blessedPaths).toHaveLength(1);
    });

    it('honours backslash escapes when resolving', async () => {
      const fileName = 'with space.txt';
      await fs.writeFile(path.join(workspace, fileName), 'text');
      const result = await resolveReadBlessings('see @with\\ space.txt now');
      expect(result.blessedPaths).toHaveLength(1);
      expect(result.blessedPaths[0]?.realPath).toBe(await fs.realpath(path.join(workspace, fileName)));
    });
  });

  describe('isPathBlessed', () => {
    it('matches a blessed file exactly', () => {
      const blessed: BlessedPath[] = [{realPath: '/host/foo.txt', isDirectory: false}];
      expect(isPathBlessed('/host/foo.txt', blessed)).toBe(true);
    });

    it('matches a path inside a blessed directory', () => {
      const blessed: BlessedPath[] = [{realPath: '/host/dir', isDirectory: true}];
      expect(isPathBlessed('/host/dir/child.txt', blessed)).toBe(true);
      expect(isPathBlessed('/host/dir/nested/deep.txt', blessed)).toBe(true);
    });

    it('rejects a sibling that merely shares a name prefix', () => {
      // `/host/dir-evil` must not match blessed `/host/dir` — boundary matters.
      const blessed: BlessedPath[] = [{realPath: '/host/dir', isDirectory: true}];
      expect(isPathBlessed('/host/dir-evil/file', blessed)).toBe(false);
    });

    it('rejects children of a blessed file', () => {
      const blessed: BlessedPath[] = [{realPath: '/host/file.txt', isDirectory: false}];
      expect(isPathBlessed('/host/file.txt/child', blessed)).toBe(false);
    });
  });
});
