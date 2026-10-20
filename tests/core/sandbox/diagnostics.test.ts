import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {classifySandboxDenial} from '../../../src/core/sandbox/diagnostics.js';
import type {SandboxBoundary} from '../../../src/core/sandbox/boundary.js';

const fakeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-sandbox-diag-'));
const workspace = path.join(fakeRoot, 'repo');
const outsideDir = path.join(fakeRoot, 'outside');

const boundary: SandboxBoundary = {
  workspaceRoot: workspace,
  profile: 'workspace',
  roots: [{path: workspace, realPath: workspace, access: 'rw', origin: 'workspace'}],
  masks: [],
  network: 'allow',
  platform: 'darwin',
  homedir: os.homedir(),
};

beforeEach(async () => {
  await fs.mkdir(workspace, {recursive: true});
  await fs.mkdir(outsideDir, {recursive: true});
});

describe('classifySandboxDenial', () => {
  it('no boundary means no classification', async () => {
    expect(await classifySandboxDenial({code: 1, stderr: 'Operation not permitted', boundary: undefined})).toBeUndefined();
  });

  it('empty stderr never classifies', async () => {
    expect(await classifySandboxDenial({code: 1, stderr: '', boundary})).toBeUndefined();
  });

  it('EPERM on an outside path classifies with a path hint', async () => {
    const denial = await classifySandboxDenial({code: 1, stderr: `cat: ${path.join(outsideDir, 'file.txt')}: Operation not permitted`, boundary});
    expect(denial).toBeDefined();
    expect(denial?.pathHint).toBe(path.join(outsideDir, 'file.txt'));
  });

  it('read-only file system classifies as a write denial', async () => {
    const denial = await classifySandboxDenial({code: 1, stderr: `sh: ${path.join(outsideDir, 'x')}: Read-only file system`, boundary});
    expect(denial?.kind).toBe('write');
  });

  it('ENOENT inside the workspace is NOT a sandbox denial', async () => {
    const missing = path.join(workspace, 'genuinely-missing.txt');
    expect(await classifySandboxDenial({code: 1, stderr: `cat: ${missing}: No such file or directory`, boundary})).toBeUndefined();
  });

  it('ENOENT for a host-existing outside path classifies (bwrap absence)', async () => {
    const unmounted = path.join(outsideDir, 'real-file.txt');
    await fs.writeFile(unmounted, 'x', 'utf8');
    const denial = await classifySandboxDenial({code: 1, stderr: `cat: ${unmounted}: No such file or directory`, boundary});
    expect(denial?.kind).toBe('read');
    expect(denial?.pathHint).toBe(unmounted);
  });

  it('ENOENT for a path that does not exist anywhere stays unrelated', async () => {
    expect(await classifySandboxDenial({code: 1, stderr: 'cat: /no/such/dir/anywhere: No such file or directory', boundary})).toBeUndefined();
  });

  it('unrelated failures never classify', async () => {
    expect(await classifySandboxDenial({code: 1, stderr: 'SyntaxError: unexpected token', boundary})).toBeUndefined();
    expect(await classifySandboxDenial({code: 127, stderr: 'command not found: frobnicate', boundary})).toBeUndefined();
  });

  it('message-less EPERM still classifies conservatively', async () => {
    const denial = await classifySandboxDenial({code: 1, stderr: 'OSError: [Errno 1] Operation not permitted', boundary});
    expect(denial?.kind).toBe('unknown');
  });

  it('sandbox-exec diagnostics classify as sandbox errors', async () => {
    const denial = await classifySandboxDenial({code: 71, stderr: 'sandbox-exec: execvp() of /bin/zsh failed: Operation not permitted', boundary});
    expect(denial).toBeDefined();
  });
});
