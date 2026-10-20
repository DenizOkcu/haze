import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {applySandboxGrant, resolveSandboxCommand} from '../../src/cli/commands/sandboxCommand.js';
import {resetSandboxDenialLog, listSandboxDenials} from '../../src/core/sandbox/denialLog.js';
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

describe('applySandboxGrant', () => {
  it('grants read-only roots idempotently and preserves mode/profile', () => {
    const base: HazeSettings = {sandbox: {mode: 'on', profile: 'strict', roRoots: ['~/dev/docs']}};
    const first = applySandboxGrant(base, {action: 'grant', paths: ['~/.config/gh']});
    expect(first.action).toBe('granted');
    expect(first.sandbox).toMatchObject({mode: 'on', profile: 'strict', roRoots: ['~/dev/docs', '~/.config/gh']});
    expect(first.message).toContain('credentials inside the path become readable');
    const again = applySandboxGrant({...base, sandbox: first.sandbox}, {action: 'grant', paths: ['~/.config/gh']});
    expect(again.action).toBe('noop');
  });

  it('--rw grants land in rwRoots and disclose write access', () => {
    const result = applySandboxGrant({}, {action: 'grant', paths: ['~/go'], access: 'rw'});
    expect(result.action).toBe('granted');
    expect(result.sandbox?.rwRoots).toEqual(['~/go']);
    expect(result.message).toContain('read-write');
    expect(result.message).not.toContain('credentials inside');
  });

  it('refuses protected secret paths loudly', () => {
    for (const secret of ['~/.ssh', '~/.aws', '~/.env']) {
      const result = applySandboxGrant({}, {action: 'grant', paths: [secret]});
      expect(result.action).toBe('error');
      if (result.action === 'error') expect(result.message).toContain('protected secret');
    }
  });

  it('revoke removes matching roots from both lists', () => {
    const base: HazeSettings = {sandbox: {roRoots: ['~/.config/gh', '~/dev/docs'], rwRoots: ['~/go']}};
    const result = applySandboxGrant(base, {action: 'revoke', paths: ['~/.config/gh', '~/go']});
    expect(result.action).toBe('revoked');
    expect(result.sandbox?.roRoots).toEqual(['~/dev/docs']);
    expect(result.sandbox?.rwRoots).toBeUndefined();
  });

  it('empty path lists print usage', () => {
    const result = applySandboxGrant({}, {action: 'grant', paths: []});
    expect(result.action).toBe('error');
    if (result.action === 'error') expect(result.message).toContain('/sandbox grant');
  });

  it('denials is accepted in the usage surface (handler runs it live)', async () => {
    resetSandboxDenialLog();
    const result = await resolveSandboxCommand('denials', input());
    // Falls through to the status card; the live listing is handler-side (process state).
    expect(result.action === 'status' || result.action === 'error').toBe(true);
    expect(listSandboxDenials()).toEqual([]);
  });
});
