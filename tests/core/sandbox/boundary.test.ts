import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {beforeEach, describe, expect, it} from 'vitest';
import {buildSandboxBoundary, configDirMasks, systemReadRoots, type SandboxRuntimeFacts} from '../../../src/core/sandbox/boundary.js';

function facts(overrides: Partial<SandboxRuntimeFacts> = {}): SandboxRuntimeFacts {
  const home = '/home/tester';
  return {
    platform: 'linux',
    homedir: home,
    tmpdir: '/tmp',
    shellPath: '/bin/bash',
    nodeExecPath: `${home}/.nvm/versions/node/v22.0.0/bin/node`,
    hazeDir: `${home}/.haze`,
    claudeDir: `${home}/.claude`,
    ...overrides,
  };
}

// realpath-based canonicalization would follow the real host filesystem; pin a
// fake tree so tests stay deterministic across machines.
const fakeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-sandbox-boundary-'));
const workspace = path.join(fakeRoot, 'repo');
const sibling = path.join(fakeRoot, 'sibling');
const blessedFile = path.join(fakeRoot, 'shared-data.json');
const homeDir = path.join(fakeRoot, 'home');
const runtime = facts({
  platform: 'linux',
  homedir: homeDir,
  tmpdir: path.join(fakeRoot, 'tmpdir'),
  nodeExecPath: path.join(homeDir, '.nvm', 'versions', 'node', 'v22.0.0', 'bin', 'node'),
  hazeDir: path.join(homeDir, '.haze'),
  claudeDir: path.join(homeDir, '.claude'),
});

beforeEach(async () => {
  await fs.mkdir(workspace, {recursive: true});
  await fs.mkdir(sibling, {recursive: true});
  await fs.mkdir(runtime.tmpdir, {recursive: true});
  await fs.mkdir(path.dirname(runtime.nodeExecPath), {recursive: true});
  await fs.writeFile(blessedFile, 'data', 'utf8');
});

describe('buildSandboxBoundary', () => {
  it('makes the workspace read-write and canonicalizes roots', async () => {
    const boundary = await buildSandboxBoundary({workspaceRoot: path.join(workspace, 'nested', '..'), runtime});
    const workspaceRoot = boundary.roots.find(root => root.origin === 'workspace');
    expect(workspaceRoot?.access).toBe('rw');
    expect(workspaceRoot?.realPath).toBe(await fs.realpath(workspace));
  });

  it('blessed paths are read-only and secret blessings are dropped', async () => {
    const secretPath = path.join(homeDir, '.ssh', 'id_ed25519');
    await fs.mkdir(path.dirname(secretPath), {recursive: true});
    await fs.writeFile(secretPath, 'key', 'utf8');
    const boundary = await buildSandboxBoundary({
      workspaceRoot: workspace,
      blessedPaths: [{realPath: await fs.realpath(sibling), isDirectory: true}, {realPath: await fs.realpath(secretPath), isDirectory: false}],
      runtime,
    });
    const blessed = boundary.roots.filter(root => root.origin === 'blessed');
    expect(blessed.map(root => root.access)).toEqual(['ro']);
    expect(blessed[0]!.realPath).toBe(await fs.realpath(sibling));
  });

  it('rejects protected-secret settings roots at runtime', async () => {
    const envFile = path.join(workspace, '.env');
    await fs.writeFile(envFile, 'SECRET=1', 'utf8');
    const boundary = await buildSandboxBoundary({
      workspaceRoot: workspace,
      settings: {roRoots: [await fs.realpath(envFile)]},
      runtime,
    });
    expect(boundary.roots.some(root => root.path.endsWith('.env') && root.origin === 'settings')).toBe(false);
  });

  it('config dirs are read-only with credential masks; masks use canonical paths', async () => {
    await fs.mkdir(runtime.hazeDir, {recursive: true});
    const boundary = await buildSandboxBoundary({workspaceRoot: workspace, runtime});
    const configRoots = boundary.roots.filter(root => root.origin === 'config');
    expect(configRoots.map(root => root.access)).toEqual(['ro', 'ro']);
    const masked = boundary.masks.map(mask => mask.path);
    const canonicalHazeDir = await fs.realpath(runtime.hazeDir);
    expect(masked).toContain(path.join(canonicalHazeDir, 'settings.json'));
    expect(masked).not.toContain(path.join(canonicalHazeDir, 'AGENTS.md'));
  });

  it('skips masks under a missing config dir', async () => {
    await fs.rm(runtime.claudeDir, {recursive: true, force: true});
    const boundary = await buildSandboxBoundary({workspaceRoot: workspace, runtime});
    expect(boundary.masks.every(mask => !mask.path.includes('/.claude/'))).toBe(true);
  });

  it('an rw root absorbs covered roots; an ro root does not absorb an rw child', async () => {
    const realWorkspace = await fs.realpath(workspace);
    const boundary = await buildSandboxBoundary({
      workspaceRoot: workspace,
      settings: {roRoots: [fakeRoot], rwRoots: [path.join(realWorkspace, 'sub')]},
      runtime,
    });
    const settingsRoots = boundary.roots.filter(root => root.origin === 'settings');
    // The ro fakeRoot survives; the rw sub-root sits under the rw workspace root and is absorbed.
    expect(settingsRoots.map(root => `${root.access}:${root.realPath}`)).toEqual([`ro:${await fs.realpath(fakeRoot)}`]);
    // The rw workspace is not weakened by its ro ancestor from settings.
    const workspaceRoot = boundary.roots.find(root => root.origin === 'workspace');
    expect(workspaceRoot?.access).toBe('rw');
    expect(boundary.roots.some(root => root.realPath === path.join(realWorkspace, 'sub'))).toBe(false);
  });

  it('strict profile denies network and drops cache roots', async () => {
    const strict = await buildSandboxBoundary({workspaceRoot: workspace, settings: {profile: 'strict'}, runtime});
    expect(strict.network).toBe('deny');
    expect(strict.roots.some(root => root.origin === 'cache')).toBe(false);
    const standard = await buildSandboxBoundary({workspaceRoot: workspace, runtime});
    expect(standard.network).toBe('allow');
    expect(standard.roots.some(root => root.origin === 'cache')).toBe(true);
  });

  it('darwin roots include /private/tmp writable and system read set', async () => {
    const darwinRuntime = facts({platform: 'darwin', tmpdir: '/var/folders/ab/c123/T/'});
    const boundary = await buildSandboxBoundary({workspaceRoot: workspace, runtime: darwinRuntime});
    expect(boundary.roots.some(root => root.realPath === '/private/tmp' && root.access === 'rw')).toBe(true);
    expect(boundary.roots.some(root => root.realPath === '/private/var/select' && root.access === 'ro')).toBe(true);
    expect(boundary.roots.some(root => root.realPath.includes('Library/Caches') && root.access === 'rw')).toBe(true);
  });

  it('deterministic ordering by origin then path', async () => {
    const boundary = await buildSandboxBoundary({workspaceRoot: workspace, runtime});
    const origins = boundary.roots.map(root => root.origin);
    const ranking = ['workspace', 'temp', 'cache', 'config', 'runtime', 'system', 'blessed', 'settings'];
    const indices = origins.map(origin => ranking.indexOf(origin));
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });
});

describe('systemReadRoots / configDirMasks', () => {
  it('platform-specific system roots', () => {
    expect(systemReadRoots('darwin')).toContain('/private/var/select');
    expect(systemReadRoots('linux')).toContain('/usr');
    expect(systemReadRoots('win32')).toEqual([]);
  });

  it('mask list covers credentials and transcripts in both config dirs', () => {
    const masks = configDirMasks({hazeDir: '/h/.haze', claudeDir: '/h/.claude'});
    expect(masks.filter(mask => mask.kind === 'file').map(mask => mask.path)).toContain('/h/.claude/.credentials.json');
    expect(masks.filter(mask => mask.kind === 'dir').map(mask => mask.path)).toContain('/h/.haze/sessions');
  });
});
