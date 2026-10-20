import {describe, expect, it} from 'vitest';
import {resolveSandboxCommand} from '../../src/cli/commands/sandboxCommand.js';
import type {HazeSettings} from '../../src/config/settings.js';
import type {SandboxBackendInfo} from '../../src/core/sandbox/detect.js';

const seatbelt: SandboxBackendInfo = {backend: 'seatbelt'};
const none: SandboxBackendInfo = {backend: 'none', reason: 'missing_binary', detail: 'bwrap not found on PATH (install the bubblewrap package)'};

function input(overrides: {settings?: HazeSettings; sessionOverride?: {mode?: 'auto' | 'on' | 'off'; profile?: 'workspace' | 'strict'}; backendInfo?: SandboxBackendInfo} = {}) {
  return {
    settings: overrides.settings ?? {},
    sessionOverride: overrides.sessionOverride,
    backendInfo: overrides.backendInfo ?? seatbelt,
    workspaceRoot: '/w/repo',
    homedir: '/home/u',
    runtime: {
      platform: 'linux' as const,
      homedir: '/home/u',
      tmpdir: '/tmp',
      shellPath: '/bin/bash',
      nodeExecPath: '/usr/bin/node',
      hazeDir: '/home/u/.haze',
      claudeDir: '/home/u/.claude',
    },
  };
}

describe('resolveSandboxCommand', () => {
  it('status shows the active backend, mode source chain, and roots', async () => {
    const result = await resolveSandboxCommand('status', input());
    expect(result.action).toBe('status');
    if (result.action !== 'status') return;
    expect(result.message).toContain('active via seatbelt');
    expect(result.message).toContain('mode: auto (default)');
    expect(result.message).toContain('/w/repo');
    expect(result.message).toContain('~/.haze');
    expect(result.message).toContain('~/.claude');
    expect(result.message).toContain('~/.cache');
  });

  it('mode words produce session overrides; reset clears', async () => {
    expect(await resolveSandboxCommand('off', input())).toMatchObject({action: 'set', override: {mode: 'off'}});
    expect(await resolveSandboxCommand('strict', input())).toMatchObject({action: 'set', override: {profile: 'strict'}});
    expect(await resolveSandboxCommand('reset', input())).toMatchObject({action: 'set', override: {}});
  });

  it('unknown arguments fail with usage', async () => {
    const result = await resolveSandboxCommand('yolo', input());
    expect(result.action).toBe('error');
    if (result.action === 'error') expect(result.message).toContain('Usage: /sandbox');
  });

  it('session overrides and settings show their source', async () => {
    const session = await resolveSandboxCommand('', input({sessionOverride: {mode: 'off'}, settings: {sandbox: {profile: 'strict'}}}));
    if (session.action !== 'status') throw new Error('expected status');
    expect(session.message).toContain('mode: off (session)');
    expect(session.message).toContain('profile: strict (settings)');
  });

  it('unavailable backends show the inactive line and the remedy', async () => {
    const result = await resolveSandboxCommand('', input({backendInfo: none}));
    if (result.action !== 'status') throw new Error('expected status');
    expect(result.message).toContain('inactive');
    expect(result.message).toContain('bubblewrap');
  });
});
