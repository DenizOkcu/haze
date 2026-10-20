import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {resolveAddDirCommand} from '../../src/cli/commands/addDirCommand.js';

describe('/add-dir resolver', () => {
  let tmp: string;
  let outside: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-adddir-test-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-adddir-outside-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
    await fs.remove(outside);
  });

  it('adds an existing directory by canonical path and reports semantics', async () => {
    const result = await resolveAddDirCommand(outside, {cwd: tmp});
    expect(result.action).toBe('add');
    if (result.action !== 'add') return;
    expect(result.dirs).toEqual([{realPath: await fs.realpath(outside), isDirectory: true}]);
    expect(result.message).toContain('read and edit');
    expect(result.message).toContain('Not written to settings');
  });

  it('status with no args lists current dirs and usage', async () => {
    const empty = await resolveAddDirCommand('', {cwd: tmp});
    expect(empty.action).toBe('status');
    if (empty.action === 'status') {
      expect(empty.message).toContain('No session directories added');
      expect(empty.message).toContain('Usage: /add-dir <directory>');
    }
    const added = await resolveAddDirCommand(outside, {cwd: tmp, current: [{realPath: await fs.realpath(outside), isDirectory: true}]});
    expect(added.action).toBe('status'); // duplicate is an idempotent no-op listing
  });

  it('reset clears the list only when non-empty', async () => {
    const nothing = await resolveAddDirCommand('reset', {cwd: tmp});
    expect(nothing.action).toBe('status');
    const clear = await resolveAddDirCommand('reset', {cwd: tmp, current: [{realPath: await fs.realpath(outside), isDirectory: true}]});
    expect(clear.action).toBe('reset');
    if (clear.action === 'reset') expect(clear.message).toContain('Removed 1 session directory');
  });

  it('refuses missing paths, files, and protected-secret directories', async () => {
    const missing = await resolveAddDirCommand(path.join(tmp, 'nope'), {cwd: tmp});
    expect(missing.action).toBe('error');
    const file = path.join(tmp, 'file.txt');
    await fs.writeFile(file, 'x', 'utf8');
    const notDir = await resolveAddDirCommand(file, {cwd: tmp});
    expect(notDir.action).toBe('error');
    if (notDir.action === 'error') expect(notDir.message).toContain('Not a directory');
    const secret = await resolveAddDirCommand('~/.ssh', {cwd: tmp});
    expect(secret.action).toBe('error');
    if (secret.action === 'error') expect(secret.message).toContain('protected secret');
  });

  it('~ and workspace-relative inputs expand against home and cwd', async () => {
    const result = await resolveAddDirCommand('.', {cwd: outside});
    expect(result.action).toBe('add');
    if (result.action === 'add') expect(result.dirs[0]?.realPath).toBe(await fs.realpath(outside));
  });
});
