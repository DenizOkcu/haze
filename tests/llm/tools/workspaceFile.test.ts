import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {prepareWorkspaceRead, prepareWorkspaceMutation} from '../../../src/llm/tools/workspaceFile.js';
import type {BlessedPath} from '../../../src/core/attachments/readBlessings.js';

describe('prepareWorkspaceRead bless handling', () => {
  let workspace: string;
  let originalCwd: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-bless-tool-'));
    originalCwd = process.cwd();
    process.chdir(workspace);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.remove(workspace);
  });

  function ctxWith(blessed: BlessedPath[]) {
    return {context: {blessedPaths: blessed}};
  }

  it('rejects a path outside the workspace without blessings', async () => {
    const outside = path.join(os.tmpdir(), 'haze-bless-outside-' + Date.now() + '.txt');
    await fs.writeFile(outside, 'text');
    try {
      await expect(prepareWorkspaceRead(outside, false, ctxWith([]))).rejects.toThrow(/outside the workspace/);
    } finally {
      await fs.remove(outside);
    }
  });

  it('allows reading a blessed file outside the workspace', async () => {
    const outside = path.join(os.tmpdir(), 'haze-bless-file-' + Date.now() + '.txt');
    await fs.writeFile(outside, 'text');
    try {
      const real = await fs.realpath(outside);
      const blessed: BlessedPath[] = [{realPath: real, isDirectory: false}];
      const resolved = await prepareWorkspaceRead(outside, false, ctxWith(blessed));
      expect(resolved).toBe(path.resolve(workspace, outside));
    } finally {
      await fs.remove(outside);
    }
  });

  it('allows reading inside a blessed directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-bless-dir-'));
    const child = path.join(dir, 'notes.txt');
    await fs.writeFile(child, 'text');
    try {
      const real = await fs.realpath(dir);
      const blessed: BlessedPath[] = [{realPath: real, isDirectory: true}];
      const resolved = await prepareWorkspaceRead(child, false, ctxWith(blessed));
      expect(resolved).toBe(path.resolve(workspace, child));
    } finally {
      await fs.remove(dir);
    }
  });

  it('does not bless a sibling outside the blessed directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-bless-dir-'));
    const sibling = path.join(path.dirname(dir), 'haze-bless-sibling-' + Date.now() + '.txt');
    await fs.writeFile(sibling, 'text');
    try {
      const real = await fs.realpath(dir);
      const blessed: BlessedPath[] = [{realPath: real, isDirectory: true}];
      await expect(prepareWorkspaceRead(sibling, false, ctxWith(blessed))).rejects.toThrow(/outside the workspace/);
    } finally {
      await fs.remove(sibling);
      await fs.remove(dir);
    }
  });

  it('mutations never consult the bless set', async () => {
    // Even with a bless entry, editFile/replaceLines must stay workspace-confined.
    const outside = path.join(os.tmpdir(), 'haze-bless-mut-' + Date.now() + '.txt');
    await fs.writeFile(outside, 'text');
    try {
      const real = await fs.realpath(outside);
      const blessed: BlessedPath[] = [{realPath: real, isDirectory: false}];
      await expect(prepareWorkspaceMutation('editFile', outside, false, ctxWith(blessed))).rejects.toThrow(/outside the workspace/);
    } finally {
      await fs.remove(outside);
    }
  });
});
