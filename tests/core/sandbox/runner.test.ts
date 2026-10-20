import {describe, expect, it} from 'vitest';
import {resolveSandboxMode, resolveSandboxRuntime, wrapInvocation, type SandboxCliOverride} from '../../../src/core/sandbox/runner.js';
import type {SandboxBackendInfo} from '../../../src/core/sandbox/detect.js';

const seatbeltInfo: SandboxBackendInfo = {backend: 'seatbelt'};
const noneInfo: SandboxBackendInfo = {backend: 'none', reason: 'unsupported_platform', detail: 'windows'};

describe('resolveSandboxMode precedence', () => {
  it('defaults to auto + workspace with a backend', () => {
    expect(resolveSandboxMode({backendInfo: seatbeltInfo})).toEqual({active: true, mode: 'auto', profile: 'workspace', backend: 'seatbelt'});
  });

  it('settings mode off disables', () => {
    expect(resolveSandboxMode({settings: {mode: 'off'}, backendInfo: seatbeltInfo}).reason).toBe('mode_off');
  });

  it('session override beats settings; CLI beats session', () => {
    expect(resolveSandboxMode({settings: {mode: 'off'}, sessionOverride: {mode: 'on'}, backendInfo: seatbeltInfo}).active).toBe(true);
    expect(resolveSandboxMode({settings: {mode: 'off'}, sessionOverride: {mode: 'on'}, cliOverride: 'off' as SandboxCliOverride, backendInfo: seatbeltInfo}).reason).toBe('mode_off');
  });

  it('CLI accepts profile words too', () => {
    expect(resolveSandboxMode({cliOverride: 'strict', backendInfo: seatbeltInfo}).profile).toBe('strict');
    expect(resolveSandboxMode({cliOverride: 'workspace', backendInfo: seatbeltInfo}).profile).toBe('workspace');
  });

  it('auto degrades visibly without a backend; on fails closed', () => {
    const auto = resolveSandboxMode({backendInfo: noneInfo});
    expect(auto.active).toBe(false);
    expect(auto.reason).toBe('no_backend');
    const on = resolveSandboxMode({settings: {mode: 'on'}, backendInfo: noneInfo});
    expect(on.active).toBe(false);
    expect(on.reason).toBe('no_backend');
  });
});

describe('wrapInvocation', () => {
  const target = {command: '/bin/zsh', args: ['-l', '-c', 'true']};

  it('undefined state is a passthrough with truthful metadata', () => {
    const wrapped = wrapInvocation(target, undefined);
    expect(wrapped.invocation).toEqual(target);
    expect('unavailable' in wrapped && wrapped.sandbox.enabled).toBe(false);
  });

  it('inactive auto state is a passthrough with the no_backend reason', () => {
    const state = {resolved: {active: false, mode: 'auto' as const, profile: 'workspace' as const, backend: 'none' as const, reason: 'no_backend' as const, detail: 'nope'}};
    const wrapped = wrapInvocation(target, state);
    expect('unavailable' in wrapped).toBe(false);
    expect(wrapped.invocation).toEqual(target);
    expect(wrapped.sandbox.reason).toBe('no_backend');
  });

  it('mode on without a backend refuses to run (fail closed)', () => {
    const state = {resolved: {active: false, mode: 'on' as const, profile: 'workspace' as const, backend: 'none' as const, reason: 'no_backend' as const, detail: 'nope'}, remedy: 'install it'};
    const wrapped = wrapInvocation(target, state);
    expect('unavailable' in wrapped).toBe(true);
    if ('unavailable' in wrapped) {
      expect(wrapped.error).toContain('unavailable');
    }
  });

  it('active seatbelt state wraps with sandbox-exec', async () => {
    const runtime = await resolveSandboxRuntime({
      workspaceRoot: '/w',
      backendInfo: seatbeltInfo,
      runtime: {
        platform: 'darwin', homedir: '/home/u', tmpdir: '/tmp', shellPath: '/bin/zsh',
        nodeExecPath: '/usr/local/bin/node', hazeDir: '/home/u/.haze', claudeDir: '/home/u/.claude',
      },
    });
    const wrapped = wrapInvocation(target, runtime);
    expect('unavailable' in wrapped).toBe(false);
    if (!('unavailable' in wrapped)) {
      expect(wrapped.invocation.command).toBe('/usr/bin/sandbox-exec');
      expect(wrapped.sandbox).toEqual({enabled: true, backend: 'seatbelt', profile: 'workspace'});
    }
  });
});

describe('resolveSandboxRuntime', () => {
  it('builds a boundary only when active', async () => {
    const off = await resolveSandboxRuntime({workspaceRoot: '/w', settings: {mode: 'off'}, backendInfo: seatbeltInfo});
    expect(off.boundary).toBeUndefined();
    const on = await resolveSandboxRuntime({
      workspaceRoot: '/w',
      backendInfo: seatbeltInfo,
      runtime: {
        platform: 'darwin', homedir: '/home/u', tmpdir: '/tmp', shellPath: '/bin/zsh',
        nodeExecPath: '/usr/local/bin/node', hazeDir: '/home/u/.haze', claudeDir: '/home/u/.claude',
      },
    });
    expect(on.boundary?.workspaceRoot).toBe('/w');
    expect(on.boundary?.network).toBe('allow');
  });
});
