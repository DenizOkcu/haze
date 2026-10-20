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

  it('classifies Go-style lowercase errno messages with the failing verb (gh-shaped regression)', async () => {
    // Observed live: gh (Go) prints "open /path: operation not permitted"
    // with a lowercase errno and the verb before the path — the first release
    // matched only capital-O shell shapes and degraded to kind "unknown"
    // with no path, which then offered only /sandbox off as the remedy.
    const stderr = `warning: failed to load config: open /Users/u/.config/gh/config.yml: operation not permitted\nfailed to create root command: failed to read configuration: open /Users/u/.config/gh/config.yml: operation not permitted`;
    const denial = await classifySandboxDenial({code: 1, stderr, boundary});
    expect(denial).toEqual({kind: 'read', pathHint: '/Users/u/.config/gh/config.yml'});
  });

  it('capital-O shell-tool shapes keep working', async () => {
    const denial = await classifySandboxDenial({code: 1, stderr: `cat: ${path.join(outsideDir, 'file.txt')}: Operation not permitted`, boundary});
    expect(denial).toMatchObject({pathHint: path.join(outsideDir, 'file.txt')});
  });

  it('classifies each ecosystem errno shape with kind and path', async () => {
    const cases: Array<[label: string, stderr: string, expected: SandboxDenial]> = [
      ['macOS dlopen marker', "xcrun: error: unable to load libxcrun: tried: '/opt/lib/libxcrun.dylib' (file system sandbox blocked open())", {kind: 'read', pathHint: '/opt/lib/libxcrun.dylib'}],
      ['python Errno', "Traceback…\nPermissionError: [Errno 1] Operation not permitted: '/home/u/.config/tool/cfg.toml'", {kind: 'read', pathHint: '/home/u/.config/tool/cfg.toml'}],
      ['node/libuv', "Error: EPERM: operation not permitted, open '/home/u/.npm/cache'\n    at readFileSync", {kind: 'read', pathHint: '/home/u/.npm/cache'}],
      ['git quoted', "fatal: could not open '/home/u/repo/.git/config.lock': Permission denied", {kind: 'read', pathHint: '/home/u/repo/.git/config.lock'}],
      ['zsh reversed', 'zsh: permission denied: /opt/tool/bin/app', {kind: 'read', pathHint: '/opt/tool/bin/app'}],
      ['java NIO', 'java.nio.file.AccessDeniedException: /home/u/gradle/cache', {kind: 'read', pathHint: '/home/u/gradle/cache'}],
      ['write verb', "touch: cannot touch '/home/u/scratch/new': Permission denied", {kind: 'write', pathHint: '/home/u/scratch/new'}],
    ];
    for (const [label, stderr, expected] of cases) {
      const denial = await classifySandboxDenial({code: 1, stderr, boundary});
      expect(denial, label).toEqual(expected);
    }
  });

  it('execvp failures classify as exec with the binary path', async () => {
    const denial = await classifySandboxDenial({code: 71, stderr: "sandbox-exec: execvp() of '/Users/u/tools/rg' failed: Operation not permitted", boundary});
    expect(denial).toEqual({kind: 'exec', pathHint: '/Users/u/tools/rg'});
  });

  it('network failures classify only when the profile denies the network', async () => {
    const stderr = 'curl: (6) Could not resolve host: example.com';
    const strict: SandboxBoundary = {...boundary, network: 'deny'};
    expect(await classifySandboxDenial({code: 6, stderr, boundary: strict})).toEqual({kind: 'network'});
    // Workspace profile: an unreachable host is never the sandbox's fault.
    expect(await classifySandboxDenial({code: 6, stderr, boundary})).toBeUndefined();
  });

  it('pathless Rust/anyhow errno still yields a kind without a hint', async () => {
    const denial = await classifySandboxDenial({code: 1, stderr: 'Error: Permission denied (os error 13)', boundary});
    expect(denial).toEqual({kind: 'unknown'});
    expect(await classifySandboxDenial({code: 1, stderr: 'Error: Read-only file system (os error 30)', boundary})).toEqual({kind: 'write'});
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
