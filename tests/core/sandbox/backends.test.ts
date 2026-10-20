import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {buildSandboxBoundary, type SandboxBoundary, type SandboxRoot} from '../../../src/core/sandbox/boundary.js';
import {seatbeltInvocation, seatbeltProfile, sbplString} from '../../../src/core/sandbox/seatbelt.js';
import {bubblewrapArgs, bubblewrapInvocation} from '../../../src/core/sandbox/bubblewrap.js';

// A fixed boundary keeps snapshots deterministic: no realpath pass, no host
// filesystem involvement. Canonical == lexical for every root here.
function root(path: string, access: SandboxRoot['access'], origin: SandboxRoot['origin']): SandboxRoot {
  return {path, realPath: path, access, origin};
}

function fixedBoundary(overrides: Partial<SandboxBoundary> = {}): SandboxBoundary {
  return {
    workspaceRoot: '/w/repo',
    profile: 'workspace',
    roots: [
      root('/w/repo', 'rw', 'workspace'),
      root('/tmp', 'rw', 'temp'),
      root('/home/u/.cache', 'rw', 'cache'),
      root('/home/u/.haze', 'ro', 'config'),
      root('/home/u/.claude', 'ro', 'config'),
      root('/usr', 'ro', 'system'),
      root('/shared/blessed', 'ro', 'blessed'),
    ],
    masks: [
      {path: '/home/u/.haze/settings.json', kind: 'file', reason: 'provider API keys'},
      {path: '/home/u/.haze/sessions', kind: 'dir', reason: 'session transcripts'},
    ],
    network: 'allow',
    platform: 'linux',
    homedir: '/home/u',
    ...overrides,
  };
}

describe('seatbelt profile generation', () => {
  it('emits a deny-default profile with allow groups and masks last', () => {
    const profile = seatbeltProfile(fixedBoundary());
    const lines = profile.split('\n');
    expect(lines[0]).toBe('(version 1)');
    expect(lines[1]).toBe('(import "system.sb")');
    expect(lines[2]).toBe('(deny default)');
    const allowIdx = lines.findIndex(line => line.startsWith('(allow file-read*'));
    const writeIdx = lines.findIndex(line => line.startsWith('(allow file-write*'));
    const denyIdx = lines.findIndex(line => line.startsWith('(deny file-read*'));
    expect(allowIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(allowIdx);
    expect(denyIdx).toBeGreaterThan(writeIdx);
    expect(lines[denyIdx]).toContain('(literal "/home/u/.haze/settings.json")');
    expect(lines[denyIdx]).toContain('(subpath "/home/u/.haze/sessions")');
  });

  it('write allows cover only rw roots', () => {
    const profile = seatbeltProfile(fixedBoundary());
    const writeLine = profile.split('\n').find(line => line.startsWith('(allow file-write*'))!;
    expect(writeLine).toContain('"/w/repo"');
    expect(writeLine).toContain('"/tmp"');
    expect(writeLine).not.toContain('"/usr"');
    expect(writeLine).not.toContain('"/home/u/.haze"');
  });

  it('strict profile denies network; workspace allows it', () => {
    expect(seatbeltProfile(fixedBoundary({profile: 'strict', network: 'deny'}))).toContain('(deny network*)');
    expect(seatbeltProfile(fixedBoundary())).toContain('(allow network*)');
  });

  it('escapes scheme string specials', () => {
    expect(sbplString('a"b\\c')).toBe('a\\"b\\\\c');
  });

  it('wraps the target behind -- with the inline profile', () => {
    const wrapped = seatbeltInvocation({command: '/bin/zsh', args: ['-l', '-c', 'true']}, fixedBoundary());
    expect(wrapped.command).toBe('/usr/bin/sandbox-exec');
    expect(wrapped.args[0]).toBe('-p');
    expect(wrapped.args[1]).toContain('(deny default)');
    const separator = wrapped.args.indexOf('--');
    expect(separator).toBe(2);
    expect(wrapped.args.slice(separator + 1)).toEqual(['/bin/zsh', '-l', '-c', 'true']);
  });
});

describe('bubblewrap argv generation', () => {
  it('prologue: user/ipc/uts namespaces, die-with-parent, system mounts, tmpfs home', () => {
    const args = bubblewrapArgs(fixedBoundary(), {uid: 1000, gid: 1000});
    expect(args).toContain('--unshare-user');
    expect(args).toContain('--die-with-parent');
    const tmpfsTargets = args.filter((arg, index) => index > 0 && args[index - 1] === '--tmpfs');
    expect(tmpfsTargets).toContain('/home/u');
    expect(tmpfsTargets).toContain('/dev/shm');
    expect(args).not.toContain('--unshare-net');
    expect(args).not.toContain('--unshare-pid');
  });

  it('maps uid/gid, strict profile unshares the network', () => {
    const ids = {uid: 501, gid: 20};
    expect(bubblewrapArgs(fixedBoundary(), ids).slice(0, 4)).toEqual(['--uid', '501', '--gid', '20']);
    expect(bubblewrapArgs(fixedBoundary({profile: 'strict', network: 'deny'}), ids)).toContain('--unshare-net');
  });

  it('workspace uses --bind; config/blessed/runtime use --ro-bind-try; system roots skip', () => {
    const args = bubblewrapArgs(fixedBoundary(), {uid: 1000, gid: 1000});
    const mounted = new Set<string>();
    for (let i = 0; i + 1 < args.length; i++) {
      if (args[i]!.startsWith('--') && !args[i + 1]!.startsWith('--')) mounted.add(`${args[i]} ${args[i + 1]}`);
    }
    expect(mounted.has('--bind /w/repo')).toBe(true);
    expect(mounted.has('--ro-bind-try /home/u/.haze')).toBe(true);
    expect(mounted.has('--ro-bind-try /shared/blessed')).toBe(true);
    expect(mounted.has('--bind-try /home/u/.cache')).toBe(true);
    expect(mounted.has('--ro-bind /usr')).toBe(true);
    // System roots do not duplicate the fixed prologue.
    expect(args.filter(arg => arg === '/usr').length).toBe(2); // source + target of the fixed bind only
  });

  it('PATH/runtime roots under $HOME re-bind read-only AFTER the home tmpfs (Linux layout)', () => {
    const boundary = fixedBoundary({
      roots: [
        ...fixedBoundary().roots,
        root('/home/u/.cargo', 'ro', 'runtime'),
      ],
    });
    const args = bubblewrapArgs(boundary, {uid: 1000, gid: 1000});
    const homeTmpfs = args.indexOf('/home/u');
    const cargoBind = args.indexOf('/home/u/.cargo');
    const cargoFlag = cargoBind > 0 ? args[cargoBind - 1] : undefined;
    expect(args[homeTmpfs - 1]).toBe('--tmpfs');
    expect(cargoFlag).toBe('--ro-bind-try');
    expect(cargoBind).toBeGreaterThan(homeTmpfs);
  });

  it('masks bind /dev/null over files and tmpfs over dirs AFTER the owning dir bind', () => {
    const wrapped = bubblewrapInvocation({command: '/bin/bash', args: ['-lc', 'true']}, fixedBoundary(), {uid: 1000, gid: 1000});
    const args = wrapped.args;
    expect(wrapped.command).toBe('bwrap');
    const firstHazeIndex = args.indexOf('/home/u/.haze');
    const maskIndex = args.indexOf('/home/u/.haze/settings.json');
    const maskFlag = maskIndex > 0 ? args[maskIndex - 1] : undefined;
    const settingsNullIndex = args.lastIndexOf('/dev/null');
    const dirBindFlag = firstHazeIndex > 0 ? args[firstHazeIndex - 1] : undefined;
    const sessionsIndex = args.indexOf('/home/u/.haze/sessions');
    expect(firstHazeIndex).toBeGreaterThan(-1);
    expect(dirBindFlag).toBe('--ro-bind-try');
    expect(maskFlag).toBe('/dev/null');
    expect(maskIndex).toBeGreaterThan(firstHazeIndex);
    expect(args[settingsNullIndex - 1]).toBe('--ro-bind');
    expect(args[sessionsIndex - 1]).toBe('--tmpfs');
    expect(sessionsIndex).toBeGreaterThan(firstHazeIndex);
    // Target after the final --.
    const separator = args.lastIndexOf('--');
    expect(args.slice(separator + 1)).toEqual(['/bin/bash', '-lc', 'true']);
    expect(args[args.indexOf('--chdir') + 1]).toBe('/w/repo');
  });
});

describe('buildSandboxBoundary → generators integration', () => {
  it('boundary roots flow into both generators with real config-dir masks', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'haze-sandbox-gen-'));
    const hazeDir = path.join(home, '.haze');
    const claudeDir = path.join(home, '.claude');
    await fs.mkdir(hazeDir, {recursive: true});
    await fs.mkdir(claudeDir, {recursive: true});
    const boundary = await buildSandboxBoundary({
      workspaceRoot: path.join(home, 'workspace'),
      runtime: {
        platform: 'linux',
        homedir: home,
        tmpdir: '/tmp',
        shellPath: '/bin/bash',
        nodeExecPath: '/usr/bin/node',
        hazeDir,
        claudeDir,
      },
    });
    const profile = seatbeltProfile(boundary);
    expect(profile).toContain(`(subpath "${hazeDir}")`);
    const denyLine = profile.split('\n').find(line => line.startsWith('(deny file-read*'));
    expect(denyLine).toContain(`(literal "${path.join(await fs.realpath(hazeDir), 'settings.json')}")`);
    const args = bubblewrapArgs(boundary, {uid: 1000, gid: 1000});
    expect(args).toContain(await fs.realpath(hazeDir));
    expect(args).toContain(path.join(await fs.realpath(claudeDir), 'projects'));
  });
});
